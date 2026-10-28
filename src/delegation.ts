// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Delegation — the one way work is handed to someone else (D46): a line, or a
 * block with its own DO lines, written as
 *
 *   DELEGATE <task> [INTO <var>] [BY <agent | team>] [AS <template>]
 *   FORK     <task> [INTO <var>] [BY <agent>] [AS <template>]
 *   WAIT     <var>, …   |   WAIT ALL
 *
 * The form says how much context is passed: `DELEGATE … BY x` all of it,
 * `DELEGATE … AS t` only what the template holds, `FORK` the conversation
 * itself — a copy of whoever runs it, or `BY y` that agent on it — with
 * what it is handed shaped as `AS t` when it names one. A `~` after
 * the verb (`DELEGATE~`, `FORK~`) starts the work and goes on; `WAIT` takes
 * it back, every piece it names delivered or blocked. In a flow, these are the
 * actions of a STEP: whoever runs the flow carries them out.
 *
 * Structured: what a `~` starts is waited for before the block it is written
 * in ends — a STEP, an IF or ELSE branch, an UNTIL — and its variable is read
 * only after its WAIT.
 *
 * Every reader of these forms — the lexer, the lint, the document builder, the
 * renderers — asks this module. No imports from the compiler: the apx bundles it.
 */
import { splitBy, splitInto, readsOf } from './vars.js';
import { splitList } from './lists.js';
import { FORMULAS, fill } from './formulas.js';

export const DELEGATE_VERB = 'DELEGATE';
export const FORK_VERB = 'FORK';
export const WAIT_VERB = 'WAIT';
/** The verbs that hand work out. */
export const DELEGATION_VERBS = [DELEGATE_VERB, FORK_VERB] as const;
/** The mark after a verb that starts the work without waiting for it: `DELEGATE~`. */
export const ASYNC_MARK = '~';
/** `WAIT ALL`: every piece started in the block. */
export const WAIT_ALL = 'ALL';

export function isDelegationVerb(word: string): boolean {
  return (DELEGATION_VERBS as readonly string[]).includes(word);
}

/** A delegation line, read: the task and what follows it, the `:` that opens its block. */
export interface Delegation {
  verb: string;
  task: string;
  into: string | null;
  by: string | null;
  /** `AS <template>` — the shape of what is handed over; its `!`s the severity, as on any AS. */
  as: { force: number; name: string } | null;
  /** Written `…:` — its DO lines follow, indented. */
  opens: boolean;
}

// `AS`, `AS!`, `AS!!` ending the line; the template may come resolved already (`` `brief` (tpl-…) ``).
const AS_RE = /^(.*?)\s+(AS!{0,2})\s+(`[^`]+`(?:\s+\([a-z]{3}-[0-9a-f]{8}\))?|[A-Za-z0-9][\w:-]*)\s*$/;

/** A line's text and the template its trailing `AS <template>` names — else null. */
export function splitAs(text: string): { text: string; force: number; name: string } | null {
  const m = AS_RE.exec(text);
  return m ? { text: m[1].trim(), force: m[2].length - 2, name: m[3] } : null;
}

/** The parts that may follow a task, in the order they are written. */
const PARTS = ['INTO', 'BY', 'AS'] as const;
type Part = typeof PARTS[number];

/** A delegation line's rest as its parts, taken from its end — whatever their order; `order` says the one written. */
export function parseDelegation(verb: string, rest: string): Delegation & { order: Part[] } {
  let text = rest.trim();
  const opens = text.endsWith(':');
  if (opens) text = text.slice(0, -1).trim();
  let into: string | null = null, by: string | null = null, as: Delegation['as'] = null;
  const order: Part[] = [];
  for (let found = true; found;) {
    found = false;
    const a: ReturnType<typeof splitAs> = as ? null : splitAs(text);
    if (a) { as = { force: a.force, name: a.name }; text = a.text; order.unshift('AS'); found = true; continue; }
    const b: ReturnType<typeof splitBy> = by ? null : splitBy(text);
    if (b) { by = b.name; text = b.text; order.unshift('BY'); found = true; continue; }
    const i: ReturnType<typeof splitInto> = into ? null : splitInto(text);
    if (i) { into = i.name; text = i.text; order.unshift('INTO'); found = true; }
  }
  return { verb, task: text, into, by, as, opens, order };
}

/** What is wrong with a delegation line as written — its order, a part its verb takes none of. */
export function delegationLineErrors(verb: string, rest: string): string[] {
  const d = parseDelegation(verb, rest);
  const errors: string[] = [];
  const shape = `${verb} <task> INTO <name> BY <agent> AS <template>`;
  // The parts in their order: INTO, then BY, then AS — the first one out of place is named.
  const misplaced = d.order.find((part, k) => k > 0 && PARTS.indexOf(part) < PARTS.indexOf(d.order[k - 1]));
  if (misplaced === 'INTO') errors.push(`${verb}: INTO comes right after the task — write \`${shape}\``);
  else if (misplaced === 'BY') errors.push(`${verb}: BY comes after INTO, before AS — write \`${shape}\``);
  if (d.task === '') errors.push(`${verb} needs its task — \`${shape}\``);
  return errors;
}

