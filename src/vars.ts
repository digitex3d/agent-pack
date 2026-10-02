// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The grammar of variables (D32, I7) — the one place it is written down.
 *
 *   VAR board = Product           a constant, substituted at compile time
 *   VAR best-pizza                a private variable — the declaring agent's — declared, still empty
 *   VAR report AS task-report     a private variable with a type: a template
 *   SESSION VAR plan              shared by every agent of the session (a team's or the project's vars.ap)
 *   VAR best-pizza:               declared and assigned: the outcome of the block beneath
 *   DO … INTO best-pizza          assigns, or reassigns, a declared variable
 *   {{best-pizza}}                reads one — a constant's value, or a variable's
 *
 * Every reader of these forms — the lint, the compiler, the document builder,
 * the md renderer, the apx — asks this module; none writes its own pattern.
 */
import { BLOCK_ID_RE } from './apdoc/ids.js';

/** A variable name: letters, digits, `_` and `-`, like every other name of the language. */
const NAME = '[A-Za-z_][\\w-]*';

/** A variable's name, whole. */
export const VAR_NAME_RE = new RegExp(`^${NAME}$`);

/** The field path of a read (`.status`), when it has one. */
const FIELD = '(?:\\.[\\w-]+)*';

/**
 * `{{name}}`, or `{{name.field}}` — a read. Group 1 is the name, group 2 the
 * field path (with its leading dot) when there is one.
 */
const VAR_REF_SOURCE = `\\{\\{(${NAME})(${FIELD})\\}\\}`;

/** A fresh global regex over every `{{…}}` read of a text. */
export function varRefRe(): RegExp {
  return new RegExp(VAR_REF_SOURCE, 'g');
}

/** The pieces of a line between its reads — the reads themselves dropped. */
export function splitOnReads(line: string): string[] {
  return line.split(new RegExp(`\\{\\{${NAME}${FIELD}\\}\\}`));
}

/**
 * Resolve every read of a text: `value(name)` gives what `{{name}}` becomes
 * — a constant's value, how to read a variable — or undefined to leave
 * it as written. A field read (`{{x.status}}`) is always left: not supported yet.
 */
export function resolveReads(text: string, value: (name: string) => string | undefined): string {
  return text.replace(varRefRe(), (read, name: string, field: string) => (field ? undefined : value(name)) ?? read);
}

/** A constant's value — its own entry of `vars` only, never an inherited property — or undefined. */
export function constantOf(vars: Record<string, string> | undefined, name: string): string | undefined {
  return vars && Object.hasOwn(vars, name) ? vars[name] : undefined;
}

/** `{{name}}` → its value, for every name in `vars`; any other read stays as written. */
export function applyVars(text: string, vars: Record<string, string>): string {
  return resolveReads(text, name => constantOf(vars, name));
}

/** A trailing `INTO <name>` — uppercase, at the very end of the line: anywhere else it is prose. */
const INTO_RE = new RegExp(`^(.*?)\\s+INTO\\s+(${NAME})\\s*$`);

/** Why a playbook takes no session variable: it compiles into a skill, which has no apx yet. */
export const NO_PLAYBOOK_VARIABLES = 'playbooks have no executable yet — session variables are not available';

/** Only a DO line assigns with a trailing INTO: the one keyword that takes it. */
export function takesInto(keyword: string): boolean {
  return keyword === 'DO';
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
