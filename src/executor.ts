// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Executors (I2) — who carries out a line. A line names it by its verb, a
 * condition head by its stars:
 *
 *   DO       the agent          no mark
 *   ASK      a delegate         `*`  (`IF*`, `UNTIL*`)
 *   COMPUTE  a program          `**` (`IF**`, `UNTIL**`)
 *
 * `ASK … BY <agent>` hands the line to an agent of the project: a standalone
 * agent or a team — a team member only from inside its own team, since a
 * team's routing is for whoever comes from outside. This module holds the
 * checks that need the whole project; the forms themselves are the lexer's,
 * the builder's and the vocabulary check's.
 */
import type { ApDocument } from './apdoc/document.js';
import type { ApBlock } from './apdoc/block.js';
import type { ApLine, ApNode } from './apdoc/types.js';
import type { LintError } from './lint.js';
import { lex } from './lexer.js';
import { EXPORT_MODIFIER } from './blockTypes.js';
import { readsOf, constantOf } from './vars.js';
import { DEFAULT_ROUNDS, checkedVars } from './check.js';
import { addressName, shortId } from './apdoc/ids.js';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { DISTILLED_DIR } from './apx/paths.js';

/** The ranks of the executors — a line or a head may raise its enclosing one, never lower it. */
export const AGENT = 0, DELEGATE = 1, PROGRAM = 2;

/**
 * A block head word and its executor mark: `PROCEDURE**` → `{ word: 'PROCEDURE',
 * executor: 2 }`; a word without stars → executor 0. The one reading of the
 * mark every header parser shares (lexer, parseBlocks, inline headers, lint).
 */
export function splitExecutorMark(word: string): { word: string; executor: number } {
  const m = word.match(/^(.*?)(\*{1,2})$/);
  return m ? { word: m[1], executor: m[2].length } : { word, executor: 0 };
}

/**
 * A `COMPUTE <name>:` head: a procedure a program carries out, written in three
 * required sections — `REQUIRE:` (when the script refuses), `RETURN AS <template>:`
 * (the computation and its result's shape), `ENSURE:` (guarantees, which become
 * tests). The one place a COMPUTE block becomes a procedure: every consumer
 * past the parser (index, imports, definitions) sees a PROCEDURE**.
 */
export function computeHead(key: string): { key: string; executor: number } | null {
  return key === 'COMPUTE' ? { key: 'PROCEDURE', executor: PROGRAM } : null;
}

/** The sections of a COMPUTE block, in their order. */
export const COMPUTE_SECTIONS = ['REQUIRE', 'RETURN', 'ENSURE'] as const;

/**
 * The rules on top of a COMPUTE block — how its script is written (`NEVER read
 * the clock`), never a step it carries out: what comes before its RETURN, by
 * source line. Empty for any other block.
 */
export function scriptRuleLines(block: ApBlock): Set<number> {
  if (!block.require) return new Set();
  return new Set(block.body.slice(0, block.shapePos ?? 0).flatMap(n => (n.type === 'directive' && n.pos?.line ? [n.pos.line] : [])));
}

/** The template a COMPUTE block's `RETURN AS <template>:` head names (given what follows RETURN) — null when it names none. */
export function returnShape(head: string): string | null {
  return head.trim().match(/^AS\s+(\S+)$/)?.[1] ?? null;
}

/** The verb's own executor rank: ASK a delegate, COMPUTE a program — any other line inherits. */
export function verbRank(keyword: string): number | null {
  return keyword === 'ASK' ? DELEGATE : keyword === 'COMPUTE' ? PROGRAM : null;
}

/** An agent of the project and the team it belongs to (null: standalone). */
export interface AgentIndexEntry {
  name: string;
  team: string | null;
}

/**
 * The `ASK … BY <name>` lines of a document whose agent is none the line may
 * name: unknown, or a member of another team than the asking agent's.
 */
