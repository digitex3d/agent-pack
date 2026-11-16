// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Delegation — the one way work is handed to someone else (D46): a line, or a
 * block with its own DO lines, written as
 *
 *   DELEGATE <task> [INTO <var>] [BY <agent | team>] [AS <template>]
 *   FORK     <task> [INTO <var>] [BY <agent>] [AS <template>]
 *   WAIT     <var>, …   |   WAIT ALL
 *   MARK     <criterion> INTO <var> AS <spec> [MAX <n>] [WITHIN <domain>]
 *   DELEGATE <var> BY <agent | harness:agent> — the contracts a MARK filled <var> with
 *   EACH     <item> IN {{<list>}} MAX <n>:  — its DELEGATE / FORK lines once per element
 *
 * The form says how much context is passed: `DELEGATE … BY x` all of it,
 * `DELEGATE … AS t` only what the template holds, `FORK` the conversation
 * itself — a copy of whoever runs it, or `BY y` that agent on it — with
 * what it is handed shaped as `AS t` when it names one. A `~` after
 * the verb (`DELEGATE~`, `FORK~`) starts the work and goes on; `WAIT` takes
 * it back, every piece it names delivered or blocked. In a flow, these are the
 * actions of a STEP: whoever runs the flow carries them out.
 *
 * A contract is a promise (D16–18): `MARK` binds zones of the code to a spec
 * and leaves each one waiting; `DELEGATE <var> BY <agent>` starts every one of
 * them, one each, all at once, in copies of their own — `~` and WAIT as for any
 * delegation. One agent for the whole list: other agents, other MARKs (D64).
 *
 * One run per element (D56): an `EACH` block holds delegations only; each runs
 * once per element of a list of data, all the runs at once — without `~` the
 * flow waits for every run, with `~` it goes on until the WAIT. An INTO inside
 * collects one result per run, a list. A list of contracts is no EACH's: it is
 * delegated as it is.
 *
 * Structured: what a `~` starts is waited for before the block it is written
 * in ends — a STEP, an IF or ELSE branch, an UNTIL — and its variable is read
 * only after its WAIT.
 *
 * Every reader of these forms — the lexer, the lint, the document builder, the
 * renderers — asks this module. No imports from the compiler: the apx bundles it.
 */
import { splitBy, splitInto, readsOf, parseEachHead } from './vars.js';
import { splitList } from './lists.js';
import { DECORATOR_MARK, WITHIN_DECORATOR } from './decorators.js';
import { FORMULAS, fill } from './formulas.js';

export const DELEGATE_VERB = 'DELEGATE';
/** An agent's question to a delegate: a contract, its answer shaped by its INTO variable's template. */
export const ASK_VERB = 'ASK';
export const FORK_VERB = 'FORK';
export const WAIT_VERB = 'WAIT';
export const MARK_VERB = 'MARK';
/** The verbs that hand something out: a question (ASK, an agent's), work (DELEGATE and FORK, a flow's and a unit's). */
export const DELEGATION_VERBS = [ASK_VERB, DELEGATE_VERB, FORK_VERB] as const;
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
  const match = AS_RE.exec(text);
  return match ? { text: match[1].trim(), force: match[2].length - 2, name: match[3] } : null;
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
    const asPart: ReturnType<typeof splitAs> = as ? null : splitAs(text);
    if (asPart) { as = { force: asPart.force, name: asPart.name }; text = asPart.text; order.unshift('AS'); found = true; continue; }
    const byPart: ReturnType<typeof splitBy> = by ? null : splitBy(text);
    if (byPart) { by = byPart.name; text = byPart.text; order.unshift('BY'); found = true; continue; }
    const intoPart: ReturnType<typeof splitInto> = into ? null : splitInto(text);
    if (intoPart) { into = intoPart.name; text = intoPart.text; order.unshift('INTO'); found = true; }
  }
  return { verb, task: text, into, by, as, opens, order };
}

