// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx engine — answers questions about one agent, from its compiled
 * document alone. A harness runs `node <exe> <verb>`; every verb writes lines
 * and returns its exit code, so the engine is testable without a process.
 *
 * The text is the md projection's own (`renderPreamble`/`renderEntry`): the
 * engine only changes the form of a reference, from ` (tpl-…)` to the command
 * that prints that block — ` [node <exe> get tpl-…]`.
 *
 * Exit codes: 0 ok, 1 something does not exist, 2 wrong usage. Every error is
 * one `# error:` line carrying the command that fixes it. `check` answers on its
 * first line, `open` (exit 0) or `closed` (exit 1, or 2 on a usage or config error).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { ApDocument as ApDocumentClass, type ApDocument } from '../apdoc/document.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef, ApNode, ApWhenNode, ApRunNode, ApDirectiveNode } from '../apdoc/types.js';
import { KIND_STRATEGIES, type AgentBlock, type TeamBlock, type StoreBlock, type VarBlock, type DimensionBlock, type TemplateBlock, type ContractBlock } from '../apdoc/blocks.js';
import { mdEnv, renderPreamble, renderEntry, renderMd } from '../../adapters/md/index.js';
import type { MdEnv } from '../../adapters/md/toolkit.js';
import { FORMULAS, fill, type QuizQuestion } from '../formulas.js';
import { DISTILLED_DIR, FLOWS_DIR, flowScriptStem, projectRootOf, projectStoreDir } from './paths.js';
import { type ApxVerb } from './verbs.js';
import { openSessionVars, type SessionVars, type CheckRecord, type ExecutorRecord } from './sessionVars.js';
import { checkedKeyword, roundLine, roundOf, stateOf, type ApCheckSpec } from '../check.js';
import { PROGRAM, WRITE_PROGRAM, executorKey, programDir, programFolders, type ApExecutorSpec } from '../executor.js';
import { resolveJudge } from '../judge/builtins.js';
import type { JudgePlugin } from '../judge/types.js';
import { refName } from '../../adapters/md/phrases.js';
import { scopeLabel } from '../withUse.js';
import { SCOPED_KINDS } from '../services/tags.js';
import { CREDIT } from '../credits.js';
import { validateRecord, formatIssues, jsonExample } from '../shapeSchema.js';
import { BLOCK_ID_RE, addressName, sha256Hex, shortId } from '../apdoc/ids.js';
import { ContractTable, CONTRACT_ID_RE, perimeterFiles, scanZones, zoneMarks, zonesText, parseZones, type ContractRecord } from './contracts.js';
import { parsePayload } from './payload.js';
import { resolveWorkspace } from '../workspace/registry.js';
import type { Allowed, Perimeter, WorkspaceSession } from '../workspace/types.js';
import type { ContractLimit } from '../services/teamMetadata.js';
import { splitList } from '../lists.js';
import { fingerprint } from './dimensions.js';
import { constantOf, readsOf } from '../vars.js';
import { dimensionDefHash, dimensionTemplates } from './dimensions.js';
import { servicesOf, serviceOf } from './services/registry.js';
import { countOf } from './service.js';
import { enumPrimitiveFor, type PerimeterGlobs } from '../primitives.js';
import { globRegExp, matchesAnyGlob } from '../services/glob.js';

/** The exit of an UNTIL*'s answer at its round limit: the loop ends (src/check.ts roundLine). */
const ROUND_LIMIT = 7;

/** What an empty variable is told — the caller says what follows from it. */
const emptyVariable = (name: string): string => `\`${name}\` is empty — nothing is stored in it in this session`;

/** Build provenance sealed next to the document. */
export interface ApxBuild {
  builtAt: string;
  agentPackVersion: string;
  hash: string;
  /** The tabeli engine of the agent-pack that wrote the apx — absent in an apx written before it shipped one. */
  tabeli?: string;
  /** What `check` needs at run time, from the `checks` config key — absent: no judge was configured. */
  checks?: ApxChecks;
}

/**
 * The `checks` config as an apx records it: the judge by name (a built-in one,
 * loaded from the engine itself — judge/builtins.ts), the threshold, and the
 * model the judge lock pins for that judge, when it pins one. A loop's round
 * limit is its own, on its head (`MAX <n>`), kept in its check spec.
 * The judge's key is never recorded: the judge reads it at run time.
 */
export interface ApxChecks {
  adapter: string;
  threshold: number;
  model?: string;
}

/** Kinds in reading order: who you are, your team, then the md chapter order. */
const KIND_ORDER = [...new Set(['agent', 'team', ...KIND_STRATEGIES.map(s => s.kind)])];

/** A dimension write's optional refs — the files its answer also depends on. */


const HELP: [string, string][] = [
  ['start', 'the entry point: who you are and a short quiz — run it once, at the start'],
  ['start 1=<a|b|c> …', 'grade the quiz: the introduction of each kind you missed, then your scope'],
  ['scope', 'everything needed to start: who you are, team, policies, workflows, stores, answer shape'],
  ['ls [kind= tag= name~ about~] [count]', 'every block grouped by kind, with its id — filtered'],
  ['get <id> [json]', 'one block: its text, then what it uses and what uses it'],
  ['get <variable>', 'a variable: its scope, who stores it, who reads it, then its value in this session'],
  ['set <variable> -|<value>', 'store a variable for this session — the value on stdin with -; a typed one as JSON of its template'],
  ['refs <id>', 'only the links of a block: what it uses, what uses it'],
  ['find <text>', 'the blocks containing the text, with the matching lines'],
  ['md', 'the whole prompt at once'],
  ['flow <flw-id>', 'how to run a flow: by the harness, from its compiled script — or its steps, to carry out in order'],
  ['run <exe-id> [in-json] [--into <var>]', 'run a program: its tests when it is new, then the program on its input — its answer back, or kept in <var>'],
  ['check <cnd-id>', 'a checked condition (IF!, IF!!, UNTIL!, UNTIL!!), put to the judge on this session\'s variables: open or closed'],
  ['version', 'agent, build date, agent-pack version, hash, block count'],
];

/** What every contract verb works with: the team, the session's table, who leads. */
interface ContractCx {
  team: TeamBlock;
  table: ContractTable;
  /** The project root — where the copies live. */
  root: string;
  lead: string;
  session: string;
  /** The session's copies, opened on first use. */
  ws: () => WorkspaceSession;
}

/** The workspace engine the copies run on — one ships; a second one is a registry entry and a config key (src/workspace/registry.ts). */
const CONTRACT_WORKSPACE = 'git';