export function askTargetErrors(doc: ApDocument, index: readonly AgentIndexEntry[], ownTeam: string | null): LintError[] {
  const teams = new Set(index.map(a => a.team).filter((t): t is string => t !== null));
  const errors: LintError[] = [];
  for (const { node, block } of doc.nodes()) {
    if (node.type !== 'directive' || node.keyword !== 'ASK' || !node.by) continue;
    const name = node.by;
    if (teams.has(name)) continue;
    const agent = index.find(a => a.name === name);
    const message = !agent
      ? `unknown agent \`${name}\` — ASK … BY names a standalone agent or a team of the project`
      : agent.team !== null && agent.team !== ownTeam
        ? `BY ${name}: \`${name}\` is a member of team \`${agent.team}\` — ASK names a standalone agent, a team, or a member of its own team`
        : null;
    if (message) errors.push({ file: block.source?.file ?? '', line: node.pos?.line ?? 0, message });
  }
  return errors;
}

/** The mark on a `PROCEDURE* <name>:` header line a legacy module keeps in its body — 0 when none. */
export function headerExecutorOf(body: string, name: string): number {
  for (const t of lex(body)) {
    if (t.kind === 'keyword' && t.keyword === 'PROCEDURE' && t.rest.replace(/:$/, '').trim() === name) return t.executor ?? 0;
  }
  return 0;
}

/** Who carries out a document line: a starred condition's own executor, its verb's, or — a DO, a rule — its procedure's. */
export function executorOf(line: Pick<ApLine, 'primitive' | 'block' | 'executor'>): number {
  return line.executor ?? verbRank(line.primitive) ?? (line.block.executor ?? AGENT);
}

/** A rank's mark on a head: none the agent, `*` a delegate, `**` a program. */
export function executorMark(rank: number): string {
  return '*'.repeat(rank);
}

/** A rank as the key of its formulas (`EXECUTOR` in formulas.json): `1` a delegate, `2` a program. */
export function executorKey(rank: number): '1' | '2' {
  return rank === PROGRAM ? '2' : '1';
}

/**
 * Inside a `PROCEDURE*` / `PROCEDURE**`, what would lower the executor: an
 * ASK under a program, a starred condition below the procedure's mark, a RUN
 * of a procedure carried out below it. (A checked condition there is the
 * builder's error: it never becomes a check.)
 */
export function executorErrors(doc: ApDocument): LintError[] {
  const errors: LintError[] = [];
  for (const block of doc.byKind('procedure')) {
    const rank = block.executor ?? AGENT;
    if (rank === AGENT) continue;
    const at = `PROCEDURE${executorMark(rank)} \`${block.name}\``;
    const err = (node: ApNode, message: string) => errors.push({ file: block.source?.file ?? '', line: node.pos?.line ?? 0, message });
    const walk = (nodes: ApNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directive') {
          const own = verbRank(node.keyword);
          if (own !== null && own < rank) err(node, `${node.keyword} is not allowed under ${at} — a line may raise its executor (agent → delegate → program), never lower it`);
          walk(node.body ?? []);
        } else if (node.type === 'if' || node.type === 'until') {
          const kind = node.type === 'if' ? 'IF' : 'UNTIL';
          if (node.executor && node.executor < rank) err(node, `${kind}${executorMark(node.executor)} is not allowed under ${at} — a condition may raise its executor (agent → delegate → program), never lower it`);
          walk(node.type === 'if' ? [...node.then, ...node.else] : node.body);
        } else if (node.type === 'run') {
          const target = doc.resolve(node.ref);
          if (target?.kind === 'procedure' && (target.executor ?? AGENT) < rank) {
            err(node, `RUN ${target.name}: under ${at} only a PROCEDURE${executorMark(rank)}${rank === DELEGATE ? ' or PROCEDURE**' : ''} may be run — ${rank === PROGRAM ? 'a program cannot stop for the agent' : 'a delegate cannot hand the work back'}`);
          }
        } else if ('body' in node && Array.isArray(node.body)) {
          walk(node.body as ApNode[]);
        }
      }
    };
    walk(block.body);
  }
  return errors;
}

