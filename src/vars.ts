// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The grammar of variables (D32, I7) — the one place it is written down.
 *
 *   VAR board = Product           a constant, substituted at compile time
 *   VAR best-pizza                a private variable — the declaring agent's — declared, still empty
 *   VAR report AS task-report     a private variable with a type: a template
 *   SESSION VAR plan              shared by every agent of the session
 *   EXPORT SESSION VAR plan       declared in a module, for the agents that IMPORT it
 *   VAR best-pizza:               declared and assigned: the outcome of the block beneath
 *   DO … INTO best-pizza          assigns, or reassigns, a declared variable
 *   {{best-pizza}}                reads one — a constant's value, or a variable's
 *   {{report AS dividend-table}}  reads a variable, keeping only what fits a template
 *   PARALLEL EACH part IN parts MAX 5   one run per element of a list variable, `{{part}}` the run's element
 *
 * Every reader of these forms — the lint, the compiler, the document builder,
 * the md renderer, the apx — asks this module; none writes its own pattern.
 */
import { BLOCK_ID_RE } from './apdoc/ids.js';
import { ACTION_VERBS } from './actionVerbs.js';

/** A variable name: letters, digits, `_` and `-`, like every other name of the language. */
const NAME = '[A-Za-z_][\\w-]*';

/** A variable's name, whole. */
export const VAR_NAME_RE = new RegExp(`^${NAME}$`);

/** The field path of a read (`.status`), when it has one. */
const FIELD = '(?:\\.[\\w-]+)*';

/**
 * `{{name}}`, `{{name.field}}`, `{{name AS template}}` — a read: the name, the
 * field path (with its leading dot) when there is one, the AS as written (a
 * force level is an error) and its template when it takes a shape. The one
 * pattern of a read — with its parts captured, or without (to split on it).
 */
function varRef(capture: boolean): RegExp {
  const group = (p: string) => (capture ? `(${p})` : `(?:${p})`);
  return new RegExp(`\\{\\{${group(NAME)}${group(FIELD)}(?:\\s+${group('!*AS!*')}\\s+${group(NAME)})?\\}\\}`, 'g');
}

/** One read of a text, as written. */
export interface VarRead {
  /** The whole read: `{{report AS dividend-table}}`. */
  read: string;
  name: string;
  /** The field path (`.status`), '' when none — not supported yet. */
  field: string;
  /** The AS as written (`AS`, or a wrong `AS!`), and the template it names — absent on a plain read. */
  as?: string;
  template?: string;
}

/** Every read of a text, in order. */
export function readsOf(text: string): VarRead[] {
  return [...text.matchAll(varRef(true))].map(toRead);
}

function toRead([read, name, field, as, template]: RegExpMatchArray | string[]): VarRead {
  return { read, name, field, ...(template ? { as, template } : {}) };
}

/** The pieces of a line between its reads — the reads themselves dropped. */
export function splitOnReads(line: string): string[] {
  return line.split(varRef(false));
}

/**
 * Resolve every read of a text: `value(read)` gives what the read becomes — a
 * constant's value, how to read a variable — or undefined to leave it as
 * written. A field read (`{{x.status}}`) is always left: not supported yet.
 */
export function resolveReads(text: string, value: (read: VarRead) => string | undefined): string {
  return text.replace(varRef(true), (...m: string[]) => {
    const read = toRead(m);
    return (read.field ? undefined : value(read)) ?? read.read;
  });
}

/** A constant's value — its own entry of `vars` only, never an inherited property — or undefined. */
export function constantOf(vars: Record<string, string> | undefined, name: string): string | undefined {
  return vars && Object.hasOwn(vars, name) ? vars[name] : undefined;
}

/** `{{name}}` → its value, for every name in `vars`; any other read stays as written. */
export function applyVars(text: string, vars: Record<string, string>): string {
  return resolveReads(text, r => (r.template ? undefined : constantOf(vars, r.name)));
}

