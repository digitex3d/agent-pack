// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge phase: every line a `#judge` rule applies to is checked by the
 * judge, right after the document is built. A check answered below the
 * threshold is a diagnostic at the line, its severity from the rule's force.
 * The judge never changes the document.
 *
 * The work is done per source file, like a C compiler's object files: a file
 * whose unit (`.agent-pack/units/…`) still matches its text and the rules is
 * not judged again — its diagnostics are the unit's. Otherwise its lines are
 * judged, each verdict taken from the units when its key is known, the judge
 * asked only for the rest; the lock's human decisions win; the unit is rewritten.
 *
 * A run is opened ONCE per command and shared by every agent and adapter of it:
 * a file several agents use is judged once, a line text asked once, the
 * warnings collected and printed once at the end, the units written once.
 */
import { join } from 'path';
import { librariesAliasMap, type Config } from '../config.js';
import type { ApDocument } from '../apdoc/document.js';
import type { ApLine } from '../apdoc/types.js';
import type { SourceRegistry } from '../sources.js';
import { resolveLibraryOutputDir } from '../libraryIndex.js';
import { formatErrors, type LintError } from '../lint.js';
import { loadJudgeRules, severityOf } from './rules.js';
import { JudgeLock, verdictKey } from './lock.js';
import { sha256, UnitStore, type Unit, type UnitDiagnostic } from './units.js';
import { JudgeError, type JudgeCheck, type JudgeConfig, type JudgeRule } from './types.js';

/** One check's verdict on one line text: the one that counts, and the judge's own when known. */
interface CheckVerdict {
  check: JudgeCheck;
  p: number;
  key: string;
  /** The machine verdict — absent when a human decision spared the request. */
  machine?: number;
}

/** A line text a rule could not judge, and why. */
interface NotJudged {
  reason: string;
}

/** What the run made of one source file. */
interface FileJudgement {
  hash: string;
  prior: Unit | null;
  /** The machine verdicts of the file's lines, by key. */
  verdicts: Map<string, number>;
  diagnostics: Map<string, UnitDiagnostic>;
  /** Judged in this run (not taken from its unit as is). */
  rejudged: boolean;
  /** A line of it could not be judged — its unit is not rewritten, so the next run retries. */
  incomplete: boolean;
}

/** The units directory — `units/` next to `compiled/`. */
export function unitsDir(config: Pick<Config, 'outputDir'>): string {
  return join(resolveLibraryOutputDir(config as Config), 'units');
}

export class JudgeRun {
  /** rule + text → its verdicts, or why it was not judged — each asked once. */
  private readonly pending = new Map<string, Promise<CheckVerdict[] | NotJudged>>();
  /** The distinct line texts judged, per primitive. */
  private readonly texts = new Set<string>();
  /** The warnings of the run, once each (an agent compiled for two adapters reports them twice). */
  private readonly found = new Map<string, LintError>();
  /** source file → what the run made of it. */
  readonly files = new Map<string, FileJudgement>();
  /** Every verdict key a line of the run needs — a decision of the lock outside it is no line's. */
  readonly usedKeys = new Set<string>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Why the judge could not be reached — set by the first offline failure; no request follows. */
  offlineReason: string | null = null;
  /**
   * lines: distinct line texts judged; pairs: rule × line text, each from a saved verdict, asked,
   * or not judged — counted on the files judged, not on those taken from their unit.
   */
  readonly stats = { lines: 0, pairs: 0, cached: 0, asked: 0, notJudged: 0 };

  constructor(
    readonly options: JudgeConfig,
    readonly rules: JudgeRule[],
    readonly lock: JudgeLock,
    readonly units: UnitStore,
  ) {}

  /** The warnings collected so far. */
  get warnings(): LintError[] {
    return [...this.found.values()];
  }

  warn(diagnostic: LintError): void {
    this.found.set(`${diagnostic.file}:${diagnostic.line}:${diagnostic.col}:${diagnostic.code}`, diagnostic);
  }