/** The value of `--flag <value>` among args, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args.slice(at + 1).join(' ').trim() || undefined : undefined;
}

/** Whether some of `globs` admits every file `glob` does — by its folders before the first wildcard (`src/actors/**` under `src/**`). */
function coversGlob(globs: string[], glob: string): boolean {
  const prefix = glob.split('/').filter((part, i, all) => !/[*?[{]/.test(part) && all.slice(0, i).every(p => !/[*?[{]/.test(p))).join('/');
  return globs.some(g => globRegExp(g).test(glob) || (prefix !== '' && globRegExp(g).test(`${prefix}/x`)));
}

const FILTER_RE = /^(kind|tag|name|about)(=|~)(.+)$/;

/** A session id as it may name a folder: no separator, never `.` or `..`. */
const SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** A program's manifest (`distilled/<dst-id>/manifest.json`) — written by the agent, `tested` by the apx. */
interface ProgramManifest {
  version: number;
  previous?: string;
  lineage?: string;
  timeout_ms: number;
  /** A hash of the script and its tests the last time all its tests passed. */
  tested?: string;
}

/** One case of a program's `tests.json`: an input and its expected output, or the refusal it must give. */
type ProgramTest = { why: string; input: unknown } & ({ output: unknown } | { exit: number });

/** Two JSON texts or values that mean the same value, key order aside. */
function sameJson(text: string, expected: unknown): boolean {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, canon(x)])) : v;
  try { return JSON.stringify(canon(JSON.parse(text))) === JSON.stringify(canon(expected)); } catch { return false; }
}

/** Why a script failed, from its stderr: the last lines that say something — stack frames, carets and runtime banners left out. */
function stderrCause(stderr: string): string {
  return stderr.split(/\r?\n/)
    .filter(l => l.trim() && !/^\s+at\s/.test(l) && !/^\s*\^+\s*$/.test(l) && !/^Node\.js v\d/.test(l))
    .slice(-3)
    .map(l => l.trim())
    .join(' | ');
}
const ANSWER_RE = /^(\d+)=(.*)$/;

/**
 * When to read on demand, and when not to: a definition this small is printed
 * whole by `start` — no quiz, no `get` — because reading it costs less than
 * the calls that would fetch it; above it, a block is opened with the agent
 * when it is always needed (role, policies, the shapes requests and answers
 * take) or this small, and only the large, conditional ones stay a `get`.
 */
export interface ApxBudget {
  /** Characters of the whole definition under which `start` prints it all. */
  whole: number;
  /** Characters of a block under which it opens with the agent. */
  block: number;
}
export const APX_BUDGET: ApxBudget = { whole: 12000, block: 600 };

export class ApxEngine {
  /** The command prefix every printed command starts with. */
  readonly cmd: string;
  /** The project root this apx lives in. */
  get projectRoot(): string { return resolve(projectRootOf(this.exe)); }
  /** The md environment with references in the apx form. */
  private readonly env: MdEnv;
  readonly root: AgentBlock;
  private readonly byId = new Map<string, ApBlock>();
  /** Every verb, by name — the table APX_VERBS lists. */
  private readonly verbs: Record<ApxVerb, (args: string[]) => number | Promise<number>> = {
    start: args => this.start(args),
    scope: () => this.scope(),
    ls: args => this.ls(args),
    get: args => this.get(args),
    set: args => this.set(args),
    refs: args => this.refs(args),
    find: args => this.find(args),
    md: () => this.print(renderMd(this.doc)),
    flow: args => this.flow(args),
    run: args => this.runProgram(args),
    check: args => this.check(args),
    contract: args => this.contract(args),
    version: () => this.version(),
    help: () => this.help(),
  };

  constructor(
    readonly doc: ApDocument,
    readonly build: ApxBuild,
    /** The path the harness invoked this file by — printed commands reuse it. */
    readonly exe: string,
    private readonly write: (line: string) => void,
    private readonly budget: ApxBudget = APX_BUDGET,
    /** The judge a check asks, by the name the apx records — a built-in one. */
    private readonly judgeNamed: (name: string) => JudgePlugin = name => resolveJudge(name),
  ) {
    this.cmd = `node ${exe}`;
    this.env = mdEnv(doc, id => ` [${this.cmd} get ${id}]`, agent => (!agent || agent === doc.root()?.name ? this.cmd : this.sibling(agent)));
    this.root = doc.root() as AgentBlock;
    for (const block of doc.all()) this.byId.set(block.id, block);
  }

  /** Dispatch one invocation: a verb of the engine, or a served kind and its operation (`<kind> <op> [<id>] …`). No verb = start. `check` answers asynchronously. */
  run(argv: string[]): number | Promise<number> {
    const [verb = 'start', ...args] = argv;
    if (verb === '-h' || verb === '--help') return this.help();
    if (Object.hasOwn(this.verbs, verb)) return this.verbs[verb as ApxVerb](args);
    const service = serviceOf(verb, this.doc);
    if (service) return service.serve(this, args[0], args.slice(1));
    return this.fail(2, `unknown verb '${verb}' — the verbs: ${this.cmd} help`);
  }

  // ------------------------------------------------------------------ verbs

  private start(args: string[]): number {
    this.out(this.headLine(this.root));
    const whole = renderMd(this.doc);
    if (whole.length <= this.budget.whole) {
      this.out(`# your whole definition — small enough to read at once; still served here: ${this.cmd} help`);
      return this.print(whole);
    }
    const quiz = this.quiz();
    if (quiz.length === 0) return this.opening();
    if (args.length === 0) {
      const form = quiz.map((q, i) => `${i + 1}=<${letters(q.options).join('|')}>`).join(' ');
      this.out(`# quiz — answer with: ${this.cmd} start ${form}`);
      this.out(`# '?' = don't know: it costs nothing and gets you that kind's introduction. a guess costs you a wrong prompt.`);
      quiz.forEach((q, i) => {
        this.out(`${i + 1}. [${q.kind}] ${q.ask}`);
        this.out(`   ${q.options.map((o, j) => `${letters(q.options)[j]}) ${o}`).join('   ')}`);
      });
      return 0;
    }
    const given = new Map<number, string>();
    for (const arg of args) {
      const m = ANSWER_RE.exec(arg);
      const n = m ? Number(m[1]) : 0;
      if (!m || n < 1 || n > quiz.length) {
        return this.fail(2, `bad answer '${arg}': expected <n>=<letter> with n in 1..${quiz.length} — the quiz: ${this.cmd} start`);
      }
      given.set(n, m[2].trim().toLowerCase());
    }
    const missed = [...new Set(quiz.filter((q, i) => given.get(i + 1) !== q.right).map(q => q.kind))];
    if (missed.length === 0) {
      this.out(`# all ${quiz.length} correct — your scope:`);
    } else {
      this.out(`# missed: ${missed.join(', ')} — read how each works, then your scope:`);
      const intros = this.doc.mdSource?.intros ?? {};
      for (const kind of missed) this.print(`\n## ${kind}\n\n${intros[kind] ?? ''}\n`);
    }
    return this.opening();
  }

  /** The scope, then the agent's definition with every block it always needs or that costs less than a `get`. */
  private opening(): number {
    this.scope();
    const opened = this.opened();
    this.out(`\n# opened for you — the rest, when a step needs it: ${this.cmd} get <id>`);
    this.print(this.text(this.root));
    for (const block of opened) this.print(`\n${this.text(block)}`);
    return 0;
  }

  /**
   * The blocks that open with the agent: its role, the policies, the templates
   * its requests and answers take (and those they nest), and every block small
   * enough that reading it costs less than the call to fetch it.
   */
  private opened(): ApBlock[] {
    const always = new Set<ApBlock>();
    const add = (b: ApBlock | null | undefined) => {
      if (!b || always.has(b)) return;
      always.add(b);
      if (b.kind === 'template') for (const r of uniqueRefs(b.toJSON())) add(this.doc.resolve(r));
    };
    if (this.root.role) add(this.doc.resolve(this.root.role));
    this.doc.byKind('policy').forEach(add);
    if (this.root.lensIn) add(this.doc.resolve(this.root.lensIn.ref));
    if (this.root.lensOut) add(this.doc.resolve(this.root.lensOut.ref));
    // A variable is runtime state, served by `get <name>` — never opened.
    return this.doc.all().filter(b => b !== this.root && b.kind !== 'var' && (always.has(b) || this.text(b).length <= this.budget.block));
  }

  private scope(): number {
    const root = this.root;
    this.out(this.headLine(root));
    this.out(`you:  ${this.label(root)}  — your definition, complete`);
    if (root.mandate) this.out(`mandate: ${root.mandate}`);
    const perimeter = this.doc.perimeter();
    if (perimeter) {
      this.out(`perimeter: you write only ${perimeter.writes.join(', ') || 'nothing'} — ${perimeter.reads ? `you read only ${perimeter.reads.join(', ')}` : 'read whatever you need'}`);
      const uncertain = { ...perimeter.judged?.reads.uncertain, ...perimeter.judged?.writes.uncertain };
      if (Object.keys(uncertain).length) this.out(`uncertain: a judge could not tell whether these belong — decide each in context: ${Object.entries(uncertain).map(([f, p]) => `${f} (p=${p.toFixed(2)})`).join(', ')}`);
    }
    const role = root.role ? this.doc.resolve(root.role) : null;
    if (role) this.out(`role: ${this.label(role)}`);
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    if (team) {
      this.out(`team: ${this.label(team)}${team.about ? `  — ${team.about}` : ''}`);
      for (const r of team.routing ?? []) this.out(`  WHEN ${r.when}  -> ${this.refLabel(r.run)}`);
    }
    const policies = this.doc.byKind('policy');
    if (policies.length > 0) {
      this.out('respect:');
      for (const p of policies) this.out(`  ${this.label(p)}${p.about ? `  — ${p.about}` : ''}`);
    }
    // Every WHEN and hook of the agent and of its role: what it does, and when.
    const own = [root, ...(role ? [role] : [])].flatMap(b => b.toJSON().body as ApNode[]);
    const whens = own.filter((n): n is ApWhenNode => n.type === 'when');
    if (whens.length > 0) {
      this.out(`when:  — the steps: ${this.cmd} get ${root.id}`);
      for (const w of whens) {
        const runs = w.body.filter((c): c is ApRunNode => c.type === 'run').map(c => this.refLabel(c.ref));
        this.out(`  WHEN ${w.condition}${runs.length ? `  -> ${runs.join(', ')}` : ''}${w.shape ? `  — as ${this.refLabel(w.shape.ref)}` : ''}`);
      }
    }
    const memories = own.filter((n): n is ApDirectiveNode => n.type === 'directive' && n.keyword === 'MEM' && (n.force ?? 0) >= 0);
    if (memories.length > 0) {
      this.out('remember:');
      for (const m of memories) this.out(`  ${m.text}${m.shape ? `  — as ${this.refLabel(m.shape.ref)}` : ''}`);
    }
    this.out('write to:');
    const stores = this.doc.byKind('store');
    if (stores.length === 0) this.out('  (no stores declared)');
    for (const s of stores) this.out(`  ${this.label(s)}  — use: ${this.cmd} store <op> ${s.id} …`);
    const dimensions = this.doc.byKind('dimension') as DimensionBlock[];
    if (dimensions.length > 0) {
      this.out(`dimensions:  — answers about the code, kept by the apx; read one before reasoning about a file it covers: ${this.cmd} dimension read <dim-id> <file>`);
      for (const d of dimensions) this.out(`  ${this.label(d)}  — files: ${d.globs.join(', ')}`);
    }
    const variables = this.doc.byKind('var');
    if (variables.length > 0) {
      this.out(`variables:  — read: ${this.cmd} get <name>, store: ${this.cmd} set <name> -`);
      for (const v of variables) this.out(`  ${v.name}  — ${v.about}`);
    }
    const checks = Object.entries(this.doc.meta.checks ?? {});
    if (checks.length > 0) {
      this.out(`checks:  — a judge decides each: ${this.cmd} check <id>`);
      for (const [id, c] of checks) this.out(`  ${id}  ${checkedKeyword(c.kind, c.level)}${c.level === 2 ? '  (sealed)' : `  — the question: ${this.cmd} get ${id}`}`);
    }
    const executors = Object.entries(this.doc.meta.executors ?? {});
    if (executors.length > 0) {
      this.out(`executors:  — a delegate or a program carries each out; its contract: ${this.cmd} get <id>`);
      for (const [id, e] of executors) {
        const state = e.program ? (this.programFiles(e.program) ? '  (program ready)' : '  (no program yet)') : '';
        this.out(`  ${id}  ${FORMULAS.keywords.EXECUTOR.who[executorKey(e.executor)]}${e.by ? ` \`${e.by}\`` : ''}  ${e.site}: ${e.text}${state}`);
      }
    }
    if (root.lensIn) this.out(`requests arrive as: ${this.refLabel(root.lensIn.ref)}`);
    if (root.lensOut) this.out(`answer as: ${this.refLabel(root.lensOut.ref)}  — your own rules apply in addition to the shape`);
    const counts = this.groups(this.doc.all()).map(([kind, blocks]) => `${blocks.length} ${kind}`);
    this.out(`contains: ${counts.join(', ')}  — list them: ${this.cmd} ls`);
    return 0;
  }

  private ls(args: string[]): number {
    const terms: { key: string; op: string; val: string }[] = [];
    let count = false;
    for (const arg of args) {
      if (arg === 'count') { count = true; continue; }
      const m = FILTER_RE.exec(arg);
      if (!m) return this.fail(2, `bad filter '${arg}' — filters look like: ${this.cmd} ls kind=template tag=planning name~idea about~plan`);
      terms.push({ key: m[1], op: m[2], val: m[3] });
    }
    const hits = this.doc.all().filter(b => terms.every(t => matches(b, t.key, t.op, t.val)));
    for (const [kind, blocks] of this.groups(hits)) {
      this.out(`${kind} (${blocks.length})`);
      if (!count) for (const b of blocks) this.out(`  ${this.lsLine(b)}`);
    }
    this.out(`# ${countOf(hits.length, 'block', 'blocks')}${hits.length === 0 && terms.length > 0 ? ' match' : ''}`);
    return 0;
  }

  private get(args: string[]): number {
    if (args[0] && !BLOCK_ID_RE.test(args[0])) return this.getVariable(args[0]);
    const check = args[0] ? this.doc.meta.checks?.[args[0]] : undefined;
    if (check) return this.getCheck(args[0], check);
    const executor = args[0] ? this.doc.meta.executors?.[args[0]] : undefined;
    if (executor) return this.getExecutor(args[0], executor);
    const block = this.blockArg('get', args);
    if (!block) return this.lastCode;
    if (args[1] === 'json') return this.print(JSON.stringify(block.toJSON(), null, 1));
    this.print(this.text(block));
    const tags = block.tags.length > 0 ? `  ${block.tags.map(t => `#${t}`).join(' ')}` : '';
    this.out(`# ${block.kind} ${block.name}  ${block.id}  ${block.chars}ch${tags}`);
    this.links(block);
    return 0;
  }

  private refs(args: string[]): number {
    const block = this.blockArg('refs', args);
    if (!block) return this.lastCode;
    this.links(block);
    return 0;
  }

  private find(args: string[]): number {
    if (args.length === 0) return this.fail(2, `find needs text — example: ${this.cmd} find plan`);
    const needle = args.join(' ').toLowerCase();
    let n = 0;
    for (const block of this.doc.all()) {
      const lines = this.text(block).split('\n').filter(l => l.toLowerCase().includes(needle));
      if (lines.length === 0) continue;
      n++;
      this.out(this.lsLine(block));
      for (const line of lines) this.out(`  > ${line.trim()}`);
    }
    this.out(`# ${countOf(n, 'block', 'blocks')}${n === 0 ? ' match' : ''}`);
    return 0;
  }

  /**
   * `flow <flw-id>` — how this harness runs a flow: from the script the adapter
   * compiled for it, when there is one for this very version of the flow;
   * otherwise its steps, to carry out in order.
   */
  private flow(args: string[]): number {
    const block = this.blockArg('flow', args);
    if (!block) return this.lastCode;
    if (block.kind !== 'flow') return this.fail(2, `${block.id} is a ${block.kind}, not a flow — the flows: ${this.cmd} ls kind=flow`);
    const script = this.flowScript(block);
    const run = this.doc.meta.flowRun;
    if (script && run) return this.print(fill(run, { script, steps: `${this.cmd} get ${block.id}` }));
    this.out(`# flow ${block.name} — carry out its steps in order:`);
    return this.print(this.text(block));
  }

  /** A contract of this agent by id, or null after telling where its contracts are. */
  executorArg(verb: string, id: string | undefined): ApExecutorSpec | null {
    const spec = id ? this.doc.meta.executors?.[id] : undefined;
    if (!spec) this.lastCode = this.fail(2, `${verb} needs a contract id of this agent (exe-…) — the line that asks for it names it; all of them: ${this.cmd} scope`);
    return spec ?? null;
  }

  /**
   * What a contract receives: one key per variable it reads — its value as this
   * session stores it, parsed when it is JSON — and per constant, with its
   * value. An empty variable fails: the piece cannot be carried out yet.
   */
  inputJson(spec: ApExecutorSpec, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
    const input: Record<string, unknown> = {};
    const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };
    for (const [name, value] of Object.entries(spec.input.constants)) input[name] = parsed(value);
    if (spec.input.vars.length > 0) {
      const vars = this.sessionVars();
      if (!vars) return null;
      const read = this.readVariables(vars, spec.input.vars);
      if ('empty' in read) {
        this.lastCode = this.fail(1, `${emptyVariable(read.empty)}: fill it before this piece is carried out`);
        return null;
      }
      for (const { name, value } of read.values) input[name] = parsed(value);
    }
    return { ...input, ...extra };
  }

  /**
   * A procedure's contract with the variable its call site fills (`RUN p INTO x`,
   * `--into x`): the result is stored in it, as an INTO line's. The arguments
   * without the option; null after telling what is wrong.
   */
  intoArg(spec: ApExecutorSpec, id: string, args: string[]): { spec: ApExecutorSpec; args: string[] } | null {
    const at = args.indexOf('--into');
    if (at < 0) return { spec, args };
    const name = args[at + 1];
    const rest = [...args.slice(0, at), ...args.slice(at + 2)];
    if (spec.site !== 'procedure') { this.lastCode = this.fail(2, `--into stores a procedure's result — ${id} is a ${spec.site}${spec.output.into ? `, stored in \`${spec.output.into}\` already` : ''}`); return null; }
    if (!name || !this.variable(name)) { this.lastCode = this.fail(2, `--into needs a variable of this agent${name ? ` — \`${name}\` is none` : ''}: ${this.cmd} scope`); return null; }
    return { spec: { ...spec, output: { ...spec.output, into: name } }, args: rest };
  }

  /** The template a contract's answer is shaped as: its INTO variable's type, or its procedure's AS — null when none. */
  answerShape(spec: ApExecutorSpec): ApRef | null {
    if (spec.output.into) return this.variable(spec.output.into)?.type ?? null;
    const template = spec.output.template ? this.doc.byKind('template').find(b => b.name === spec.output.template) : undefined;
    return template ? ({ id: template.id, target: template.address, kind: 'template' } as ApRef) : null;
  }

  /**
   * A contract's answer: checked against its output — `{"holds": …}` for a
   * condition, its INTO variable's template (then stored in it), its procedure's
   * AS template — and recorded in the session. Null when it breaks the contract.
   */
  deliver(id: string, spec: ApExecutorSpec, text: string, outcome: ExecutorRecord['outcome'], fingerprint: string): string | null {
    // Only a condition or a shaped answer is JSON; any other answer is text — stored as is, or only recorded.
    const shape = this.answerShape(spec);
    let value: unknown;
    if (spec.output.holds || shape) {
      try { value = JSON.parse(text); } catch { return 'the answer is not JSON'; }
    }
    if (spec.output.holds) {
      if (typeof value !== 'object' || value === null || typeof (value as { holds?: unknown }).holds !== 'boolean') return 'a condition answers {"holds": true | false}';
    } else if (spec.output.into) {
      const block = this.variable(spec.output.into);
      if (!block) return `no variable \`${spec.output.into}\` in this agent`;
      const failed = this.storeVariable(block, text.trim());
      if (failed) return failed.reason;
    } else if (shape) {
      const issues = this.contractIssues(text, shape);
      if (issues) return `not shaped as \`${refName(shape)}\`: ${issues}`;
    }
    this.recordExecution(id, spec, fingerprint, outcome, spec.output.holds ? (value as { holds: boolean }).holds : undefined);
    return null;
  }

  /** One delegation or program run, in the session's record — who carried it out, on what input, how it ended. */
  private recordExecution(id: string, spec: ApExecutorSpec, fingerprint: string, outcome: ExecutorRecord['outcome'], holds?: boolean): void {
    const session = this.openSession();
    if (typeof session === 'string') return;
    const who = spec.executor === PROGRAM ? 'program' : spec.by ?? this.doc.meta.delegate ?? 'delegate';
    session.executed({ exe: id, executor: spec.executor, who, fingerprint, outcome, ...(holds === undefined ? {} : { holds }), at: new Date().toISOString() });
  }

  /**
   * What a contract tells the agent once its answer is in: the condition's
   * outcome — and, for an UNTIL's, the round its loop is at, or the limit —
   * or where the answer went.
   */
  delivered(id: string, spec: ApExecutorSpec, text: string): number {
    if (spec.output.into) {
      this.out(`# stored as \`${spec.output.into}\` for this session — read it: ${this.cmd} get ${spec.output.into}`);
      return 0;
    }
    const code = this.print(text.trim());
    const session = spec.rounds ? this.openSession() : null;
    if (!session || typeof session === 'string') return code;
    const answers = session.answers(id);
    if (answers.at(-1) !== false) return code;
    const round = roundOf(answers, spec.rounds);
    this.out(`# ${roundLine(round, spec.rounds!, FORMULAS.keywords.EXECUTOR.loop)}`);
    // At the limit the loop ends: an exit of its own, so no command chained after it runs another round.
    return round >= spec.rounds! ? ROUND_LIMIT : code;
  }

  /** A program's files: its folder, its manifest and its script — or null while it has none. */
  private programFiles(program: string): { dir: string; manifest: ProgramManifest; script: string } | null {
    const dir = resolve(projectRootOf(this.exe), programDir(program));
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    const script = readdirSync(dir).find(f => /^script(\.|$)/.test(f));
    if (!script) return null;
    let manifest: ProgramManifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { return null; }
    return { dir, manifest, script: join(dir, script) };
  }

  /** The program folder a new version starts from: the one whose manifest names the same lineage — or null. */
  private previousProgram(spec: ApExecutorSpec): string | null {
    if (!spec.lineage) return null;
    const project = resolve(projectRootOf(this.exe));
    for (const folder of programFolders(project)) {
      if (folder === spec.program) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(project, programDir(folder), 'manifest.json'), 'utf-8')) as ProgramManifest;
        if (manifest.lineage === spec.lineage) return folder;
      } catch { /* not a program folder */ }
    }
    return null;
  }

  /** Run a program on one input: its stdout, or why it gave none — refused (exit ≠ 0), timed out, or could not start. */
  private execute(script: string, input: string, timeout: number): { out: string } | { refused: string } | { timeout: true } | { error: string } {
    // Its own process group, so a timeout stops whatever the program started too.
    const run = spawnSync(script, [], { input, encoding: 'utf-8', timeout, detached: true } as SpawnSyncOptionsWithStringEncoding);
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') {
      try { process.kill(-run.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      return { timeout: true };
    }
    if (run.error) return { error: `${script} could not start (${code}) — make it executable (chmod +x) with a #! line` };
    if (run.status !== 0) return { refused: `exit ${run.status}${stderrCause(run.stderr ?? '') ? `: ${stderrCause(run.stderr ?? '')}` : ''}` };
    return { out: run.stdout };
  }

  /**
   * `run <exe-id> [in-json]` — a program carries the piece out. With no program
   * yet, the agent is told to write it (and where the version before it is).
   * A new or changed program runs its own tests first. Then it runs on its
   * input: a refusal (exit ≠ 0) stops the procedure — the agent never carries
   * the piece out itself; a timeout hands this one run to the agent.
   */
  private runProgram(argv: string[]): number {
    const id = argv[0];
    const found = this.executorArg('run', id);
    const into = found && this.intoArg(found, id, argv);
    if (!into) return this.lastCode;
    const { spec } = into;
    const inArg = into.args[1];
    const again = `${this.cmd} run ${id}${spec.output.into && spec.site === 'procedure' ? ` --into ${spec.output.into}` : ''}`;
    if (spec.executor !== 2 || !spec.program) return this.fail(1, `a delegate carries out ${id}, not a program: hand it over with \`${this.cmd} input ${id}\`, then \`${this.cmd} answer ${id} -\``);
    const files = this.programFiles(spec.program);
    if (!files) {
      const previous = this.previousProgram(spec);
      const writer = this.doc.byKind('procedure').find(b => b.name === WRITE_PROGRAM);
      return this.fail(10, [
        `no program yet for ${id} — write it now, in ${programDir(spec.program)}/ at the project root (beside .agent-pack/): manifest.json, the script, tests.json`,
        writer ? `how: ${this.cmd} get ${writer.id}` : `its contract: ${this.cmd} get ${id}`,
        `manifest.json: {"version": 1, "timeout_ms": <n>${spec.lineage ? `, "lineage": "${spec.lineage}"` : ''}} — the script: script.<ext>, executable, JSON in on stdin, JSON out on stdout, exit 1 with the reason on stderr to refuse`,
        `tests.json: [{"why": "…", "input": {…}, "output": <the JSON it must answer>}, {"why": "…", "input": {…}, "exit": 1}] — a "why" starting with CHOICE: for each decision the block left open`,
        ...(previous ? [`its previous version is ${programDir(previous)}/ — start from it: version + 1, "previous": "${previous}", then delete that folder`] : []),
        `then run it again: ${again}`,
      ].join('\n'));
    }
    const { dir, manifest, script } = files;
    if (!(manifest.timeout_ms > 0)) return this.fail(6, `${programDir(spec.program)}/manifest.json sets no timeout_ms — set one`);
    // A new or changed program proves itself on its own tests first.
    const testsPath = join(dir, 'tests.json');
    const proof = sha256Hex(readFileSync(script, 'utf-8') + (existsSync(testsPath) ? readFileSync(testsPath, 'utf-8') : ''));
    if (manifest.tested !== proof) {
      let tests: ProgramTest[];
      try { tests = JSON.parse(readFileSync(testsPath, 'utf-8')); } catch { return this.fail(6, `${programDir(spec.program)}/tests.json is missing or not JSON — a program comes with its tests`); }
      if (!Array.isArray(tests) || tests.length === 0) return this.fail(6, `${programDir(spec.program)}/tests.json holds no case — a program comes with its tests`);
      for (const test of tests) {
        const ran = this.execute(script, JSON.stringify(test.input), manifest.timeout_ms);
        // Too slow is no wrong answer: the timeout or the speed is to fix, not the logic.
        if ('timeout' in ran) return this.fail(6, `the program of ${id} did not answer its test "${test.why}" within ${manifest.timeout_ms} ms — raise timeout_ms in ${programDir(spec.program)}/manifest.json, or make the program faster`);
        const failed = 'exit' in test
          ? ('refused' in ran ? null : `it should refuse (exit ${test.exit})`)
          : 'out' in ran ? (sameJson(ran.out, test.output) ? null : `it answered ${ran.out.trim()}`) : `it gave no answer (${'refused' in ran ? ran.refused : 'timeout' in ran ? 'timeout' : ran.error})`;
        if (failed) return this.fail(6, `the program of ${id} fails its own test "${test.why}": ${failed} — fix the program or the test, then run again`);
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, tested: proof }, null, 2) + '\n');
    }
    let extra: Record<string, unknown> = {};
    if (spec.input.in) {
      if (!inArg) return this.fail(2, `${id} takes its input shaped as \`${spec.input.in}\`: ${this.cmd} run ${id} '<json>'`);
      try { extra = { in: JSON.parse(inArg) }; } catch { return this.fail(2, `the input of ${id} is not JSON`); }
    }
    const input = this.inputJson(spec, extra);
    if (!input) return this.lastCode;
    const json = JSON.stringify(input);
    const fingerprint = sha256Hex(json);
    const record = (outcome: ExecutorRecord['outcome']) => this.recordExecution(id!, spec, fingerprint, outcome);
    const ran = this.execute(script, json, manifest.timeout_ms);
    if ('timeout' in ran) { record('timeout'); return this.fail(4, `the program of ${id} did not answer within ${manifest.timeout_ms} ms — carry this one out yourself, and say so`); }
    if ('error' in ran) return this.fail(6, ran.error);
    if ('refused' in ran) { record('refused'); return this.fail(3, `the program of ${id} refused its input (${ran.refused}) — stop the procedure and report it; never carry this piece out yourself`); }
    const broken = this.deliver(id!, spec, ran.out, 'ran', fingerprint);
    if (broken) { record('broken'); return this.fail(6, `the program of ${id} answered outside its contract: ${broken} — fix the program, then run again`); }
    return this.delivered(id!, spec, ran.out);
  }

  /**
   * `check <cnd-id>` — a checked condition put to the judge: the state is built
   * from this session's variables, exactly as stored (`### <name>` and the
   * value, each variable the condition reads); the question is the compiler's.
   * Open at or above the threshold; closed below it, and closed when in doubt —
   * an empty variable, a state too large, a judge that cannot answer. A checked
   * UNTIL counts its closed answers in a row: at the round limit, the agent is
   * told to stop. Every check is recorded in the session. A sealed condition's
   * answer never says what it checks.
   */
  private async check(args: string[]): Promise<number> {
    const answer = (outcome: 'open' | 'closed', ...lines: string[]): void => { this.out(outcome); lines.forEach(l => this.out(l)); };
    const refused = (message: string): number => { answer('closed', `# error: ${message}`); return 2; };
    const [id] = args;
    if (!id) return refused(`check needs a condition id — the line that asks for the check names it: ${this.cmd} check cnd-…`);
    const spec = this.doc.meta.checks?.[id];
    if (!spec) return refused(`no checked condition with id '${id}' in this agent — its checks: ${this.cmd} scope`);
    const config = this.build.checks;
    if (!config) return refused(`this apx records no judge for its checks — add checks: { adapter: 'jev' } to agent-pack.config.mjs, then run agent-pack bundle all`);
    const session = this.openSession();
    if (typeof session === 'string') return refused(`${session} — the gate stays closed`);
    let judge: JudgePlugin;
    try { judge = this.judgeNamed(config.adapter); } catch (e) { return refused(`the judge \`${config.adapter}\` cannot be loaded by the apx (${e instanceof Error ? e.message : e})`); }
    try {
      const verdict = await this.verdict(spec, id, session, judge, config.model);
      const prior = spec.kind === 'UNTIL' ? session.checks(id) : [];
      // This answer's round, counted as closed: it is recorded before the verdict is known.
      const round = roundOf([...prior.map(r => r.outcome === 'open'), false], spec.kind === 'UNTIL' ? spec.rounds : undefined);
      session.record({ ...verdict.record, cnd: id, level: spec.level, round, threshold: config.threshold, at: new Date().toISOString() });
      if (verdict.open) { answer('open', verdict.why); return 0; }
      const rounds = spec.kind !== 'UNTIL' || !spec.rounds ? []
        : [roundLine(round, spec.rounds, FORMULAS.keywords.CHECK.loop)];
      answer('closed', verdict.why, ...rounds);
      return 1;
    } catch (e) {
      return refused(`the check could not be run or recorded: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * The judge's verdict on one checked condition — what the agent is told, and
   * what the session records of it. Closed when in doubt; a sealed condition's
   * reason never quotes what it checks.
   */
  private async verdict(spec: ApCheckSpec, id: string, session: SessionVars, judge: JudgePlugin, model: string | undefined):
    Promise<{ open: boolean; why: string; record: Pick<CheckRecord, 'fingerprint' | 'model' | 'p' | 'outcome'> }> {
    const sealed = spec.level === 2;
    const threshold = this.build.checks!.threshold;
    const closed = (plain: string, gate: string, record: Partial<CheckRecord> = {}) =>
      ({ open: false, why: sealed ? `the gate stayed closed — ${gate}` : plain, record: { fingerprint: '', model: '', p: '', ...record, outcome: 'closed' as const } });
    const read = this.readVariables(session, spec.vars);
    if ('empty' in read) return closed(`${emptyVariable(read.empty)}: the condition cannot hold`, 'a variable it reads is empty');
    const state = stateOf(read.values);
    const fingerprint = sha256Hex(state);
    const limit = judge.maxStateChars;
    if (limit !== undefined && state.length > limit) {
      return closed(`the state is too large for the judge (${state.length} characters, at most ${limit}) — it was not sent`, 'its state is too large for the judge', { fingerprint });
    }
    let answered: Awaited<ReturnType<JudgePlugin['ask']>>;
    try {
      answered = await judge.ask(state, [{ id, question: spec.question }], model);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split(spec.question).join('…');
      return closed(`the judge could not answer (${why})`, `the judge could not answer (${why})`, { fingerprint });
    }
    const p = answered.answers[id];
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return closed('the judge gave no probability', 'the judge gave no probability', { fingerprint, model: answered.model });
    const record = { fingerprint, model: answered.model, p: String(p) };
    if (p >= threshold) {
      return { open: true, why: sealed ? `the gate opened (p=${p})` : `the judge answered p=${p}, at or above ${threshold} — the condition holds`, record: { ...record, outcome: 'open' } };
    }
    return closed(`the judge answered p=${p}, below ${threshold} — the condition does not hold`, `p=${p}, below ${threshold}`, record);
  }

  /** A delegate's or a program's contract: what it carries out, what it receives, what it answers. */
  private getExecutor(id: string, spec: ApExecutorSpec): number {
    this.out(`# ${spec.site} ${id}  — ${FORMULAS.keywords.EXECUTOR.who[executorKey(spec.executor)]}${spec.by ? ` \`${spec.by}\`` : ''} carries it out, never you`);
    this.out(`${spec.site}: ${spec.text}`);
    const keys = [...spec.input.vars.map(v => `${v} (as stored in this session)`), ...Object.entries(spec.input.constants).map(([k, v]) => `${k} = ${v}`), ...(spec.input.in ? [`in (shaped as ${spec.input.in})`] : [])];
    this.out(`input: ${keys.length ? keys.join(', ') : 'nothing'}  — one key each, nothing else`);
    const out = spec.output.holds ? '{"holds": true | false}'
      : spec.output.into ? `the value of \`${spec.output.into}\`${spec.output.template ? `, shaped as ${spec.output.template}` : ''}`
      : spec.output.template ? `shaped as ${spec.output.template}` : 'its result';
    this.out(`output: ${out}`);
    return 0;
  }

  /** `get <cnd-id>`: a checked condition — its question, unless it is sealed. */
  private getCheck(id: string, spec: ApCheckSpec): number {
    this.out(`# check ${id}  ${checkedKeyword(spec.kind, spec.level)}  — a judge decides it: ${this.cmd} check ${id}`);
    if (spec.level === 2) {
      this.out('# sealed — what it checks is the judge\'s alone, and is not shown');
      return 0;
    }
    this.out(`question: ${spec.question}`);
    this.out(`state: ${spec.vars.join(', ')}  — each variable as stored in this session`);
    return 0;
  }

  /**
   * What is wrong with a JSON text against a contract template — or null when
   * it fits. With `list`, the text is a list of at least `min` instances,
   * reported under `name`.
   */
  contractIssues(json: string, template: ApRef, list?: { name: string; min: number }): string | null {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return 'not valid JSON'; }
    const slots = this.doc.slotsOf(template);
    if (!slots) return null;
    const issues = list
      ? validateRecord({ [list.name]: value }, [{ name: list.name, optional: false, spec: { kind: 'list', ref: refName(template), min: list.min } }], this.doc.slotResolver())
      : validateRecord(value, slots, this.doc.slotResolver());
    return issuesText(issues);
  }

  private version(): number {
    this.out(`# ${this.root.name}  ${this.root.id}`);
    this.out(`# built ${this.build.builtAt} by agent-pack ${this.build.agentPackVersion}  hash ${this.build.hash}  ${this.doc.all().length} blocks`);
    this.out(`# ${CREDIT}`);
    return 0;
  }

  private help(): number {
    const rows: [string, string][] = [...HELP, ...servicesOf(this.doc).flatMap(s => s.operations.map(o => [`${s.kind} ${o.op} ${o.args}`.trim(), o.about] as [string, string]))];
    const width = Math.max(...rows.map(([v]) => v.length));
    for (const [verb, what] of rows) this.out(`${this.cmd} ${verb.padEnd(width)}  ${what}`);
    return 0;
  }

  // ------------------------------------------------------------ block views

  /**
   * What `get` shows: the agent's whole definition (the preamble, never
   * trimmed); the team as this agent sees it; any other block as its section.
   */
  /**
   * The agent's own definition — its preamble, in the md projection's words —
   * with every reference as the command that fetches it: what `get` prints for
   * the agent, and what a harness file may carry so the agent has it up front.
   */
  definition(): string {
    return this.text(this.root);
  }

  private text(block: ApBlock): string {
    if (block === this.root) return renderPreamble(this.doc, this.env);
    if (block.kind === 'team') return this.teamView(block as TeamBlock);
    return renderEntry(block, 1, this.env);
  }

  /** The team — members with the command that reaches each, routing, shared block. */
  private teamView(team: TeamBlock): string {
    const out = [this.headLine(team)];
    if (team.members.length > 0) {
      out.push('members:');
      for (const m of team.members) {
        const member = this.doc.resolve(m);
        out.push(`  ${this.refLabel(m)}${member?.about ? `  — ${member.about}` : ''}`);
      }
    }
    if (team.routing?.length) {
      out.push('routing:');
      for (const r of team.routing) out.push(`  WHEN ${r.when}  -> ${this.refLabel(r.run)}`);
    }
    if (team.shared) out.push(`shared: ${team.shared}`);
    return out.join('\n') + '\n';
  }

  /** `uses:` and `used by:` of a block, each with its command. */
  private links(block: ApBlock): void {
    // Every policy in the document binds the agent — imported, not referenced by a line.
    const policies = block === this.root ? this.doc.byKind('policy') : [];
    const uses = [...uniqueRefs(block.toJSON()).map(r => this.refLabel(r)), ...policies.map(p => this.label(p))];
    this.out('uses:');
    if (uses.length === 0) this.out('  (nothing)');
    for (const use of uses) this.out(`  ${use}`);
    this.out('used by:');
    const users = this.doc.all().filter(b => b !== block && (
      uniqueRefs(b.toJSON()).some(r => r.target === block.address) || (block.kind === 'policy' && b === this.root)));
    if (users.length === 0) this.out('  (nothing inside this agent)');
    for (const user of users) this.out(`  ${this.label(user)}`);
  }

  // ---------------------------------------------------------------- helpers

  /** `kind name  [command]` — how a block reads in the engine's views. */
  private label(block: ApBlock): string {
    return `${block.kind} ${block.name}  [${this.cmd} ${block.kind === 'flow' ? 'flow' : 'get'} ${block.id}]`;
  }

  /** A reference as a label: here → its block; a fellow agent → its own executable. */
  private refLabel(ref: ApRef): string {
    const block = this.doc.resolve(ref);
    if (block) return this.label(block);
    const name = refName(ref);
    if (ref.kind === 'agent') return `agent ${name}  [${this.sibling(name)} scope]`;
    return `${ref.kind} ${name}  (missing from the compiled sources)`;
  }

  /** How to run a fellow agent's executable: beside this one. */
  private sibling(name: string): string {
    return `node ${join(dirname(this.exe), `${name}.apx`)}`;
  }

  private headLine(block: ApBlock): string {
    return `# ${block.kind} ${block.name}${block.about ? ` — ${block.about}` : ''}`;
  }

  private lsLine(block: ApBlock): string {
    const tags = block.tags.length > 0 ? `  ${block.tags.map(t => `#${t}`).join(' ')}` : '';
    // A policy or a skill says where it holds: its perimeter, or only under a WITH that names it (src/withUse.ts).
    const scope = SCOPED_KINDS.includes(block.kind) ? `  [${scopeLabel(block.scopes)}]` : '';
    return `${block.id}  ${block.name}${tags}${scope}${block.about ? `  — ${block.about}` : ''}`;
  }

  /** Blocks grouped by kind, in reading order. */
  private groups(blocks: ApBlock[]): [string, ApBlock[]][] {
    const kinds = [...new Set(blocks.map(b => b.kind))].sort((a, b) => kindRank(a) - kindRank(b));
    return kinds.map(kind => [kind, blocks.filter(b => b.kind === kind)]);
  }

  /** The compiled script of this version of a flow — or null. */
  private flowScript(flow: ApBlock): string | null {
    const stem = flowScriptStem(flow.id, flow.contentHash);
    return this.findIn(FLOWS_DIR, f => f.startsWith(`${stem}.`));
  }

  /** The first file of a project folder that matches — its path, or null. */
  private findIn(folder: string, match: (file: string) => boolean): string | null {
    const dir = resolve(projectRootOf(this.exe), folder);
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find(match);
    return file ? join(dir, file) : null;
  }

  /** The quiz: the questions of every kind this agent holds, in reading order. */
  /** Questions on the kinds the agent still reads on demand — an opened block needs no quiz. */
  private quiz(): (QuizQuestion & { kind: string })[] {
    const guides = FORMULAS.blocks as unknown as Record<string, { quiz?: QuizQuestion[] }>;
    const opened = new Set(this.opened());
    const pending = this.doc.all().filter(b => b !== this.root && !opened.has(b));
    if (pending.length === 0) return [];
    return this.groups([this.root, ...pending]).flatMap(([kind]) => (guides[kind]?.quiz ?? []).map(q => ({ ...q, kind })));
  }

  /** The block named by a verb's id argument, or null after printing the error. */
  lastCode = 0;
  private blockArg(verb: string, args: string[]): ApBlock | null {
    const id = args[0];
    if (!id) {
      this.lastCode = this.fail(2, `${verb} needs a block id — example: ${this.cmd} ${verb} ${this.root.id}`);
      return null;
    }
    const block = this.byId.get(id);
    if (block) return block;
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    const fellow = team?.members.find(m => m.id === id && !this.doc.resolve(m));
    this.lastCode = fellow
      ? this.fail(1, `${id} is an agent defined in its own executable — run: ${this.sibling(addressName(fellow.target))} scope`)
      : this.notFound(id);
    return null;
  }

  /** Neither a block nor a variable answers to this name. */
  private notFound(name: string): number {
    return this.fail(1, `no block with id '${name}' and no variable named so — list them: ${this.cmd} ls`);
  }

  out(line: string): void {
    this.write(line);
  }

  /** Print a multi-line text as it is (one trailing newline trimmed). */
  print(text: string): number {
    this.write(text.replace(/\n$/, ''));
    return 0;
  }

  fail(code: number, message: string): number {
    this.write(`# error: ${message}`);
    return code;
  }

  // -------------------------------------------------------------- variables

  /**
   * `get <name>`: a constant's value, or a variable (private or SESSION) — its definition,
   * who stores it and who reads it, then its value in this session (or that it
   * is still empty). The value is printed last, as stored, byte for byte.
   */
  private getVariable(name: string): number {
    const constant = constantOf(this.doc.mdSource?.vars, name);
    if (constant !== undefined) {
      this.out(`# constant ${name} = ${constant}  — fixed at compile time: its value is written where it is read`);
      return 0;
    }
    const block = this.variable(name);
    if (!block) return this.notFound(name);
    const vars = this.sessionVars();
    if (!vars) return this.lastCode;
    let stored: string | null;
    try { stored = vars.read(name, block.scope); } catch (e) { return this.fail(2, `reading ${name}: ${e instanceof Error ? e.message : e}`); }
    this.print(this.text(block));
    this.out(`# var ${name}  ${block.id}`);
    this.links(block);
    this.out('read by:');
    const readers = this.doc.all().filter(b => readsOf(JSON.stringify(b.body)).some(r => r.name === name && !r.field));
    if (readers.length === 0) this.out('  (nothing inside this agent)');
    for (const reader of readers) this.out(`  ${this.label(reader)}`);
    if (stored === null) {
      this.out('# value: (empty — nothing stored in this session yet)');
    } else {
      this.out('# value:');
      this.write(stored);
    }
    return 0;
  }

  /**
   * `set <name> -|<value>`: store a variable's value for this session —
   * the last write wins. A constant is never set; a typed variable takes only
   * JSON its template accepts. A refused value writes nothing.
   */
  private set(args: string[]): number {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) {
      return this.fail(2, `set needs a variable and its value — ${this.cmd} set <name> <value>, or ${this.cmd} set <name> - with the value on stdin`);
    }
    if (constantOf(this.doc.mdSource?.vars, name) !== undefined) {
      return this.fail(1, `\`${name}\` is a constant, fixed at compile time — only a variable is set; nothing was written`);
    }
    const block = this.variable(name);
    if (!block) return this.fail(1, `no variable \`${name}\` in this agent — the variables: ${this.cmd} ls kind=var; nothing was written`);
    const value = rest.length === 1 && rest[0] === '-' ? readFileSync(0, 'utf-8') : rest.join(' ');
    const failed = this.storeVariable(block, value);
    if (failed) {
      // A typed value refused: the shape it takes, spelled out, so the next try is the right one.
      const slots = block.type ? this.doc.slotsOf(block.type) : null;
      if (slots && failed.code === 2) this.out(`# the JSON \`${refName(block.type!)}\` takes: ${JSON.stringify(jsonExample(slots, this.doc.slotResolver()))}`);
      return this.fail(failed.code, `${failed.reason} — nothing was written`);
    }
    this.out(`# ${name} stored for this session — read it: ${this.cmd} get ${name}`);
    return 0;
  }

  /**
   * The one write of a variable: a typed one takes only JSON its template
   * (compiled into this agent) accepts. Null once stored; else why not, and the
   * exit code to fail with — `set`, and an answer or a run stored `INTO` it.
   */
  storeVariable(block: VarBlock, value: string): { code: number; reason: string } | null {
    const type = block.type ? refName(block.type) : '';
    if (block.type) {
      if (!this.doc.slotsOf(block.type)) return { code: 1, reason: notCompiled(block.name, type) };
      const issues = this.contractIssues(value, block.type);
      if (issues) return { code: 2, reason: `the value is not shaped as \`${type}\`: ${issues}` };
    }
    const session = this.openSession();
    if (typeof session === 'string') return { code: 2, reason: session };
    try { session.write(block.name, block.scope, { value, type, by: this.root.name }); } catch (e) { return { code: 2, reason: `storing ${block.name}: ${e instanceof Error ? e.message : e}` }; }
    return null;
  }

  /** The values this session stores for `names`, in order — or the first one that is empty. */
  private readVariables(session: SessionVars, names: string[]): { values: { name: string; value: string }[] } | { empty: string } {
    const values: { name: string; value: string }[] = [];
    for (const name of names) {
      const block = this.variable(name);
      const value = block ? session.read(name, block.scope) : null;
      if (value === null || value.trim() === '') return { empty: name };
      values.push({ name, value });
    }
    return { values };
  }

  /** A variable of this agent, by name. */
  variable(name: string): VarBlock | null {
    return (this.doc.byKind('var') as VarBlock[]).find(v => v.name === name) ?? null;
  }

  /**
   * This session's variables, from the session id the harness puts in the
   * variable its adapter names. Fails closed — no adapter naming one, no id, an
   * id that is no folder name, or storage that cannot keep them: null after
   * the error, nothing read or written.
   */
  private sessionVars(): SessionVars | null {
    const session = this.openSession();
    if (typeof session !== 'string') return session;
    this.lastCode = this.fail(2, `${session} — nothing was read or written`);
    return null;
  }

  /** This session's variables — or why there are none. */
  openSession(): SessionVars | string {
    const env = this.doc.meta.sessionEnv;
    const id = env ? process.env[env] : undefined;
    const refused = !env
      ? 'variables need the harness session id, and this agent was compiled without an adapter that names where it is'
      : !id ? `variables need the harness session id, and ${env} is not set`
        : !SESSION_ID_RE.test(id) ? `${env} holds no usable session id (letters, digits, . _ - only)` : null;
    return refused ?? openSessionVars(resolve(projectRootOf(this.exe)), id!, this.root.name, this.build.tabeli);
  }

  // -------------------------------------------------------------- contracts

  /** The session id the harness gives — or why there is none (the same rule the variables follow). */
  sessionIdOrReason(needs = 'contracts need'): { id: string } | { reason: string } {
    const env = this.doc.meta.sessionEnv;
    const id = env ? process.env[env] : undefined;
    if (!env) return { reason: `${needs} the harness session id, and this agent was compiled without an adapter that names where it is` };
    if (!id) return { reason: `${needs} the harness session id, and ${env} is not set` };
    if (!SESSION_ID_RE.test(id)) return { reason: `${env} holds no usable session id (letters, digits, . _ - only)` };
    return { id };
  }

  /** `contract <verb> …` — the instances of a team of contracts (D44). */
  private async contract(args: string[]): Promise<number> {
    const [verb, ...rest] = args;
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    if (!team || team.strategy !== 'contracts') return this.fail(2, `${this.root.name} is in no team with \`STRATEGY contracts\` — it has no contracts`);
    const session = this.sessionIdOrReason();
    if ('reason' in session) return this.fail(2, `${session.reason} — nothing was read or written`);
    const root = resolve(projectRootOf(this.exe));
    const table = ContractTable.open(root, session.id, this.build.tabeli);
    if (typeof table === 'string') return this.fail(2, `${table} — nothing was read or written`);
    let ws: WorkspaceSession | null = null;
    const cx: ContractCx = {
      team, table, root, lead: team.lead ? refName(team.lead) : '', session: session.id,
      // The copies: opened on the first verb that needs them — a project outside git fails there, with the way out.
      ws: () => ws ??= resolveWorkspace(CONTRACT_WORKSPACE).session(root, session.id),
    };
    try {
      switch (verb) {
        case 'list': return this.contractList(cx);
        case 'get': return this.contractGet(cx, rest);
        case 'start': return this.contractStart(cx, rest);
        case 'new': return this.contractNew(cx, rest);
        case 'dispatch': return this.contractDispatch(cx);
        case 'within': return this.contractWithin(cx, rest);
        case 'deliver': return this.contractDeliver(cx, rest);
        case 'block': return this.contractBlock(cx, rest);
        case 'take': return this.contractTake(cx, rest);
        case 'merge': return this.contractMerge(cx, rest);
      }
    } catch (e) {
      return this.fail(2, `the contracts could not be read or written: ${e instanceof Error ? e.message : e}`);
    }
    return this.fail(2, `${verb ? `'${verb}' is no verb of contract` : 'contract takes a verb'} — ${this.cmd} contract list|get|start|new|dispatch|within|deliver|block|take|merge`);
  }

  /** A contract block of this document by its id, or by its name — or null after saying why. */
  private contractBlock_(id: string | undefined, usage: string): ContractBlock | null {
    const named = id ? this.doc.byKind('contract').filter(b => b.name === id) : [];
    const block = id ? this.byId.get(id) ?? (named.length === 1 ? named[0] : undefined) : undefined;
    if (!block || block.kind !== 'contract') {
      this.lastCode = this.fail(2, `${id ? `${id} is no contract of this agent` : 'a contract id is needed'} — ${this.cmd} contract ${usage}; the contracts: ${this.cmd} ls kind=contract`);
      return null;
    }
    return block as ContractBlock;
  }

  /** An instance by its id — or null after saying why. */
  private instance(cx: ContractCx, id: string | undefined, usage: string): ContractRecord | null {
    if (!id || !CONTRACT_ID_RE.test(id)) { this.lastCode = this.fail(2, `an instance id is needed (ctr-…) — ${this.cmd} contract ${usage}`); return null; }
    const r = cx.table.get(id);
    if (!r) { this.lastCode = this.fail(1, `no instance ${id} in this session — ${this.cmd} contract list`); return null; }
    return r;
  }

  /** The name of a contract block by id, for the eye. */
  private contractName(id: string): string {
    return this.byId.get(id)?.name ?? id;
  }

  /** How far an instance's contract lets it write — `domain` when its block is not in this document. */
  private limitOf(r: ContractRecord): ContractLimit {
    return (this.byId.get(r.contract) as ContractBlock | undefined)?.within ?? 'domain';
  }

  /** An agent's perimeter, from its own apx beside this one — null when it has none, or no apx. */
  private perimeterOf(agent: string): PerimeterGlobs | null {
    if (agent === this.root.name) return this.doc.perimeter();
    const file = join(dirname(this.exe), `${agent}.apx`);
    if (!existsSync(file)) return null;
    return ApDocumentClass.fromJson(parsePayload(readFileSync(file, 'utf-8')).document).perimeter();
  }

  /** What an instance's delivery may keep: its WITHIN, read on its zones and on the globs its assignee wrote at dispatch. */
  private allowedOf(r: ContractRecord): Allowed {
    const zones = parseZones(r.zone);
    const files = [...new Set(zones.map(z => z.file))];
    const limit = this.limitOf(r);
    const marks = files.length ? { ...zoneMarks(r.ctr), files, only: limit === 'zone' } : undefined;
    return { globs: limit === 'domain' ? r.writes.split(',').filter(Boolean) : files, ...(marks ? { marks } : {}) };
  }

  /** Read a spec on stdin and check it against the contract's form — the JSON text, or null after saying why (exit 6). */
  private specOf(block: ContractBlock): string | null {
    const text = readFileSync(0, 'utf-8').trim();
    if (!block.shape) return text;
    const issues = this.contractIssues(text, block.shape.ref);
    if (issues) {
      const slots = this.doc.slotsOf(block.shape.ref);
      const example = slots ? ` — a spec is JSON shaped like ${JSON.stringify(jsonExample(slots, this.doc.slotResolver()))}` : '';
      this.lastCode = this.fail(6, `the spec breaks the form of ${block.name} (${refName(block.shape.ref)}): ${issues}${example}; nothing was written`);
      return null;
    }
    return JSON.stringify(JSON.parse(text));
  }

  private contractList(cx: ContractCx): number {
    const all = cx.table.all();
    for (const r of all) {
      this.out(`${r.ctr}  ${this.contractName(r.contract)}  ${r.state}  → ${r.assignee}${r.zone ? `  ${r.zone}` : ''}${r.depends ? `  depends: ${r.depends}` : ''}${r.left_out ? `  left out: ${r.left_out}` : ''}${r.reason ? `  — ${r.reason}` : ''}`);
    }
    this.out(`# ${countOf(all.length, 'instance', 'instances')} in this session — one: ${this.cmd} contract get <ctr-id>`);
    return 0;
  }

  private contractGet(cx: ContractCx, args: string[]): number {
    const r = this.instance(cx, args[0], 'get <ctr-id>');
    if (!r) return this.lastCode;
    const block = this.byId.get(r.contract) as ContractBlock | undefined;
    const limit = this.limitOf(r);
    this.out(`contract ${r.ctr} — ${this.contractName(r.contract)} — ${r.state} — assigned to ${r.assignee}`);
    if (block?.domain) this.out(`domain: ${block.domain}`);
    this.out(`within: ${limit} — write ${enumPrimitiveFor('WITHIN')!.values[limit]()}`);
    this.out(`zones: ${r.zone ? r.zone.split(';').join(', ') : r.dispatched_at ? 'none — new code' : '(not dispatched yet)'}`);
    if (r.dispatched_at) this.out(`copy: ${cx.ws().path(r.ctr)}`);
    if (r.depends) this.out(`depends on: ${r.depends.split(',').map(d => `${d} (${cx.table.get(d)?.state ?? '?'})`).join(', ')}`);
    if (r.parent) this.out(`part of: ${r.parent}`);
    if (r.reason) this.out(`blocked: ${r.reason}`);
    if (r.left_out) {
      this.out(`left out: ${r.left_out} — why: ${r.why}`);
      this.out(`# read them in its copy: ${r.left_out.split('; ').map(e => join(cx.ws().path(r.ctr), e.replace(/ \(.*\)$/, ''))).join(', ')}`);
    }
    this.out('spec:');
    this.print(JSON.stringify(JSON.parse(r.spec || '{}'), null, 2));
    if (r.assignee === this.root.name && r.state === 'assigned' && r.dispatched_at) {
      this.out(`# work in your copy: cd ${cx.ws().path(r.ctr)} — read and write only there${r.zone ? '; leave the marks where they are, the delivery drops them' : ''}`);
      this.out(`# when done: ${this.cmd} contract deliver ${r.ctr}`);
      this.out(`# if it cannot be honoured as written: ${this.cmd} contract block ${r.ctr} "<why>"`);
    }
    return 0;
  }

  /** A new instance id: the session, the contract, the count of its instances, the spec. */
  private instanceId(cx: ContractCx, contract: string, spec: string): string {
    return shortId('ctr', JSON.stringify([cx.session, contract, cx.table.all().filter(r => r.contract === contract).length, spec]));
  }

  /** A record's empty fields — every field is text: tabeli is flat. */
  private freshRecord(fields: Pick<ContractRecord, 'ctr' | 'contract' | 'spec' | 'assignee' | 'depends' | 'parent'>): ContractRecord {
    return { ...fields, zone: '', state: 'assigned', reason: '', dispatched_at: '', writes: '', left_out: '', why: '', author: this.root.name };
  }

  private contractStart(cx: ContractCx, args: string[]): number {
    if (cx.lead !== this.root.name) return this.fail(2, `only the lead (${cx.lead}) starts the team's work`);
    const block = this.contractBlock_(args[0], 'start <con-id> -');
    if (!block) return this.lastCode;
    if (args[1] !== '-') return this.fail(2, `the spec comes on stdin — ${this.cmd} contract start ${block.id} - < spec.json`);
    if (!block.byTeam || addressName(block.byTeam.target) !== cx.team.name) return this.fail(2, `${block.name} is not handed to ${cx.team.name} — start takes the contract that hands the request to your team`);
    const mine = cx.table.all().filter(r => r.assignee === this.root.name && r.state === 'assigned');
    if (mine.length) return this.fail(2, `you already work on ${mine.map(r => r.ctr).join(', ')} — finish it before starting another`);
    const spec = this.specOf(block);
    if (spec === null) return this.lastCode;
    const ctr = this.instanceId(cx, block.id, spec);
    cx.table.add(this.freshRecord({ ctr, contract: block.id, spec, assignee: this.root.name, depends: '', parent: '' }));
    this.out(`${ctr}  ${block.name}  assigned  → ${this.root.name}`);
    return 0;
  }

  private contractNew(cx: ContractCx, args: string[]): number {
    if (cx.lead !== this.root.name) return this.fail(2, `only the lead (${cx.lead}) writes contracts`);
    const usage = 'new <con-id> [depends=<ctr>,…] [parent=<ctr>] -';
    const block = this.contractBlock_(args[0], usage);
    if (!block) return this.lastCode;
    if (!cx.team.contracts.some(r => r.id === block.id)) return this.fail(2, `${block.name} is no contract of ${cx.team.name} — the team's: ${cx.team.contracts.map(r => refName(r)).join(', ')}`);
    const opts = args.slice(1);
    if (opts[opts.length - 1] !== '-') return this.fail(2, `the spec comes on stdin — ${this.cmd} contract ${usage}`);
    const all = cx.table.all();
    const depends = splitList(opts.find(o => o.startsWith('depends='))?.slice(8) ?? '');
    for (const d of depends) if (!all.some(r => r.ctr === d)) return this.fail(1, `depends: no instance ${d} in this session — nothing was written`);
    const mine = all.filter(r => r.assignee === this.root.name && r.state === 'assigned' && !r.dispatched_at);
    let parent = opts.find(o => o.startsWith('parent='))?.slice(7) ?? '';
    if (!parent) {
      if (mine.length !== 1) return this.fail(2, `${mine.length ? `you work on ${mine.map(r => r.ctr).join(', ')}` : 'you work on no instance yet'} — say which this is part of: parent=<ctr>${mine.length ? '' : ` (or start one: ${this.cmd} contract start <con-id> -)`}`);
      parent = mine[0].ctr;
    } else if (!mine.some(r => r.ctr === parent)) return this.fail(1, `parent: ${parent} is no instance you work on`);
    if (block.by.length === 0) return this.fail(2, `${block.name} names no one to carry it out`);
    const spec = this.specOf(block);
    if (spec === null) return this.lastCode;
    // Several agents in BY: each new instance to the next, in the order written.
    const assignee = refName(block.by[all.filter(r => r.contract === block.id).length % block.by.length]);
    const ctr = this.instanceId(cx, block.id, spec);
    cx.table.add(this.freshRecord({ ctr, contract: block.id, spec, assignee, depends: depends.join(','), parent }));
    this.out(`${ctr}  ${block.name}  assigned  → ${assignee}`);
    const marks = zoneMarks(ctr);
    this.out(block.within === 'domain'
      ? `# to point it at code that exists, mark the zones: \`${marks.open}\` where one starts, \`${marks.close}\` where it ends, inside comments — then ${this.cmd} contract dispatch`
      : `# WITHIN ${block.within}: mark its zones — \`${marks.open}\` where one starts, \`${marks.close}\` where it ends, inside comments, in any files — then ${this.cmd} contract dispatch`);
    return 0;
  }

  /**
   * `dispatch` — the lead hands the work out. Each new instance's zones are
   * looked for in what the lead writes: marks in order, every zone in a file
   * its assignee writes; a WITHIN zone or file instance needs one at least.
   * What was merged since the last round lands first; then each instance gets
   * its copy, from the working folder as it is.
   */
  private contractDispatch(cx: ContractCx): number {
    if (cx.lead !== this.root.name) return this.fail(2, `only the lead (${cx.lead}) hands the work out`);
    const pending = cx.table.all().filter(r => r.state === 'assigned' && !r.dispatched_at && r.assignee !== this.root.name);
    if (pending.length === 0) return this.fail(1, `no instance to hand out — write them first: ${this.cmd} contract new <con-id> -`);
    const globs = this.doc.perimeter()?.writes ?? [];
    if (globs.length === 0) return this.fail(2, `${this.root.name} works within no domain it writes — the zones are marked in the files the lead writes: write \`@WITHIN <domain>\` above its AGENT, a domain with WRITES`);
    const { zones, problems } = scanZones(cx.root, perimeterFiles(cx.root, globs), pending.map(r => r.ctr));
    const refusals: string[] = [...problems].map(([ctr, why]) => `${ctr}: ${why}`);
    const perimeters = new Map<string, Perimeter>();
    for (const r of pending) {
      const limit = this.limitOf(r);
      const zs = zones.get(r.ctr) ?? [];
      if (limit !== 'domain' && zs.length === 0 && !problems.has(r.ctr)) refusals.push(`${r.ctr}: WITHIN ${limit} needs a zone — mark it: \`${zoneMarks(r.ctr).open}\` … \`${zoneMarks(r.ctr).close}\`, inside comments`);
      const p = this.perimeterOf(r.assignee);
      if (!p || p.writes.length === 0) { refusals.push(`${r.ctr}: ${r.assignee} works within no domain it writes — it has nothing to deliver; compile it with \`@WITHIN <domain>\` above its AGENT`); continue; }
      perimeters.set(r.ctr, p);
      for (const z of zs) if (!matchesAnyGlob(z.file, p.writes)) refusals.push(`${r.ctr}: ${z.file} holds a zone of it, and ${r.assignee} does not write that file`);
    }
    if (refusals.length) {
      for (const line of refusals) this.out(`refused: ${line}`);
      return this.fail(3, `nothing was handed out — fix the ${countOf(refusals.length, 'instance', 'instances')} above and dispatch again`);
    }
    const landing = cx.ws().land();
    if ('conflicts' in landing) return this.fail(3, `what was merged conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then dispatch again`);
    if (landing.landed.length) this.out(`# landed in the working folder: ${landing.landed.join(', ')}`);
    const at = new Date().toISOString();
    for (const r of pending) {
      const p = perimeters.get(r.ctr)!;
      cx.ws().open(r.ctr, p);
      cx.table.set(r.ctr, { zone: zonesText(zones.get(r.ctr) ?? []), dispatched_at: at, writes: p.writes.join(',') });
      this.out(`${r.ctr}  ${this.contractName(r.contract)}  → ${r.assignee}  within ${this.limitOf(r)}${zones.get(r.ctr) ? `  ${zonesText(zones.get(r.ctr)!)}` : ''}  copy: ${cx.ws().path(r.ctr)}`);
    }
    this.out(`# ${countOf(pending.length, 'instance', 'instances')} handed out — merge each as it is delivered: ${this.cmd} contract merge <ctr-id>`);
    return 0;
  }

  /**
   * `within <ctr> <path>` — whether a file the instance's copy changed stays
   * within its contract: exit 0, or 3 with the warning. What a harness hook
   * calls as soon as the file is written (adapters/claude-code).
   */
  private contractWithin(cx: ContractCx, args: string[]): number {
    const r = this.instance(cx, args[0], 'within <ctr-id> <path>');
    if (!r) return this.lastCode;
    const path = args[1];
    if (!path) return this.fail(2, `a path is needed — ${this.cmd} contract within ${r.ctr} <path>`);
    if (!r.dispatched_at) return this.fail(2, `${r.ctr} has no copy yet — it was not handed out`);
    const d = cx.ws().deliver(r.ctr, this.allowedOf(r), { dryRun: true });
    const hit = (e: string) => e === path || e.startsWith(`${path} (`);
    const lost = d.lostZones.filter(hit);
    if (lost.length) { this.out(`${lost.join(', ')}: the marks of ${r.ctr}'s zones are lost — put them back around your work, as the lead wrote them`); return 3; }
    const out = d.leftOut.filter(hit);
    if (out.length === 0) {
      // A file a judge could not place: within the copy, and the assignee's to decide.
      const judged = this.perimeterOf(r.assignee)?.judged;
      const p = judged?.writes.uncertain[path];
      if (p !== undefined) this.out(`${path}: a judge could not tell whether it belongs to your domain (p=${p.toFixed(2)}) — keep it only if the work needs it`);
      return 0;
    }
    this.out(`${out.join(', ')} is outside ${r.ctr} (WITHIN ${this.limitOf(r)}): it will be left out of the delivery — keep it only with a good reason, you will be asked for it at deliver`);
    return 3;
  }

  /**
   * `deliver` — the assignee is done. An instance with a copy keeps what its
   * WITHIN admits; anything else is left out, and only with a reason (`--why`).
   * The instance the lead was handed is done when its parts are: delivering
   * it lands the session's work in the working folder and closes the copies.
   */
  private contractDeliver(cx: ContractCx, args: string[]): number {
    const r = this.instance(cx, args[0], 'deliver <ctr-id> [--why "<reason>"]');
    if (!r) return this.lastCode;
    if (r.assignee !== this.root.name) return this.fail(2, `${r.ctr} is ${r.assignee}'s — only its assignee delivers it`);
    if (r.state !== 'assigned') return this.fail(2, `${r.ctr} is ${r.state} — only an assigned instance is delivered`);
    // The parts of an instance (those written with it as parent) are done first: merged, or blocked and taken over.
    const open = cx.table.all().filter(p => p.parent === r.ctr && p.state !== 'merged');
    if (open.length) return this.fail(3, `${r.ctr} still has parts to finish: ${open.map(p => `${p.ctr} (${p.state})`).join(', ')} — merge them first`);
    if (!r.dispatched_at) {
      // The instance the lead started from: done when its parts are; the request's, when it is the root.
      if (!r.parent && cx.table.all().some(o => o.dispatched_at)) {
        const landing = cx.ws().land({ close: true });
        if ('conflicts' in landing) return this.fail(3, `the work conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then deliver again`);
        if (landing.landed.length) this.out(`# landed in the working folder: ${landing.landed.join(', ')} — uncommitted, for the developer to commit`);
      }
      if (!cx.table.transition(r.ctr, 'assigned', 'delivered')) return this.fail(4, `${r.ctr} changed meanwhile — read it: ${this.cmd} contract get ${r.ctr}`);
      this.out(`${r.ctr}  delivered`);
      return 0;
    }
    const why = flagValue(args.slice(1), '--why');
    const d = cx.ws().deliver(r.ctr, this.allowedOf(r), { dryRun: true });
    if (d.lostZones.length) return this.fail(3, `${r.ctr} was not delivered — the marks of its zones are lost in ${d.lostZones.join(', ')}: put them back around your work, as the lead wrote them`);
    if (d.committed.length === 0 && d.strayed.length) {
      return this.fail(3, `${r.ctr}: nothing changed in your copy, and ${d.strayed.join(', ')} changed in the project folder — the work goes in your copy: ${cx.ws().path(r.ctr)}`);
    }
    if (d.leftOut.length && !why) {
      for (const e of d.leftOut) this.out(`left out: ${e}`);
      return this.fail(3, `${r.ctr} was not delivered — what is left out stays out only with a good reason: ${this.cmd} contract deliver ${r.ctr} --why "<reason>"; or undo it in your copy`);
    }
    cx.ws().deliver(r.ctr, this.allowedOf(r));
    if (!cx.table.transition(r.ctr, 'assigned', 'delivered', { left_out: d.leftOut.join('; '), why: d.leftOut.length ? (why ?? '').replace(/\s+/g, ' ') : '' })) {
      return this.fail(4, `${r.ctr} changed meanwhile — read it: ${this.cmd} contract get ${r.ctr}`);
    }
    this.out(`${r.ctr}  delivered — ${d.committed.length ? d.committed.join(', ') : 'nothing changed'}`);
    if (d.leftOut.length) this.out(`left out: ${d.leftOut.join(', ')} — why: ${why}`);
    return 0;
  }

  private contractBlock(cx: ContractCx, args: string[]): number {
    const r = this.instance(cx, args[0], 'block <ctr-id> <reason>');
    if (!r) return this.lastCode;
    const reason = args.slice(1).join(' ').trim();
    if (!reason) return this.fail(2, `say why ${r.ctr} cannot be honoured — ${this.cmd} contract block ${r.ctr} "<why>"`);
    if (r.assignee !== this.root.name) return this.fail(2, `${r.ctr} is ${r.assignee}'s — only its assignee blocks it`);
    if (!cx.table.transition(r.ctr, 'assigned', 'blocked', { reason: reason.replace(/\s+/g, ' ') })) return this.fail(4, `${r.ctr} is no longer assigned — read it: ${this.cmd} contract get ${r.ctr}`);
    this.out(`${r.ctr}  blocked — the lead takes it over`);
    return 0;
  }

  /**
   * `take` — the lead takes over an instance its assignee blocked, in its copy:
   * the work done so far is there, and the contract's limit stays the same. The
   * lead must write what the copy may deliver.
   */
  private contractTake(cx: ContractCx, args: string[]): number {
    if (cx.lead !== this.root.name) return this.fail(2, `only the lead (${cx.lead}) takes an instance over`);
    const r = this.instance(cx, args[0], 'take <ctr-id>');
    if (!r) return this.lastCode;
    if (r.state !== 'blocked') return this.fail(2, `${r.ctr} is ${r.state} — only a blocked instance is taken over`);
    if (!r.dispatched_at) return this.fail(2, `${r.ctr} was never handed out — it has no copy to take over`);
    const mine = this.doc.perimeter()?.writes ?? [];
    const allowed = this.allowedOf(r);
    const beyond = allowed.globs.filter(g => !coversGlob(mine, g));
    if (beyond.length) return this.fail(2, `${r.ctr} delivers ${beyond.join(', ')}, which ${this.root.name} does not write — hand it to an agent that writes it`);
    if (!cx.table.transition(r.ctr, 'blocked', 'assigned', { assignee: this.root.name })) return this.fail(4, `${r.ctr} changed meanwhile — read it: ${this.cmd} contract get ${r.ctr}`);
    this.out(`${r.ctr}  taken by ${this.root.name} — work in ${cx.ws().path(r.ctr)}`);
    this.out(`why it was blocked: ${r.reason}`);
    this.out(`# when done: ${this.cmd} contract deliver ${r.ctr}`);
    return 0;
  }

  /** `merge` — the lead folds a delivered instance into the round's result, as soon as it is delivered; a conflict names its files and who may win. */
  private contractMerge(cx: ContractCx, args: string[]): number {
    if (cx.lead !== this.root.name) return this.fail(2, `only the lead (${cx.lead}) merges`);
    const r = this.instance(cx, args[0], 'merge <ctr-id> [--prefer ours|theirs]');
    if (!r) return this.lastCode;
    if (r.state === 'blocked') return this.fail(2, `${r.ctr} is blocked — take it over (${this.cmd} contract take ${r.ctr}), finish it in its copy, deliver it, then merge`);
    if (r.state !== 'delivered') return this.fail(2, `${r.ctr} is ${r.state} — only a delivered instance is merged`);
    const waiting = r.depends.split(',').filter(Boolean).filter(d => cx.table.get(d)?.state !== 'merged');
    if (waiting.length) return this.fail(3, `${r.ctr} depends on ${waiting.map(d => `${d} (${cx.table.get(d)?.state ?? '?'})`).join(', ')} — merge ${waiting.length > 1 ? 'those' : 'that'} first`);
    const prefer = flagValue(args.slice(1), '--prefer');
    if (prefer !== undefined && prefer !== 'ours' && prefer !== 'theirs') return this.fail(2, `--prefer takes ours (keep what is merged) or theirs (take ${r.ctr}'s)`);
    if (r.dispatched_at) {
      const m = cx.ws().merge(r.ctr, prefer);
      if (!m.merged) return this.fail(3, `${r.ctr} conflicts with what is merged in ${m.conflicts.join(', ')} — merge again with --prefer ours (keep what is merged) or --prefer theirs (take ${r.ctr}'s)`);
    }
    if (!cx.table.transition(r.ctr, 'delivered', 'merged')) return this.fail(4, `${r.ctr} changed meanwhile — read it: ${this.cmd} contract get ${r.ctr}`);
    this.out(`${r.ctr}  merged`);
    if (r.left_out) this.out(`left out: ${r.left_out} — why: ${r.why} — look at it, or let it be: ${this.cmd} contract get ${r.ctr}`);
    return 0;
  }

}