/** A trailing `INTO <name>` — uppercase, at the very end of the line: anywhere else it is prose. */
const INTO_RE = new RegExp(`^(.*?)\\s+INTO\\s+(${NAME})\\s*$`);

/** An action line assigns with a trailing INTO — DO, ASK, COMPUTE (src/executor.ts) — and RUN: its procedure's result. */
export function takesInto(keyword: string): boolean {
  return (ACTION_VERBS as readonly string[]).includes(keyword) || keyword === 'RUN';
}

/** A trailing `BY <name>` — uppercase, at the very end of the line: anywhere else it is prose. */
const BY_RE = new RegExp(`^(.*?)\\s+BY\\s+(${NAME})\\s*$`);

/** A line's text and the agent it names, when it ends with `BY <name>` — else null. */
export function splitBy(text: string): { text: string; name: string } | null {
  const m = BY_RE.exec(text);
  return m ? { text: m[1].trim(), name: m[2] } : null;
}

/** A line's text and the variable it assigns, when it ends with `INTO <name>` — else null. */
export function splitInto(text: string): { text: string; name: string } | null {
  const m = INTO_RE.exec(text);
  return m ? { text: m[1].trim(), name: m[2] } : null;
}

/** A declaration, as its `VAR` line writes it. */
/**
 * Who sees a variable and how long it lives — written as a word before `VAR`,
 * as EXPORT is before a block: none means private (the declaring agent, one
 * session), `SESSION` every agent of the project for the session, `GLOBAL`
 * every agent, every session (reserved — not available yet).
 */
export type VarScope = 'private' | 'session';
/** The words a scope is written with, before `VAR`. */
export const VAR_SCOPE_WORDS = ['SESSION', 'GLOBAL'] as const;

export type VarDecl =
  | { form: 'constant'; name: string; value: string }
  | { form: 'variable'; scope: VarScope; name: string; type: string | null; block: boolean };

/** Whether a line opens with a declaration's keyword: `VAR`, or a scope word. */
export function isVarKeyword(keyword: string): boolean {
  return keyword === 'VAR' || (VAR_SCOPE_WORDS as readonly string[]).includes(keyword);
}

/** What is wrong with a variable name, or null when it is one — a block id's shape would shadow a block in the apx. */
export function varNameError(name: string): string | null {
  if (BLOCK_ID_RE.test(name)) return `\`${name}\` has the shape of a block id — give the variable another name`;
  if (!VAR_NAME_RE.test(name)) return `\`${name}\` is not a variable name — use letters, digits, _ and -`;
  return null;
}

/** The head of a `PARALLEL` that runs its step once per element of a list variable. */
export interface ParallelEach {
  /** The name `{{item}}` reads in the step: the run's element. */
  item: string;
  /** The variable holding the list. */
  list: string;
  /** The most runs the list may ask for — more is an error at run time. */
  max: number;
}

const EACH_RE = new RegExp(`^EACH\\s+(${NAME})\\s+IN\\s+(${NAME})(?:\\s+MAX\\s+(\\S+))?$`);

/**
 * The text after `PARALLEL` — `EACH <item> IN <list> MAX <n>`, with an optional
 * trailing `:` — or null for a bare `PARALLEL`. The bound is always written: a
 * list nobody bounds starts as many agents as it has elements.
 */
export function parseParallelHead(rest: string): ParallelEach | { error: string } | null {
  const text = rest.trim().replace(/\s*:$/, '');
  if (!text) return null;
  const m = EACH_RE.exec(text);
  if (!m) return { error: `\`PARALLEL ${text}\`: PARALLEL takes nothing, or \`EACH <item> IN <list> MAX <n>\`` };
  const [, item, list, max] = m;
  if (max === undefined) return { error: `\`PARALLEL ${text}\`: write the bound — \`PARALLEL EACH ${item} IN ${list} MAX <n>\`` };
  if (!/^[1-9]\d*$/.test(max)) return { error: `\`PARALLEL ${text}\`: MAX takes a whole number of runs, at least 1` };
  if (item === list) return { error: `\`PARALLEL ${text}\`: the element needs a name of its own, not the list's` };
  const error = varNameError(item);
  return error ? { error } : { item, list, max: Number(max) };
}