/** What is wrong with a delegation line as written — its order, a part its verb takes none of. */
export function delegationLineErrors(verb: string, rest: string): string[] {
  const delegation = parseDelegation(verb, rest);
  const errors: string[] = [];
  // A question takes no AS: its answer takes its INTO variable's template.
  const shape = verb === ASK_VERB ? `${verb} <question> INTO <name> BY <agent>` : `${verb} <task> INTO <name> BY <agent> AS <template>`;
  // The parts in their order: INTO, then BY, then AS — the first one out of place is named.
  const misplaced = delegation.order.find((part, index) => index > 0 && PARTS.indexOf(part) < PARTS.indexOf(delegation.order[index - 1]));
  if (misplaced === 'INTO') errors.push(`${verb}: INTO comes right after the task — write \`${shape}\``);
  else if (misplaced === 'BY') errors.push(`${verb}: BY comes after INTO, before AS — write \`${shape}\``);
  if (delegation.task === '') errors.push(`${verb} needs its task — \`${shape}\``);
  return errors;
}

/** The mark between a harness and its agent in a BY: `codex:reviewer`. */
export const HARNESS_SEP = ':';

/** A BY naming an agent of another harness, split — null when it names no harness. */
export function splitHarness(by: string): { harness: string; agent: string } | null {
  const at = by.indexOf(HARNESS_SEP);
  return at > 0 && at < by.length - 1 ? { harness: by.slice(0, at), agent: by.slice(at + 1) } : null;
}

/** A recipe as the compiler keeps it in the document (`meta.harnesses`): what the apx fills at `delegate start`. */
export interface HarnessInvocation {
  /** The command line, its slots `{project}`, `{agent}`, `{prompt}`, `{answer}`, `{shape}`, `{model}`. */
  command: string;
  /** How to run it: the rules of its slots, in order. */
  rules: string[];
  cli: string;
  /** The flag that binds the answer to a JSON Schema, `{schema}` its file — absent when the CLI has none. */
  shape?: string;
  /** The flag that picks the model, `{model}` its id — absent when the CLI has none. */
  model?: string;
  /** The model of each agent of the project on this harness — the one its `BUDGET` tier maps to; an agent left out runs on the harness's default. */
  models?: Record<string, string>;
  /** Files the copy is given from the working folder (`{agent}` its name) — never delivered back. */
  carry: string[];
  /** The prompt's first line, `{agent}` its name — absent when the CLI picks the agent itself. */
  intro?: string;
  /** The file of the agent's compiled definition, from the project root (`{agent}` its name) — the prompt opens with it; absent when the harness reads agent files of its own. */
  definition?: string;
  /** How the command reaches the harness when not by its own CLI — `acp`. */
  transport?: string;
}

/** The file of an agent's compiled definition, from the project root, when its harness takes it in the prompt — null when it reads agent files of its own. */
export function definitionPath(inv: Pick<HarnessInvocation, 'definition'>, agent: string): string | null {
  return inv.definition ? fill(inv.definition, { agent }) : null;
}

/**
 * What a prompt that hands a task to `agent` on another harness opens with:
 * its compiled definition (`definition`, its text) when the harness has no
 * agent files of its own, then the harness's intro naming the agent — the one
 * way the apx and `agent-pack ask` both write it.
 */
export function agentPromptHead(inv: Pick<HarnessInvocation, 'intro'>, agent: string, definition: string | null): string[] {
  return [
    ...(definition !== null ? [`# Who you are — the definition of the agent \`${agent}\``, '', definition.trimEnd(), '', '# Your task', ''] : []),
    ...(inv.intro ? [fill(inv.intro, { agent }), ''] : []),
  ];
}

/** The keywords whose words an adapter may give its own (`renderings.<KEYWORD>.<key>`): how its harness hands work out and waits. */
const PHRASED = [DELEGATE_VERB, FORK_VERB, WAIT_VERB] as const;
type Phrased = typeof PHRASED[number];
/** An adapter's own words for the delegation lines, by keyword then key — over the formulas. */
export type DelegationPhrases = Record<string, Record<string, string>>;

/** The adapter's words for the delegation lines, out of all its renderings — null when it gives none. */
export function delegationPhrases(renderings: Record<string, Record<string, string>> | undefined): DelegationPhrases | null {
  const out: DelegationPhrases = {};
  for (const keyword of PHRASED) if (renderings?.[keyword]) out[keyword] = renderings[keyword];
  return Object.keys(out).length ? out : null;
}