/** A contract's issues on one line — null when there are none. */
function issuesText(issues: ReturnType<typeof validateRecord>): string | null {
  return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
}

/** Why a value cannot be checked: what holds it is typed with a template this agent was not compiled with. */
function notCompiled(what: string, template: string): string {
  return `\`${what}\` is shaped as \`${template}\`, a template not compiled into this agent`;
}

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

function letters(options: string[]): string[] {
  return options.map((_, i) => String.fromCharCode(97 + i));
}

function matches(block: ApBlock, key: string, op: string, val: string): boolean {
  if (key === 'tag') {
    const tag = val.replace(/^#/, '');   // written `#security` in the source, stored bare
    return op === '=' ? block.tags.includes(tag) : block.tags.some(t => t.toLowerCase().includes(tag.toLowerCase()));
  }
  const value = key === 'kind' ? block.kind : key === 'name' ? block.name : block.about ?? '';
  return op === '=' ? value === val : value.toLowerCase().includes(val.toLowerCase());
}

/** Every reference a block's data holds — any `{ kind, target, id }` object — once per target. */
function uniqueRefs(data: unknown): ApRef[] {
  const found = new Map<string, ApRef>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.target === 'string' && typeof o.kind === 'string' && 'id' in o) {
      if (!found.has(o.target)) found.set(o.target, o as unknown as ApRef);
      return;
    }
    Object.values(o).forEach(walk);
  };
  const { args, body } = data as { args?: unknown; body?: unknown };
  walk(args);
  walk(body);
  return [...found.values()];
}
