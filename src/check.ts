// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Checked conditions (I1) — the one place that names one, words its head,
 * builds the judge's question and the state it is asked on.
 *
 *   IF the tests pass:       the agent decides
 *   IF! {{report}} is clean:  the agent sees the condition; a judge decides it, and wins
 *   IF!! {{report}} is clean: a gate — the condition is sealed away from the agent;
 *                             the judge decides, the agent hears only open / closed
 *   UNTIL! / UNTIL!!          the same, as a loop head: repeat until the gate opens,
 *                             at most `rounds` rounds
 *
 * The question is built at compile time from the source (`In the state, <condition>?`)
 * and kept in the apx — never written by the agent. The state is built by the
 * apx at check time from the variables the condition reads, exactly as stored.
 * No imports beyond the formulas and the id rule: the apx engine bundles it.
 */
import { shortId } from './apdoc/ids.js';
import type { ControlKind } from './lexer.js';
import { FORMULAS, fill } from './formulas.js';
import { readsOf, resolveReads, type VarRead } from './vars.js';

/** The round limit written on a loop's head: `UNTIL!! <condition> MAX <n>:` — the one spelling of it. */
const MAX_RE = /^(.*?)\s+MAX\s+(\S+)$/;

/**
 * A head's rest (its colon dropped) split into the condition and its `MAX <n>`:
 * `max` the limit when it is well formed, `bad` the token written when it is
 * not (`MAX 0`, `MAX many`). A head without MAX keeps its text whole.
 */
export function splitMax(rest: string): { condition: string; max?: number; bad?: string } {
  const m = rest.trim().match(MAX_RE);
  if (!m) return { condition: rest.trim() };
  return /^[1-9]\d*$/.test(m[2]) ? { condition: m[1].trim(), max: Number(m[2]) } : { condition: m[1].trim(), bad: m[2] };
}

/**
 * THE rule of MAX: a loop someone other than the agent ends — a judge
 * (`UNTIL!`, `UNTIL!!`), a delegate or a program (`UNTIL*`, `UNTIL**`, or an
 * `UNTIL` under a starred procedure) — writes how many rounds it runs at most;
 * a loop the agent ends takes none, and an IF never has rounds. `bounded` says
 * whether someone else ends the loop. Null when the head is right.
 */
export function maxIssue(kind: CheckKind, head: string, bounded: boolean, split: { max?: number; bad?: string }): string | null {
  if (split.bad !== undefined) return `${head}: MAX takes a whole number of rounds, at least 1 — found \`MAX ${split.bad}\``;
  if (kind === 'IF') return split.max !== undefined ? `${head} takes no MAX — only a loop has rounds` : null;
  if (bounded) return split.max === undefined ? `${head} needs its round limit — write \`${head} <condition> MAX <n>:\`` : null;
  return split.max !== undefined ? `${head} takes no MAX — the agent ends this loop; MAX bounds a loop a judge, a delegate or a program ends (UNTIL!, UNTIL!!, UNTIL*, UNTIL**)` : null;
}

/**
 * A loop's round: its "not yet" answers in a row, the last one included —
 * `answers` oldest first, true = it held. With the limit `rounds`, a run that
 * reached it was a loop the agent left: the next "not yet" starts a new loop
 * at round 1, never "4 of 3" — the same condition is checked again by every
 * task of a session that enters the loop anew.
 */
export function roundOf(answers: boolean[], rounds?: number): number {
  const trailing = answers.length - answers.lastIndexOf(true) - 1;
  return rounds && trailing > 0 ? ((trailing - 1) % rounds) + 1 : trailing;
}

/** What the agent is told after a "not yet" at `round`: do the next round, or — at the limit — stop. */
export function roundLine(round: number, rounds: number, words: { again: string; end: string }): string {
  const C = FORMULAS.keywords.CHECK;
  return fill(round >= rounds ? C.limit : C.nextRound, { round, rounds, ...words });
}