/**
 * A delegation line's text as rendered — who it goes to, with what context,
 * whether it runs in the background; a WAIT's what it waits for. `agent` is
 * who a DELEGATE goes to (its BY, or the default delegate); `shaped` its AS
 * template, named with its reference; `contract` when an `exe-…` contract says
 * what is handed over (an agent's own DELEGATE). Any other line: its text.
 */
export function delegationText(n: {
  keyword: string; text: string; agent?: string; async?: boolean; shaped?: { name: string; ref: string }; contract?: boolean;
  /** The apx command the lines name, and the registry ids: a background piece's own, a WAIT's — absent, no commands. */
  apx?: string; work?: string; waits?: string[];
}): string {
  const K = FORMULAS.keywords;
  const started = n.apx && n.work ? fill(K.DELEGATE.started, { apx: n.apx, id: n.work }) : '';
  const background = n.async ? K.DELEGATE.background + started : '';
  if (n.keyword === DELEGATE_VERB && n.agent) {
    // A line with a contract (`exe-…`) hands over its input, as the contract says: no context phrase.
    const context = n.contract ? '' : n.shaped ? fill(K.DELEGATE.shaped, { name: n.shaped.name, ref: n.shaped.ref }) : K.DELEGATE.full;
    return fill(K.DELEGATE.to, { text: n.text, agent: n.agent, context, background });
  }
  if (n.keyword === FORK_VERB) {
    // A fork inherits the conversation; an AS says the shape of what it is handed on top of it (D58).
    const shaped = n.shaped ? fill(K.FORK.shaped, { name: n.shaped.name, ref: n.shaped.ref }) : '';
    return n.agent ? fill(K.FORK.agent, { text: n.text, agent: n.agent, shaped, background }) : fill(K.FORK.self, { text: n.text, shaped, background });
  }
  if (n.keyword === WAIT_VERB) {
    const wait = parseWait(n.text);
    const text = 'all' in wait ? K.WAIT.all : fill(K.WAIT.named, { names: wait.names.map(name => `\`${name}\``).join(', ') });
    if (!n.apx || !n.waits?.length) return text;
    return text + fill(K.WAIT.run, { apx: n.apx, ids: n.waits.join(' '), max: wait.max ? fill(K.WAIT.max, { max: wait.max }) : '' });
  }
  return n.text;
}

/** `MAX <duration>` ending a WAIT: how long it waits at most, over the project's `wait.max`. */
const WAIT_MAX_RE = /^(.*?)\s+MAX\s+(\S+)\s*$/;
/** A duration: a whole number and its unit — seconds, minutes, hours. */
const DURATION_RE = /^([1-9]\d*)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** A duration (`30m`) in milliseconds — null when it is not one. */
export function parseDuration(text: string): number | null {
  const m = DURATION_RE.exec(text.trim());
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null;
}