/** The formulas of the delegation lines, with an adapter's words over them. */
function phrasesOf(phrases: DelegationPhrases | undefined): typeof FORMULAS.keywords {
  const keywords = FORMULAS.keywords;
  if (!phrases) return keywords;
  const over = <T extends Phrased>(keyword: T) => ({ ...keywords[keyword], ...phrases[keyword] }) as typeof keywords[T];
  return { ...keywords, DELEGATE: over(DELEGATE_VERB), FORK: over(FORK_VERB), WAIT: over(WAIT_VERB) };
}

/**
 * A delegation line's text as rendered — who it goes to, with what context,
 * whether it runs in the background; a WAIT's what it waits for. `agent` is
 * who a DELEGATE goes to (its BY, or the default delegate); `shaped` its AS
 * template, named with its reference. An ASK says whom it asks: its contract
 * (`exe-…`) says the rest. Any other line: its text.
 */
export function delegationText(node: {
  keyword: string; text: string; agent?: string; async?: boolean; shaped?: { name: string; ref: string };
  /** The apx command the lines name, and the registry ids: a background piece's own, a WAIT's — absent, no commands. */
  apx?: string; work?: string; waits?: string[];
  /** A background piece inside an EACH: one id per run, `<work>-<k>`. */
  element?: boolean;
  /** A MARK's id, or the MARK a DELEGATE of a contract list starts; a MARK's spec (`AS`), its limit, its domain. */
  mark?: string; list?: string; spec?: { name: string; ref: string }; max?: number; within?: string;
  /** The adapter's own words (`meta.phrases`); a FORK BY's command that reads its agent's definition. */
  phrases?: DelegationPhrases; definition?: string;
  /** `BY <harness>:<agent>`: the other harness `agent` runs on (D66). */
  harness?: string;
}): string {
  const keywords = phrasesOf(node.phrases);
  if (node.keyword === MARK_VERB) {
    const mark = parseMark(node.text);
    const within = node.within ?? mark.within;
    return fill(keywords.MARK.text, {
      criterion: mark.criterion, spec: node.spec?.name ?? mark.spec ?? '', ref: node.spec?.ref ?? '', apx: node.apx ?? '<apx>', mark: node.mark ?? '<mrk-id>',
      max: String(node.max ?? mark.max ?? 'the project\'s `mark.max`'), within: within ? fill(keywords.MARK.within, { domain: within }) : '', list: mark.into ?? '',
    });
  }
  if (node.keyword === DELEGATE_VERB && node.list && node.agent) {
    // On another harness (D66): each contract launched from outside, in its copy, by the harness's recipe.
    const [head, runs, background] = node.harness
      ? [keywords.DELEGATE.contractsHarness, keywords.DELEGATE.contractsHarnessRun, keywords.DELEGATE.harnessBackground]
      : [keywords.DELEGATE.contracts, keywords.DELEGATE.contractsRun, keywords.DELEGATE.background];
    const run = node.apx && node.mark ? fill(runs, { apx: node.apx, mark: node.mark, agent: node.agent, harness: node.harness ?? '' }) : '';
    // Not in the background: it waits for them where it stands.
    const wait = !node.async && node.apx && node.mark ? fill(keywords.DELEGATE.contractsWait, { apx: node.apx, mark: node.mark }) : '';
    return fill(head, { list: node.list, agent: node.agent, harness: node.harness ?? '', background: node.async ? background : '' }) + run + wait;
  }
  const id = node.work && node.element ? fill(keywords.DELEGATE.element, { work: node.work }) : node.work;
  // Another harness, launched from outside in a copy of its own (D66): the task and the variables it reads, or the AS's form.
  if (node.keyword === DELEGATE_VERB && node.harness && node.agent) {
    const context = node.shaped ? fill(keywords.DELEGATE.shaped, { name: node.shaped.name, ref: node.shaped.ref }) : keywords.DELEGATE.harnessContext;
    const run = node.apx && id ? fill(keywords.DELEGATE.harnessRun, { apx: node.apx, id, agent: node.agent, harness: node.harness }) + (node.element ? keywords.DELEGATE.elements : '') : '';
    const wait = !node.async && node.apx && id ? fill(keywords.DELEGATE.harnessWait, { apx: node.apx, id }) : '';
    return fill(keywords.DELEGATE.harness, { text: node.text, agent: node.agent, harness: node.harness, context, background: node.async ? keywords.DELEGATE.harnessBackground : '' }) + run + wait;
  }
  const started = node.apx && id ? fill(keywords.DELEGATE.started, { apx: node.apx, id }) + (node.element ? keywords.DELEGATE.elements : '') : '';
  const background = node.async ? keywords.DELEGATE.background + started : '';
  // A question: its contract (`exe-…`) says what is handed over and the shape of the answer.
  if (node.keyword === ASK_VERB && node.agent) return fill(FORMULAS.keywords.ASK.to, { text: node.text, agent: node.agent });
  if (node.keyword === DELEGATE_VERB && node.agent) {
    const context = node.shaped ? fill(keywords.DELEGATE.shaped, { name: node.shaped.name, ref: node.shaped.ref }) : keywords.DELEGATE.full;
    return fill(keywords.DELEGATE.to, { text: node.text, agent: node.agent, context, background });
  }
  if (node.keyword === FORK_VERB) {
    // A fork inherits the conversation; an AS says the shape of what it is handed on top of it (D58).
    const shaped = node.shaped ? fill(keywords.FORK.shaped, { name: node.shaped.name, ref: node.shaped.ref }) : '';
    return node.agent ? fill(keywords.FORK.agent, { text: node.text, agent: node.agent, shaped, background, definition: node.definition ?? `the definition of \`${node.agent}\`` })
      : fill(keywords.FORK.self, { text: node.text, shaped, background });
  }
  if (node.keyword === WAIT_VERB) {
    const wait = parseWait(node.text);
    const text = 'all' in wait ? keywords.WAIT.all : fill(keywords.WAIT.named, { names: wait.names.map(name => `\`${name}\``).join(', ') });
    if (!node.apx || !node.waits?.length) return text;
    return text + fill(keywords.WAIT.run, { apx: node.apx, ids: node.waits.join(' '), max: wait.max ? fill(keywords.WAIT.max, { max: wait.max }) : '' });
  }
  return node.text;
}