/** The condition heads that take a level — the one list; the lexer reads it. */
export const CHECK_KINDS = ['IF', 'UNTIL'] as const;
export type CheckKind = typeof CHECK_KINDS[number];

/** The levels of a checked head: 1 the agent sees the condition, 2 it is sealed. The lexer reads the highest. */
export const CHECK_LEVELS = [1, 2] as const;
export type CheckLevel = typeof CHECK_LEVELS[number];
export const MAX_CHECK_LEVEL: CheckLevel = CHECK_LEVELS[CHECK_LEVELS.length - 1];

/**
 * What an IF/UNTIL node carries when it is checked: its id, its level, the
 * agent whose apx answers for it (the agent itself, or a flow step's BY agent)
 * and — on an UNTIL — the round limit. Absent on a plain head.
 */
export interface ApCondCheck {
  id: string;
  level: CheckLevel;
  agent: string;
  rounds?: number;
}

/**
 * What the apx keeps of a checked condition its agent answers for — in the
 * document's `meta.checks`, never in a block, so no view of a block shows it.
 */
export interface ApCheckSpec {
  kind: CheckKind;
  level: CheckLevel;
  /** The question the judge is asked, as built at compile time. */
  question: string;
  /** The variables the condition reads, in order of first appearance — the state. */
  vars: string[];
  /** An UNTIL's round limit, as its head wrote it (`MAX <n>`). */
  rounds?: number;
}

const C = FORMULAS.keywords.CHECK;

/**
 * A checked condition's id: `cnd-` + a hash of the agent that answers for it
 * and of the condition as written — editing the text makes a new condition.
 */
export function checkId(agent: string, condition: string): string {
  return shortId('cnd', `${agent}\n${condition.trim()}`);
}

/** How a head reads its condition — or a trigger its moment: `!` levels as written (`IF!!`, `WHEN!`). */
export function checkedKeyword(kind: ControlKind, level: number): string {
  return `${kind}${'!'.repeat(Math.max(level, 0))}`;
}

/**
 * The head line of a checked IF/UNTIL (no trailing colon): the condition and
 * the command whose answer decides it — or, sealed, the command alone.
 * `condition` is the text as the agent reads it; `apx` the command that runs
 * the answering agent's apx.
 */
export function checkHead(kind: CheckKind, check: Pick<ApCondCheck, 'id' | 'level' | 'rounds'>, condition: string, apx: string): string {
  const run = fill(C.run, { apx, id: check.id });
  return fill(C[kind][String(check.level) as '1' | '2'], { head: FORMULAS.keywords[kind].head, condition, run, rounds: check.rounds ?? '' });
}

/**
 * Where a checked head stands — which executable could answer for it:
 * `agent` — an agent's body, or a procedure or role it runs: the agent's apx;
 * `step` — a flow step: its BY agent's apx (null when BY names no agent);
 * `flow` — a flow's own level, between its steps: no one agent (not supported yet);
 * `none` — a standalone file, a team's routing: no executable at all.
 */
export type CheckSite =
  | { at: 'agent'; agent: string }
  | { at: 'step'; agent: string | null }
  | { at: 'flow' }
  | { at: 'none' };

/** What is wrong with a checked head where it stands — a warning when it falls back to the plain head. */
export interface CheckIssue {
  message: string;
  severity?: 'warning';
}

/**
 * The `IF!` of a desugared `WHEN!` (src/desugar.ts): the first line under a
 * trigger, with the trigger's own condition. `parent` is that trigger, and the
 * messages name the head written: `WHEN!`. Structural, since a body rebuilt
 * from the tokens and lexed again keeps no mark.
 */
export function sugaredHead(parent: { keyword: string; condition: string } | null, first: boolean, level: number, condition: string): string | null {
  return parent && first && level === 1 && parent.condition.trim() === condition.trim() ? `${parent.keyword}!` : null;
}