/**
 * The contract of one piece carried out away from the agent — a delegate or a
 * program receives `input` and answers `output`, nothing else (context
 * isolated). One per ASK / COMPUTE line, starred condition and starred
 * procedure (a COMPUTE block included); a line inside a starred procedure that
 * does not raise its executor is part of the procedure's own contract.
 */
export interface ApExecutorSpec {
  /** 1 a delegate, 2 a program. */
  executor: number;
  /** What is carried out: a line, a condition, or a whole procedure. */
  site: 'line' | 'condition' | 'procedure';
  /** The line's text, the condition, or the procedure's name. */
  text: string;
  /** `ASK … BY <agent>`: who it is handed to; absent = the default delegate. */
  by?: string;
  /**
   * One key per `{{x}}` read — the variables, whose values the session holds,
   * and the constants, whose values are known now — plus `in`: the LENS-IN
   * template a procedure takes.
   */
  input: { vars: string[]; constants: Record<string, string>; in?: string };
  /** The INTO variable and its template, the procedure's AS template, or `holds` for a condition. */
  output: { into?: string; template?: string; holds?: true };
  /** An UNTIL's condition: the rounds the loop runs at most (`checks.rounds`). */
  rounds?: number;
  /**
   * A program's folder under `distilled/` (`dst-…`): a hash of what it carries out and
   * of its contract's templates — any edit gives a new folder.
   */
  program?: string;
  /** A procedure's address: how a new version of its program finds the one before it. */
  lineage?: string;
}

/**
 * The contracts of every piece a delegate or a program carries out, by id
 * (`exe-…`) — each node and block it belongs to marked with that id.
 * `templateSources` gives a template's source and its nested ones', so a
 * program's folder changes with its contract.
 */
export function executorSpecs(
  doc: ApDocument, constants: Record<string, string>, agent: string, templateSources: (name: string) => string[] = () => [],
  rounds = DEFAULT_ROUNDS,
): Record<string, ApExecutorSpec> {
  const specs: Record<string, ApExecutorSpec> = {};
  // A piece's input: the variables it reads (as a checked condition's), and the constants with their values.
  const inputOf = (texts: string[]) => {
    const text = texts.join('\n');
    const known: Record<string, string> = {};
    for (const { name, field } of readsOf(text)) {
      const value = field ? undefined : constantOf(constants, name);
      if (value !== undefined) known[name] = value;
    }
    return { vars: checkedVars(text, name => constantOf(constants, name) !== undefined), constants: known };
  };
  const varTemplate = (name: string) => {
    const type = (doc.byKind('var').find(b => b.name === name) as (ApBlock & { type?: { target: string } | null }) | undefined)?.type;
    return type ? addressName(type.target) : undefined;
  };
  const add = (block: ApBlock, spec: ApExecutorSpec, texts: string[], mark: { exe?: string }) => {
    const id = shortId('exe', `${agent}\n${block.address}\n${spec.site}\n${spec.text}`);
    if (spec.executor === PROGRAM) {
      const templates = [spec.input.in, spec.output.template].filter((t): t is string => !!t).flatMap(templateSources);
      spec.program = shortId('dst', [spec.site, ...texts, JSON.stringify(spec.input), JSON.stringify(spec.output), ...templates].join('\n\u0000\n'));
    }
    specs[id] = spec;
    mark.exe = id;
  };
  for (const block of doc.byKind('procedure')) {
    if (!block.executor) continue;
    const texts = [...walkTexts(block.require ?? [], 'REQUIRE'), ...walkTexts(block.body), ...walkTexts(block.ensure ?? [], 'ENSURE')];
    add(block, {
      executor: block.executor, site: 'procedure', text: block.name,
      input: { ...inputOf(texts), ...(block.lensIn ? { in: addressName(block.lensIn.ref.target) } : {}) },
      output: block.shape ? { template: addressName(block.shape.ref.target) } : {},
      lineage: block.address,
    }, texts, block);
  }
  for (const { node, block } of doc.nodes()) {
    const own = node.type === 'directive' ? verbRank(node.keyword) : node.type === 'if' || node.type === 'until' ? node.executor ?? null : null;
    if (!own || (block.executor ?? AGENT) >= own) continue;   // the procedure's own work
    if (node.type === 'directive') {
      const into = node.into ? addressName(node.into.target) : undefined;
      const template = into ? varTemplate(into) : undefined;
      add(block, {
        executor: own, site: 'line', text: node.text, ...(node.by ? { by: node.by } : {}),
        input: inputOf([node.text]), output: { ...(into ? { into } : {}), ...(template ? { template } : {}) },
      }, [`${node.keyword} ${node.text}`], node);
    } else if (node.type === 'if' || node.type === 'until') {
      add(block, {
        executor: own, site: 'condition', text: node.condition, input: inputOf([node.condition]), output: { holds: true },
        ...(node.type === 'until' ? { rounds } : {}),
      }, [node.condition], node);
    }
  }
  return specs;
}