/** `MAX <duration>` ending a WAIT: how long it waits at most, over the project's `wait.max`. */
const WAIT_MAX_RE = /^(.*?)\s+MAX\s+(\S+)\s*$/;
/** A duration: a whole number and its unit — seconds, minutes, hours. */
const DURATION_RE = /^([1-9]\d*)(s|m|h)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** A duration (`30m`) in milliseconds — null when it is not one. */
export function parseDuration(text: string): number | null {
  const match = DURATION_RE.exec(text.trim());
  return match ? Number(match[1]) * UNIT_MS[match[2]] : null;
}

/** What a duration is, for a message. */
export const DURATION_FORM = 'a whole number and its unit — `90s`, `10m`, `2h`';

/** A WAIT line's rest: the variables it waits for, or every piece of its block — and its `MAX <duration>`, null when it has none. */
export function parseWait(rest: string): ({ all: true } | { names: string[] }) & { max: string | null } {
  let text = rest.trim();
  const match = WAIT_MAX_RE.exec(text);
  const max = match ? match[2] : null;
  if (match) text = match[1].trim();
  return text === WAIT_ALL ? { all: true, max } : { names: splitList(text), max };
}

/** What is wrong with a WAIT line as written: a MAX that is no duration. */
export function waitLineErrors(rest: string): string[] {
  const { max } = parseWait(rest);
  if (max !== null && parseDuration(max) === null) return [`WAIT … MAX ${max}: a duration is ${DURATION_FORM}`];
  if (/\bMAX\s*$/.test(rest.trim())) return [`WAIT … MAX: say how long — ${DURATION_FORM}`];
  return [];
}

/** A MARK line, read: what to mark, the list it fills, the spec of each zone, how many at most, the domain a contract may write beyond its zones. */
export interface Mark {
  criterion: string;
  into: string | null;
  spec: string | null;
  /** `MAX <n>` — null: the project's `mark.max`. */
  max: number | null;
  /** What follows MAX, when it is no whole number — the lint's to name. */
  badMax: string | null;
  within: string | null;
}

const MARK_WITHIN_RE = /^(.*?)\s+WITHIN\s+(\S+)\s*$/;
const MARK_MAX_RE = /^(.*?)\s+MAX\s+(\S+)\s*$/;