  /** The hash of everything but the source that decides a unit: the rules, the lock, the threshold. */
  rulesHash(): string {
    return sha256(JSON.stringify({
      judge: this.lock.judge,
      model: this.lock.model,
      threshold: this.options.threshold,
      decisions: Object.entries(this.lock.decisions).sort(([a], [b]) => a < b ? -1 : 1),
      rules: this.rules.map(r => ({ id: r.id, checks: r.checks.map(c => ({ id: c.id, statement: c.statement, force: c.force })) })),
    }));
  }

  /** What the run made of a source file — its text hashed once, from the source registry. */
  file(path: string, sources: SourceRegistry): FileJudgement {
    let judged = this.files.get(path);
    if (!judged) {
      judged = {
        hash: sha256(sources.read(path)), prior: this.units.get(path),
        verdicts: new Map(), diagnostics: new Map(), rejudged: false, incomplete: false,
      };
      this.files.set(path, judged);
    }
    return judged;
  }

  /** The verdicts of a rule's checks on one line text: decided, saved, or asked — once per run. */
  verdictsFor(rule: JudgeRule, text: string): Promise<CheckVerdict[] | NotJudged> {
    const id = `${rule.id}\n${text}`;
    let verdicts = this.pending.get(id);
    if (!verdicts) {
      this.stats.pairs++;
      const line = `${rule.primitive}\n${text}`;
      if (!this.texts.has(line)) {
        this.texts.add(line);
        this.stats.lines++;
      }
      verdicts = this.judgeText(rule, text);
      this.pending.set(id, verdicts);
    }
    return verdicts;
  }