/** What a duration is, for a message. */
export const DURATION_FORM = 'a whole number and its unit — `90s`, `10m`, `2h`';

/** A WAIT line's rest: the variables it waits for, or every piece of its block — and its `MAX <duration>`, null when it has none. */
export function parseWait(rest: string): ({ all: true } | { names: string[] }) & { max: string | null } {
  let text = rest.trim();
  const m = WAIT_MAX_RE.exec(text);
  const max = m ? m[2] : null;
  if (m) text = m[1].trim();
  return text === WAIT_ALL ? { all: true, max } : { names: splitList(text), max };
}

/** What is wrong with a WAIT line as written: a MAX that is no duration. */
export function waitLineErrors(rest: string): string[] {
  const { max } = parseWait(rest);
  if (max !== null && parseDuration(max) === null) return [`WAIT … MAX ${max}: a duration is ${DURATION_FORM}`];
  if (/\bMAX\s*$/.test(rest.trim())) return [`WAIT … MAX: say how long — ${DURATION_FORM}`];
  return [];
}

/** A delegation a flow starts in the background, as the apx keeps it (`meta.background`): where it is written and who it goes to. */
export interface ApBackgroundWork {
  flow: string;
  step: string;
  verb: string;
  task: string;
  /** Its INTO variable — null when it fills none. */
  into: string | null;
  /** Its BY — null: a fork of whoever runs the flow. */
  by: string | null;
}

/** The lines of a flow the binding reads and marks — the document's nodes, loosely. */
interface FlowNode {
  type: string;
  keyword?: string;
  text?: string;
  title?: string;
  async?: true;
  by?: string;
  into?: { target: string };
  /** Set here: a background delegation's id (`dlg-…`). */
  work?: string;
  /** Set here, on a WAIT: the ids of what it takes back. */
  waits?: string[];
  body?: FlowNode[];
  then?: FlowNode[];
  else?: FlowNode[];
  steps?: FlowNode[];
}

/**
 * Bind a flow's background work: each `DELEGATE~` / `FORK~` gets its id
 * (`dlg-<8 hex>`, from the flow and its place in it), each WAIT the ids of
 * what it takes back — what it names, or every piece its block started. The
 * scopes are the ones the concurrency check reads: a STEP, an IF or ELSE
 * branch, an UNTIL. Returns what the apx keeps of each, by id.
 */
export function bindBackgroundWork(flow: { address: string; name: string; body: readonly unknown[] }, idOf: (text: string) => string): Record<string, ApBackgroundWork> {
  const found: Record<string, ApBackgroundWork> = {};
  let n = 0;
  const nameOf = (into: { target: string } | undefined) => (into ? into.target.split('/').pop() ?? null : null);
  const walk = (nodes: readonly FlowNode[], step: string, running: { id: string; name: string | null }[]): void => {
    for (const node of nodes) {
      if (node.type === 'directive' && isDelegationVerb(node.keyword ?? '') && node.async) {
        const id = idOf(JSON.stringify([flow.address, n++]));
        node.work = id;
        running.push({ id, name: nameOf(node.into) });
        found[id] = { flow: flow.name, step, verb: node.keyword!, task: node.text ?? '', into: nameOf(node.into), by: node.by ?? null };
      } else if (node.type === 'directive' && node.keyword === WAIT_VERB) {
        const wait = parseWait(node.text ?? '');
        const taken = 'all' in wait ? [...running] : running.filter(r => r.name !== null && wait.names.includes(r.name));
        for (const r of taken) running.splice(running.indexOf(r), 1);
        node.waits = taken.map(r => r.id);
      }
      // A step, a branch, a loop body: a scope of its own. Any other body (a decorator's) is the enclosing one's.
      if (node.type === 'step') walk(node.body ?? [], node.title ?? '', []);
      else if (node.type === 'if') { walk(node.then ?? [], step, []); walk(node.else ?? [], step, []); }
      else if (node.type === 'until') walk(node.body ?? [], step, []);
      else if (node.type === 'parallel') walk(node.steps ?? [], step, []);
      else if (node.body && node.type === 'directive' && !isDelegationVerb(node.keyword ?? '')) walk(node.body, step, running);
    }
  };
  walk(flow.body as FlowNode[], '', []);
  return found;
}