/** A MARK line's rest as its parts — taken from its end, in the order the line writes them. */
export function parseMark(rest: string): Mark {
  let text = rest.trim();
  const withinMatch = MARK_WITHIN_RE.exec(text);
  const within = withinMatch ? withinMatch[2] : null;
  if (withinMatch) text = withinMatch[1].trim();
  const maxMatch = MARK_MAX_RE.exec(text);
  const max = maxMatch && /^[1-9]\d*$/.test(maxMatch[2]) ? Number(maxMatch[2]) : null;
  const badMax = maxMatch && max === null ? maxMatch[2] : null;
  if (maxMatch) text = maxMatch[1].trim();
  const as = splitAs(text);
  if (as) text = as.text;
  const into = splitInto(text);
  if (into) text = into.text;
  return { criterion: text.trim(), into: into?.name ?? null, spec: as?.name ?? null, max, badMax, within };
}

/** What is wrong with a MARK line as written: a missing INTO or AS (D18), a MAX that is no count, an empty criterion. */
export function markLineErrors(rest: string): string[] {
  const mark = parseMark(rest);
  const shape = 'MARK <criterion> INTO <name> AS <spec> [MAX <n>] [WITHIN <domain>]';
  const errors: string[] = [];
  if (!mark.criterion) errors.push(`MARK needs what to mark — \`${shape}\``);
  if (!mark.into) errors.push(`MARK needs the list its contracts make up — \`${shape}\``);
  if (!mark.spec) errors.push(`MARK needs the spec of each zone — every contract is one \`AS <template>\`: \`${shape}\``);
  if (mark.badMax !== null) errors.push(`MARK … MAX ${mark.badMax}: MAX is how many zones at most — a whole number`);
  if (/\bWITHIN\s*$/.test(rest.trim())) errors.push('MARK … WITHIN: name the domain a contract may write beyond its zones');
  return errors;
}

/** A DELEGATE whose task is one bare name: the contracts a MARK filled that list with — the name, else null. */
export function contractListOf(task: string): string | null {
  const trimmed = task.trim();
  return /^[a-z][a-z0-9_-]*$/.test(trimmed) ? trimmed : null;
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
  /** Inside an EACH: one run per element, at most `max` — each run its own piece, `<id>-<k>`. */
  each?: { max: number };
  /** The domains of the `@WITHIN` closest around it (the flow's, its step's) — the perimeter its work is handed under (D65). */
  within?: string[];
  /** `BY <harness>:<agent>`: the other harness it is launched on, from outside, in a copy of its own (D66) — a piece even when not in the background. */
  harness?: string;
}

/** A MARK of a flow, as the apx keeps it (`meta.marks`): where it is written, the list it fills, the spec of each zone, its limit, its domain. */
export interface ApMark {
  flow: string;
  step: string;
  list: string;
  /** The AS template's name — what `contract mark` checks a spec against. */
  spec: string;
  max: number;
  /** The domain a contract may write beyond its zones — null when none. */
  within: string | null;
}

/** The lines of a flow the binding reads and marks — the document's nodes, loosely. */
interface FlowNode {
  type: string;
  keyword?: string;
  text?: string;
  title?: string;
  async?: true;
  by?: string;
  /** `BY <harness>:<agent>`: launched on another harness — a piece of the registry, in the background or not. */
  harness?: string;
  into?: { target: string };
  /** Set here: a background delegation's id (`dlg-…`). */
  work?: string;
  /** Set here: a MARK's id (`mrk-…`) — on a DELEGATE of a contract list, the MARK it starts. */
  mark?: string;
  /** A DELEGATE of a contract list: the list. */
  list?: string;
  /** Set here, on a WAIT: the ids of what it takes back. */
  waits?: string[];
  /** Set here: a background delegation inside an EACH — one piece per run, `<work>-<k>`. */
  element?: true;
  /** An EACH's head: its bound. */
  each?: { max: number };
  /** A decorator's node: the blocks it names. */
  uses?: { target: string }[];
  body?: FlowNode[];
  then?: FlowNode[];
  else?: FlowNode[];
  steps?: FlowNode[];
}

/** The node a `@WITHIN` decorator leaves in a flow's body. */
const WITHIN_MARK = `${DECORATOR_MARK}${WITHIN_DECORATOR.key}`;