  private async judgeText(rule: JudgeRule, text: string): Promise<CheckVerdict[] | NotJudged> {
    const keys = rule.checks.map(c => verdictKey(c, text));
    const known = keys.map(k => ({ decision: this.lock.decision(k)?.p, machine: this.units.verdict(k) }));
    if (known.every(v => v.decision !== undefined || v.machine !== undefined)) {
      this.stats.cached++;
      return rule.checks.map((check, i) => ({ check, p: known[i].decision ?? known[i].machine!, key: keys[i], machine: known[i].machine }));
    }
    const judge = this.options.adapter;
    const offline = (): NotJudged => {
      this.stats.notJudged++;
      return { reason: `${judge.name} is unavailable and no verdict is saved for this line` };
    };
    let answer: Awaited<ReturnType<typeof judge.ask>> | null;
    try {
      answer = await this.limit(() => this.offlineReason ? Promise.resolve(null) : judge.ask(text, rule.checks, this.lock.model ?? undefined));
      for (const check of rule.checks) {
        const p = answer?.answers[check.id];
        if (answer && (typeof p !== 'number' || !(p >= 0 && p <= 1))) throw new JudgeError('line', `${judge.name} gave no probability for ${check.id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as Partial<JudgeError> | null)?.kind === 'line') {
        this.stats.notJudged++;
        return { reason: `${judge.name} failed on this line: ${message}` };
      }
      this.offlineReason ??= message;
      return offline();
    }
    if (!answer) return offline();
    this.stats.asked++;
    this.lock.pin(answer.model);
    return rule.checks.map((check, i) => {
      const machine = answer!.answers[check.id];
      return { check, p: known[i].decision ?? machine, key: keys[i], machine };
    });
  }

  /** Run `ask` with at most `judge.concurrency` requests in flight. */
  private async limit<T>(ask: () => Promise<T>): Promise<T> {
    while (this.active >= this.options.concurrency) await new Promise<void>(go => this.waiting.push(go));
    this.active++;
    try {
      return await ask();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** The run of one command in the project at `projectRoot` — null when the config has no `judge` (the phase is off). */
export function openJudgeRun(config: Config, projectRoot: string): JudgeRun | null {
  if (!config.judge) return null;
  const lock = JudgeLock.load(config.judge.lock, config.judge.adapter.name);
  return new JudgeRun(config.judge, loadJudgeRules(config), lock,
    new UnitStore(unitsDir(config), projectRoot, lock.model, librariesAliasMap(config)));
}

/** A diagnostic at the line — a unit's, without its file. */
function diagnostic(line: ApLine, check: JudgeCheck, severity: 'error' | 'warning', message: string): Omit<UnitDiagnostic, 'data'> {
  return {
    line: line.line ?? 0,
    ...(line.col !== null ? { col: line.col } : {}),
    ...(line.endCol !== null ? { endCol: line.endCol } : {}),
    severity,
    source: 'judge',
    code: check.id,
    message,
  };
}

/** One rule applied to one line of a document. */
interface Judged {
  rule: JudgeRule;
  line: ApLine;
}

/**
 * Judge one document: its errors are returned (they fail the agent), its
 * warnings collected in the run. Its lines are judged file by file; a file whose
 * unit still holds is taken from it.
 */
export async function judgeDocument(doc: ApDocument, run: JudgeRun, sources: SourceRegistry): Promise<LintError[]> {
  const errors: LintError[] = [];
  const report = (d: LintError): void => { if (d.severity === 'error') errors.push(d); else run.warn(d); };
  const byFile = new Map<string | null, Judged[]>();
  for (const rule of run.rules) {
    for (const line of doc.lines(rule.primitive)) {
      if (line.text.trim() === '') continue;
      const judged = byFile.get(line.file) ?? [];
      judged.push({ rule, line });
      byFile.set(line.file, judged);
    }
  }
  const rules = run.rulesHash();
  for (const [file, judged] of byFile) {
    const unit = file ? run.file(file, sources) : null;
    const keys = new Set(judged.flatMap(({ rule, line }) => rule.checks.map(c => verdictKey(c, line.text))));
    for (const key of keys) run.usedKeys.add(key);
    const prior = unit?.prior;
    if (unit && prior && prior.hash === unit.hash && prior.rules === rules && prior.model === run.lock.model
      && [...keys].every(k => k in prior.verdicts || run.lock.decision(k) !== null)) {
      // Unchanged: the unit's diagnostics on these lines, as they are.
      const lines = new Set(judged.map(j => j.line.line ?? 0));
      for (const key of keys) if (key in prior.verdicts) unit.verdicts.set(key, prior.verdicts[key].p);
      for (const d of prior.diagnostics) {
        if (!lines.has(d.line) || !keys.has(d.data.key)) continue;
        unit.diagnostics.set(diagnosticId(d), d);
        report({ file: file!, ...d });
      }
      continue;
    }
    if (unit) unit.rejudged = true;
    const verdicts = new Map(await Promise.all(judged.map(async ({ rule, line }) =>
      [`${rule.id}\n${line.text}`, await run.verdictsFor(rule, line.text)] as const)));
    for (const { rule, line } of judged) {
      const where = file ?? line.block.address;
      const result = verdicts.get(`${rule.id}\n${line.text}`)!;
      if (!Array.isArray(result)) {
        if (unit) unit.incomplete = true;
        const severity = run.options.offline === 'error' ? 'error' : 'warning';
        for (const check of rule.checks) report({ file: where, ...diagnostic(line, check, severity, `not judged yet — ${result.reason}`) });
        continue;
      }
      for (const { check, p, key, machine } of result) {
        if (machine !== undefined) unit?.verdicts.set(key, machine);
        if (p >= run.options.threshold) continue;
        const d: UnitDiagnostic = {
          ...diagnostic(line, check, severityOf(check)!, `${rule.primitive} line breaks the rule "${check.statement}" (p=${p.toFixed(2)})`),
          data: { p, key },
        };
        unit?.diagnostics.set(diagnosticId(d), d);
        report({ file: where, ...d });
      }
    }
  }
  return errors;
}

/** A diagnostic's identity within its unit. */
function diagnosticId(d: UnitDiagnostic): string {
  return `${d.line}:${d.col}:${d.code}:${d.data.key}`;
}

/**
 * The unit of a judged file: this run's verdicts and diagnostics. Unless the run
 * is full (`keepPrior`), its unit's machine verdicts are kept too — a key names no
 * file, and another agent may need them — and its diagnostics when it still holds.
 */
function unitOf(run: JudgeRun, file: string, judged: FileJudgement, rules: string, model: string, keepPrior: boolean): Unit {
  const verdicts = new Map(judged.verdicts);
  const diagnostics = new Map(judged.diagnostics);
  const prior = judged.prior;
  if (keepPrior && prior) {
    for (const [key, v] of Object.entries(prior.verdicts)) if (!verdicts.has(key)) verdicts.set(key, v.p);
    if (prior.hash === judged.hash && prior.rules === rules) {
      for (const d of prior.diagnostics) if (!diagnostics.has(diagnosticId(d))) diagnostics.set(diagnosticId(d), d);
    }
  }
  return {
    version: 1,
    source: run.units.sourceName(file),
    model,
    hash: judged.hash,
    rules,
    verdicts: Object.fromEntries([...verdicts.keys()].sort().map(k => [k, { p: verdicts.get(k)! }])),
    diagnostics: [...diagnostics.values()].sort((a, b) =>
      a.line - b.line || (a.col ?? 0) - (b.col ?? 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.data.key < b.data.key ? -1 : 1)),
  };
}

/**
 * Close the run: print its warnings once, why the judge was unavailable, and
 * one summary line; pin the model in the lock on the first answer; write the
 * units of the files judged (none while no model is pinned) — and, after a
 * clean `bundle all` (`prune`), keep in each only what its lines use now, delete
 * the units of sources no agent uses any more, and name in one line the lock's
 * decisions no line uses (never deleted: a human removes them). A failed write
 * is one line, never a crash.
 */
export function finishJudgeRun(run: JudgeRun, opts: { prune: boolean }): void {
  const warnings = run.warnings;
  if (warnings.length > 0) console.error(formatErrors(warnings));
  if (run.offlineReason) console.error(`[agent-pack] judge ${run.options.adapter.name} unavailable: ${run.offlineReason}`);
  const primitives = [...new Set(run.rules.map(r => r.primitive))].join('/');
  const { lines, pairs, cached, asked, notJudged } = run.stats;
  const files = [...run.files.values()];
  const rejudged = files.filter(f => f.rejudged).length;
  console.error(`judge: ${warnings.length} warnings — ${files.length} files, ${files.length - rejudged} unchanged; ${lines} ${primitives} lines, ${pairs} rule×line checks: ${cached} from saved verdicts, ${asked} asked, ${notJudged} not judged (${run.lock.model ?? 'no model yet'})`);
  try {
    run.lock.save();
  } catch (err) {
    console.error(`[agent-pack] judge: could not save the lock — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opts.prune) {
    const orphans = Object.keys(run.lock.decisions).filter(k => !run.usedKeys.has(k)).sort();
    if (orphans.length > 0) {
      console.error(`[agent-pack] judge: ${orphans.length} decision(s) in the lock match no line any more (rule or line edited or removed) — review them: ${orphans.join(', ')}`);
    }
  }
  try {
    const rules = run.rulesHash();
    const model = run.lock.model;
    for (const [file, judged] of run.files) {
      if (model !== null && judged.rejudged && !judged.incomplete) run.units.write(file, unitOf(run, file, judged, rules, model, !opts.prune));
    }
    if (opts.prune) run.units.prune(run.files.keys());
  } catch (err) {
    console.error(`[agent-pack] judge: could not save the units — ${err instanceof Error ? err.message : String(err)}`);
  }
}