/** Every line and condition of a body, at any depth, as written — its keyword with it, under its section. */
function* walkTexts(nodes: ApNode[], section = ''): Generator<string> {
  const at = section ? `${section} ` : '';
  for (const n of nodes) {
    if (n.type === 'directive') { yield `${at}${n.keyword} ${n.text}`; yield* walkTexts(n.body ?? [], section); }
    else if (n.type === 'if') { yield `${at}IF ${n.condition}`; yield* walkTexts(n.then, section); if (n.else.length) { yield `${at}ELSE`; yield* walkTexts(n.else, section); } }
    else if (n.type === 'until') { yield `${at}UNTIL ${n.condition}`; yield* walkTexts(n.body, section); }
    else if ('body' in n && Array.isArray(n.body)) yield* walkTexts(n.body as ApNode[], section);
  }
}

/**
 * A program's folder, from the project root: `distilled/<dst-id>/` holds its
 * `manifest.json` (version, previous folder, timeout), the script and its
 * `tests.json`. The agent writes it at the first run; the executable runs it.
 */
export function programDir(id: string): string {
  return `${DISTILLED_DIR}/${id}`;
}

/**
 * The program folders no contract names any more — their piece was edited or
 * removed. Reported, never deleted: they are versioned work, for a human (or
 * the next version's author) to review.
 */
export function orphanPrograms(projectRoot: string, live: ReadonlySet<string>): string[] {
  return programFolders(projectRoot).filter(f => !live.has(f)).map(programDir);
}

/** The program folders (`dst-…`) under the project's `distilled/` — none when it does not exist. */
export function programFolders(projectRoot: string): string[] {
  const dir = resolve(projectRoot, DISTILLED_DIR);
  return existsSync(dir) ? readdirSync(dir).filter(f => /^dst-[0-9a-f]{8}$/.test(f)) : [];
}

/** The builtin procedure that tells the agent how to write a program (templates/library/procedures). */
export const WRITE_PROGRAM = 'write-program';

/** Whether a text holds a line a program carries out — a COMPUTE line or block, a `**` head — as the lexer reads it. */
function holdsProgram(text: string): boolean {
  return lex(text).some(t => {
    if (t.kind !== 'keyword' && t.kind !== 'blockOpener') return false;
    if (t.kind === 'keyword' && (t.keyword === 'COMPUTE' || t.executor === PROGRAM)) return true;
    // `EXPORT COMPUTE …:` / `EXPORT PROCEDURE** …:` — the modifier wraps the head.
    const head = (t.kind === 'keyword' ? String(t.keyword) : t.key) === EXPORT_MODIFIER ? splitExecutorMark(t.rest.split(/\s/)[0] ?? '') : null;
    return !!head && (head.word === 'COMPUTE' || head.executor === PROGRAM);
  });
}

/** Whether a program carries out some of an agent's work: its body's lines, or a procedure it uses. */
export function usesPrograms(agentBody: string, procedures: readonly { body: string; executor?: number }[]): boolean {
  return holdsProgram(agentBody) || procedures.some(p => p.executor === PROGRAM || holdsProgram(p.body));
}