/** The head after `PARALLEL` when it is a well-formed EACH — else null (a malformed one is the lint's to report). */
export function parallelEachOf(rest: string): ParallelEach | null {
  const head = parseParallelHead(rest);
  return head && !('error' in head) ? head : null;
}

const CONSTANT_RE = /^([^\s=]+)\s*=\s*(.*)$/;
const SESSION_RE = /^([^\s:=]+)(?:\s+(!*AS!*)\s+([^\s:]+))?\s*(:)?$/;

/**
 * A declaration line — its keyword and the text after it — or null when the
 * line is none. The one parser of `VAR`: `VAR …` is private (or a constant),
 * `SESSION VAR …` shared by the session's agents; a scope word stands only right
 * before `VAR`, never on a constant, and `GLOBAL` is not available yet.
 */
export function parseVarLine(keyword: string, rest: string): VarDecl | { error: string } | null {
  if (keyword === 'VAR') return parseVarDecl(rest, 'private');
  if (!isVarKeyword(keyword)) return null;
  const after = /^VAR\s+(.+)$/.exec(rest.trim());
  if (!after) return { error: `${keyword} is a variable's scope — it stands only right before VAR: \`${keyword} VAR <name>\`` };
  if (keyword === 'GLOBAL') return { error: 'GLOBAL variables are not available yet — write `SESSION VAR` for one the session\'s agents share' };
  const decl = parseVarDecl(after[1], 'session');
  if ('form' in decl && decl.form === 'constant') return { error: `a constant has no scope — write \`VAR ${decl.name} = …\`` };
  return decl;
}

/**
 * An exported declaration — the text after `EXPORT` (`SESSION VAR plan AS x`,
 * `VAR board = Product`) — or null when it is none. A module only declares: a
 * `VAR x:` block assigns while the agent works, so it is never exported.
 */
export function parseExportedVar(rest: string): VarDecl | { error: string } | null {
  const m = /^(\S+)\s*(.*)$/.exec(rest.trim());
  const decl = m ? parseVarLine(m[1], m[2]) : null;
  if (decl && 'form' in decl && decl.form === 'variable' && decl.block) {
    return { error: `\`EXPORT ${rest.trim()}\`: a module declares a variable, never assigns it — drop the ':' and assign it in a body` };
  }
  return decl;
}

/**
 * Parse the text after `VAR`. A `=` makes a constant — and a constant never
 * opens a block, whatever its value ends with. Otherwise a variable of `scope`:
 * optionally typed with `AS <template>` (no force level: it is a type, not an
 * instruction), and a trailing `:` assigns it the outcome of the block beneath.
 */
function parseVarDecl(rest: string, scope: VarScope): VarDecl | { error: string } {
  const text = rest.trim();
  const constant = CONSTANT_RE.exec(text);
  if (constant) {
    const error = varNameError(constant[1]);
    return error ? { error } : { form: 'constant', name: constant[1], value: stripQuotes(constant[2].trim()) };
  }
  const session = SESSION_RE.exec(text);
  if (!session) {
    return { error: `malformed VAR line \`VAR ${text}\` — write \`VAR <name> = <value>\`, \`VAR <name>\` or \`VAR <name> AS <template>\`, with a trailing \`:\` to assign the block beneath` };
  }
  const [, name, as, type, colon] = session;
  if (as !== undefined && as !== 'AS') return { error: `\`${as}\`: the AS of a VAR is its type and takes no force level — write \`VAR ${name} AS ${type}\`` };
  const error = varNameError(name);
  return error ? { error } : { form: 'variable', scope, name, type: type ?? null, block: colon !== undefined };
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1);
  }
  return s;
}