/**
 * THE rule of a checked head (`IF!`, `IF!!`, `UNTIL!`, `UNTIL!!`): who answers
 * for it and with which id, or why no one does. `IF!` with no one to check it
 * reads as `IF`, with a warning; `IF!!` there fails — it could never be sealed.
 * `checks` is the configured judge (only its presence matters here); `rounds`
 * an UNTIL's limit, from its head's `MAX <n>`. Every producer of a head — the
 * document builder, the md of AGENTS.md and standalone files, the source scan
 * of flows.ap and standalone files — asks this function.
 */
export function condCheckOf(
  kind: CheckKind, level: number, condition: string, site: CheckSite, checks: object | null | undefined,
  head = checkedKeyword(kind, level), rounds?: number,
): { check?: ApCondCheck; issue?: CheckIssue } {
  if (level < 1) return {};   // `!IF` is the vocabulary check's error
  const plain = head.replace(/!+$/, '');   // what the head reads as when no one checks it
  const warn = (message: string): { issue: CheckIssue } => ({ issue: { message, severity: 'warning' } });
  const fail = (message: string): { issue: CheckIssue } => ({ issue: { message } });
  if (site.at === 'none') {
    const where = 'checks run in an agent\'s body, a procedure an agent runs, or a flow step whose BY is an agent';
    return level === 1
      ? warn(`${head}: no executable here — the condition is the agent's: it reads as ${plain}; ${where}`)
      : fail(`${head}: no executable here — a sealed condition can never be checked here; ${where}`);
  }
  if (!checks) {
    return level === 1
      ? warn(`${head}: no judge for checked conditions is configured — the condition is the agent's: it reads as ${plain}; to have a judge decide it, add checks: { adapter: 'jev' } to agent-pack.config.mjs`)
      : fail(`${head} needs checks: { adapter: 'jev' } in agent-pack.config.mjs — a sealed condition is decided by a judge, and none is configured`);
  }
  // A checked condition between a flow's steps has no one agent to answer for it — not supported yet.
  if (site.at === 'flow') return fail(`${head} at a flow's own level is not supported yet — put it inside a STEP, where the step's BY agent checks it`);
  if (!site.agent) return fail(`${head}: a checked condition needs the step's agent: BY must name an agent`);
  return {
    check: { id: checkId(site.agent, condition), level: level as CheckLevel, agent: site.agent, ...(kind === 'UNTIL' && rounds ? { rounds } : {}) },
  };
}

/** A template's field, as the question names it. */
export interface CheckField {
  name: string;
  description?: string;
}

/**
 * The variables a condition reads — every read that is no constant, each
 * once, in order of first appearance. A field read (`{{x.slot}}`) is the
 * vocabulary check's error, never a variable here.
 */
export function checkedVars(condition: string, isConstant: (name: string) => boolean): string[] {
  return [...new Set(readsOf(condition).filter(r => !r.field && !isConstant(r.name)).map(r => r.name))];
}

/**
 * The judge's question, built at compile time: `In the state, <condition>?` —
 * a constant's read is its value, a variable's read its name, and a shaped
 * read (`{{x AS t}}`) the name with the template's fields as guidance (the
 * judge gets the whole value of `x`).
 */
export function questionOf(
  condition: string,
  constant: (name: string) => string | undefined,
  fields: (template: string) => CheckField[] | null,
): string {
  const named = (r: VarRead): string => {
    const value = constant(r.name);
    if (value !== undefined) return value;
    const shape = r.template ? fields(r.template) : null;
    if (!r.template || !shape) return r.name;
    const list = shape.map(f => (f.description ? fill(C.field, { name: f.name, description: f.description }) : f.name)).join(C.fieldSeparator);
    return fill(C.shapedRead, { name: r.name, template: r.template, fields: list });
  };
  return fill(C.question, { condition: resolveReads(condition.trim(), named) });
}

/** The state the judge reads: each variable as `### <name>` and its value exactly as stored, a blank line between. */
export function stateOf(values: { name: string; value: string }[]): string {
  return values.map(v => fill(C.state, { name: v.name, value: v.value })).join(C.stateSeparator);
}