/**
 * Bind a flow's background work: each `DELEGATE~` / `FORK~` gets its id
 * (`dlg-<8 hex>`, from the flow and its place in it), each WAIT the ids of
 * what it takes back — what it names, or every piece its block started. The
 * scopes are the ones the concurrency check reads: a STEP, an IF or ELSE
 * branch, an UNTIL. Returns what the apx keeps of each, by id.
 */
export function bindBackgroundWork(
  flow: { address: string; name: string; body: readonly unknown[] }, idOf: (text: string, prefix: 'dlg' | 'mrk') => string,
  marks: Record<string, ApMark> = {}, markOf: (node: FlowNode, step: string) => ApMark | null = () => null,
): Record<string, ApBackgroundWork> {
  const found: Record<string, ApBackgroundWork> = {};
  let counter = 0;
  // The flow's lists of contracts, by name: the MARK that last filled each one.
  const lists = new Map<string, string>();
  const nameOf = (into: { target: string } | undefined) => (into ? into.target.split('/').pop() ?? null : null);
  const walk = (nodes: readonly FlowNode[], step: string, running: { id: string; name: string | null }[], each: { max: number } | null = null, within: string[] | null = null): void => {
    for (const node of nodes) {
      if (node.type === 'directive' && node.keyword === MARK_VERB) {
        const mark = markOf(node, step);
        if (mark) {
          const id = idOf(JSON.stringify([flow.address, 'mark', counter++]), 'mrk');
          node.mark = id;
          marks[id] = mark;
          lists.set(mark.list, id);
        }
      } else if (node.type === 'directive' && node.keyword === DELEGATE_VERB && node.list) {
        // The contracts of a list, started: waited for by their MARK's id.
        const id = lists.get(node.list);
        if (id) {
          node.mark = id;
          if (node.async) running.push({ id, name: node.list });
        }
      } else if (node.type === 'directive' && isDelegationVerb(node.keyword ?? '') && (node.async || node.harness)) {
        // In the background — or on another harness, which works in a copy the registry keeps even when waited for at once (D66).
        const id = idOf(JSON.stringify([flow.address, counter++]), 'dlg');
        node.work = id;
        if (each) node.element = true;
        if (node.async) running.push({ id, name: nameOf(node.into) });
        found[id] = {
          flow: flow.name, step, verb: node.keyword!, task: node.text ?? '', into: nameOf(node.into), by: node.by ?? null,
          ...(each ? { each } : {}), ...(within ? { within } : {}), ...(node.harness ? { harness: node.harness } : {}),
        };
      } else if (node.type === 'directive' && node.keyword === WAIT_VERB) {
        const wait = parseWait(node.text ?? '');
        const taken = 'all' in wait ? [...running] : running.filter(piece => piece.name !== null && wait.names.includes(piece.name));
        for (const piece of taken) running.splice(running.indexOf(piece), 1);
        node.waits = taken.map(piece => piece.id);
      }
      // A step, a branch, a loop body: a scope of its own. Any other body (a decorator's) is the enclosing one's.
      if (node.type === 'step') walk(node.body ?? [], node.title ?? '', [], null, within);
      else if (node.type === 'if') { walk(node.then ?? [], step, [], null, within); walk(node.else ?? [], step, [], null, within); }
      else if (node.type === 'until') walk(node.body ?? [], step, [], null, within);
      // An agent's WHEN: its lines, where a delegation to another harness is a piece too.
      else if (node.type === 'when') walk(node.body ?? [], step, [], null, within);
      // An EACH is no scope: what its runs start is waited for in its step.
      else if (node.type === 'each') walk(node.body ?? [], step, running, node.each ?? null, within);
      // A `@WITHIN`'s body works within its domains — the closest one holds, the compiler keeps it inside the outer (D32).
      else if (node.body && node.type === 'directive' && node.keyword === WITHIN_MARK) walk(node.body, step, running, each, (node.uses ?? []).map(use => use.target.split('/').pop() ?? use.target));
      else if (node.body && node.type === 'directive' && !isDelegationVerb(node.keyword ?? '')) walk(node.body, step, running, each, within);
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
  // The lists a MARK fills, in the order the body writes them.
  const marked = new Set<string>();
  // `pending`: the scopes enclosing a point, outermost first — each with what it started and has not waited for.
  const walk = (nodes: readonly DelegationTreeNode[], inStep: boolean, pending: Started[][], key: string | null): void => {
    const own: Started[] = [];
    const scopes = key && SCOPE_KEYS.has(key) && inStep ? [...pending, own] : pending;
    const mine = scopes[scopes.length - 1] ?? own;
    for (const node of nodes) {
      const token = node.token;
      const raw = token.raw ?? '';
      const kw = token.kind === 'keyword' ? token.keyword ?? '' : '';
      // A read of what is still running.
      for (const { name } of readsOf(raw)) {
        const running = scopes.flat().find(entry => entry.name === name);
        if (running && !(kw === WAIT_VERB)) at(token.line, `\`{{${name}}}\` is read before its WAIT — it was started with ${ASYNC_MARK} at line ${running.line}: write \`WAIT ${name}\` above this line`);
      }
      if (kw === FORK_VERB && !inStep) at(token.line, 'FORK hands work to a fork of whoever runs a flow — it stands in a flow STEP; an agent asks a question with ASK');
      const each = kw === 'EACH' ? parseEachHead(token.rest ?? '') : null;
      if (each) {
        if (!inStep) at(token.line, 'EACH hands work out once per element of a list, for a flow — it stands in a flow STEP');
        if (!('error' in each) && marked.has(each.list)) {
          at(token.line, `EACH ${each.item} IN {{${each.list}}}: \`${each.list}\` holds the contracts a MARK made — a list of contracts is delegated as it is: \`DELEGATE ${each.list} BY <agent>\``);
        }
      }
      if (kw === MARK_VERB) {
        if (!inStep) at(token.line, 'MARK binds zones of the code to contracts for a flow to hand out — it stands in a flow STEP');
        const into = parseMark(token.rest ?? '').into;
        if (into) marked.add(into);
      }
      // A DELEGATE of one bare name hands out the contracts a MARK filled that list with.
      const list = kw === DELEGATE_VERB && inStep ? contractListOf(parseDelegation(kw, token.rest ?? '').task) : null;
      if (list && marked.has(list)) {
        const delegation = parseDelegation(kw, token.rest ?? '');
        if (delegation.as) at(token.line, `DELEGATE ${list} … AS: every contract carries its spec, the AS of its MARK — drop the AS`);
        if (delegation.into) at(token.line, `DELEGATE ${list} … INTO: the contracts report into \`${list}\` itself — drop the INTO`);
        if (delegation.opens) at(token.line, `DELEGATE ${list}: the contracts carry their own spec — a DELEGATE of a list takes no lines beneath it`);
      }
      if (kw === DELEGATE_VERB && inStep && !parseDelegation(kw, token.rest ?? '').by) {
        at(token.line, 'DELEGATE in a flow names who it goes to — end it with `BY <agent | team>`');
      }
      if (isDelegationVerb(kw) && token.async) {
        if (!inStep) at(token.line, `${kw}${ASYNC_MARK}: starting work without waiting for it is a flow STEP's — here, write ${kw} and wait for it`);
        else mine.push({ name: parseDelegation(kw, token.rest ?? '').into ?? list, line: token.line });
      } else if (kw === WAIT_VERB) {
        if (!inStep) at(token.line, 'WAIT takes back what a STEP started with ~ — it stands in a flow STEP');
        else {
          const wait = parseWait(token.rest ?? '');
          if ('all' in wait) {
            if (mine.length === 0) at(token.line, `WAIT ALL: nothing was started with ${ASYNC_MARK} in this block — drop the WAIT`);
            mine.length = 0;
          } else {
            for (const name of wait.names) {
              const index = mine.findIndex(entry => entry.name === name);
              if (index >= 0) mine.splice(index, 1);
              else at(token.line, `WAIT ${name}: no ${DELEGATE_VERB}${ASYNC_MARK} or ${FORK_VERB}${ASYNC_MARK} of this block fills \`${name}\` — a WAIT takes back what its own block started`);
            }
          }
        }
      }
      if (node.children.length > 0) walk(node.children, inStep || kw === 'STEP', scopes, kw || null);
    }
    if (scopes !== pending) {
      for (const entry of own) at(entry.line, `started with ${ASYNC_MARK} and never waited for — WAIT ${entry.name ?? WAIT_ALL} before its ${key} ends`);
    }
  };
  walk(tree, false, [], null);
  return errors;
}