/** A node of the indent tree the checks walk (src/bundlers/renderTree.ts buildTree). */
export interface DelegationTreeNode {
  token: { kind: string; keyword?: string; rest?: string; raw?: string; line: number; async?: boolean };
  children: DelegationTreeNode[];
}

/** The blocks a `~` is waited for inside of. */
const SCOPE_KEYS = new Set(['STEP', 'IF', 'ELSE', 'UNTIL']);

/**
 * The structured-concurrency checks of a body, as an indent tree: a `~` and
 * a WAIT stand in a flow STEP only; every `~` is waited for before its block
 * ends; a WAIT names what a `~` of its block started; a started variable is
 * read only after its WAIT. One message per problem, with its line.
 */
export function concurrencyErrors(tree: readonly DelegationTreeNode[]): { line: number; message: string }[] {
  const errors: { line: number; message: string }[] = [];
  const at = (line: number, message: string) => errors.push({ line, message });

  interface Started { name: string | null; line: number }
  // `pending`: the scopes enclosing a point, outermost first — each with what it started and has not waited for.
  const walk = (nodes: readonly DelegationTreeNode[], inStep: boolean, pending: Started[][], key: string | null): void => {
    const own: Started[] = [];
    const scopes = key && SCOPE_KEYS.has(key) && inStep ? [...pending, own] : pending;
    const mine = scopes[scopes.length - 1] ?? own;
    for (const node of nodes) {
      const t = node.token;
      const raw = t.raw ?? '';
      const kw = t.kind === 'keyword' ? t.keyword ?? '' : '';
      // A read of what is still running.
      for (const { name } of readsOf(raw)) {
        const running = scopes.flat().find(s => s.name === name);
        if (running && !(kw === WAIT_VERB)) at(t.line, `\`{{${name}}}\` is read before its WAIT — it was started with ${ASYNC_MARK} at line ${running.line}: write \`WAIT ${name}\` above this line`);
      }
      if (kw === FORK_VERB && !inStep) at(t.line, 'FORK hands work to a fork of whoever runs a flow — it stands in a flow STEP; here, write DELEGATE');
      if (kw === DELEGATE_VERB && inStep && !parseDelegation(kw, t.rest ?? '').by) {
        at(t.line, 'DELEGATE in a flow names who it goes to — end it with `BY <agent | team>`');
      }
      if (isDelegationVerb(kw) && t.async) {
        if (!inStep) at(t.line, `${kw}${ASYNC_MARK}: starting work without waiting for it is a flow STEP's — here, write ${kw} and wait for it`);
        else mine.push({ name: parseDelegation(kw, t.rest ?? '').into, line: t.line });
      } else if (kw === WAIT_VERB) {
        if (!inStep) at(t.line, 'WAIT takes back what a STEP started with ~ — it stands in a flow STEP');
        else {
          const wait = parseWait(t.rest ?? '');
          if ('all' in wait) {
            if (mine.length === 0) at(t.line, `WAIT ALL: nothing was started with ${ASYNC_MARK} in this block — drop the WAIT`);
            mine.length = 0;
          } else {
            for (const name of wait.names) {
              const k = mine.findIndex(s => s.name === name);
              if (k >= 0) mine.splice(k, 1);
              else at(t.line, `WAIT ${name}: no ${DELEGATE_VERB}${ASYNC_MARK} or ${FORK_VERB}${ASYNC_MARK} of this block fills \`${name}\` — a WAIT takes back what its own block started`);
            }
          }
        }
      }
      if (node.children.length > 0) walk(node.children, inStep || kw === 'STEP', scopes, kw || null);
    }
    if (scopes !== pending) {
      for (const s of own) at(s.line, `started with ${ASYNC_MARK} and never waited for — WAIT ${s.name ?? WAIT_ALL} before its ${key} ends`);
    }
  };
  walk(tree, false, [], null);
  return errors;
}
