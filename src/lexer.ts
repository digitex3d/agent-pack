// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Indent-aware line lexer for `.ap` source files.
 *
 * The DSL is line-oriented: every meaningful unit fits on one line, and scope
 * is established by leading whitespace (Python-style). The lexer therefore
 * emits one token per line, classified by kind and carrying:
 *   - precise position (line, col, indent)
 *   - the matched keyword and its post-keyword content (when applicable)
 *   - the original raw line (for error messages and round-tripping)
 *
 * The lexer is intentionally permissive: it does not validate context (e.g.
 * "ALWAYS is only allowed in policies"). Validation is the job of the
 * downstream consumer (linter, parser).
 */

// Safe to import here: desugar.ts uses only `import type` from lexer.ts,
// which TypeScript erases at compile time. The runtime dependency graph is
// strictly one-directional: lexer.js → desugar.js (no back-edge).
import { desugar } from './desugar.js';
import { getFamilyBases, getAliasNames } from './forceLevelConfig.js';
import { getLifecycleAliases } from './lifecycleConfig.js';

/**
 * Static (non-force-level) keywords. Force-level families and their aliases
 * are loaded from src/config/force-levels.json at runtime via forceLevelConfig.
 */
const STATIC_KEYWORDS = [
  'PROCEDURE', 'TEMPLATE', 'EXTENDS', 'APPLIES',
  'IMPORT', 'RETURN',
  'UNTIL', 'ABOUT', 'SCOPE',
  'ELSE', 'WHEN', 'OWNS', 'TAGS',
  'RUN', 'VAR', 'DO', 'IF',
  'ROLE', 'EXPERTISE', 'MANDATE', 'LENS-OUT', 'LENS-IN',
  'FLOW', 'STEP', 'PARALLEL', 'CONTEXT', 'BY',
  // STORE body: TYPE names the backing plugin, LASTS its lifetime, KEY the
  // field that identifies a record (so re-ingesting the same thing updates it
  // instead of duplicating). The record shape itself reuses the template
  // SLOTS grammar — no second type language.
  'STORE', 'TYPE', 'LASTS', 'KEY',
  // `IN <store>:` — a block grouping the steps that work in one store. A
  // control-flow head, not a named declaration: it lives inside a runnable.
  'IN',
] as const;

type StaticKeyword = typeof STATIC_KEYWORDS[number];

/**
 * Keyword type: covers static keywords (with IDE autocomplete) plus open-ended
 * runtime-derived parametric force-level forms (e.g. `!MUST`, `MUST!!`).
 */
export type Keyword = StaticKeyword | (string & {});

const FORCE_LEVEL_BASES = getFamilyBases();
const ALIAS_NAMES = getAliasNames();
const LIFECYCLE_ALIASES = getLifecycleAliases();

/**
 * Full keyword list: static keywords + force-level family bases + alias names
 * + lifecycle aliases. Force-level parametric forms (MUST!, !MUST, MUST!!) are
 * matched by the regex pattern rather than enumerated here.
 */
export const KEYWORDS: string[] = [
  ...STATIC_KEYWORDS,
  ...FORCE_LEVEL_BASES,
  ...ALIAS_NAMES,
  ...LIFECYCLE_ALIASES,
];

/** Escape a string for safe inclusion as a literal inside a RegExp source. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the keyword alternation regex.
// The keyword capture group (group 2) captures the full keyword string including
// any `!` prefix (negation) or `!` suffix(es) (amplification).
//
// Order of alternatives (longest match wins by construction):
//   1. !+ PREFIX forms: !MUST, !ALWAYS, etc.
//   2. BASE + !* SUFFIX forms: MUST, MUST!, MUST!! (greedy suffix)
//   3. Alias names: MUST-NOT, NON-NEGOTIABLE, NEVER
//   4. Static keywords: PROCEDURE, IMPORT, etc.
//
// This ensures `MUST!!` beats `MUST!` beats `MUST` via greedy `!*`.

const FORCE_BASES_ALT = FORCE_LEVEL_BASES.map(escapeRegex).join('|');
const ALIAS_ALT = ALIAS_NAMES.map(escapeRegex).join('|');
const STATIC_ALT = [...STATIC_KEYWORDS].map(escapeRegex).join('|');
const LIFECYCLE_ALT = LIFECYCLE_ALIASES.map(escapeRegex).join('|');

// Keyword group: one of:
//   - !+ followed by a base (prefix/negation form)
//   - base followed by !* (base or amplification form, greedy — picks up MUST!!)
//   - alias name
//   - lifecycle alias (ON-AGENT-PROMPTED, ON-INVOKE, …)
//   - static keyword
const KW_GROUP = `(?:!+(?:${FORCE_BASES_ALT})|(?:${FORCE_BASES_ALT})!*|${ALIAS_ALT}|${LIFECYCLE_ALT}|${STATIC_ALT})`;

const KEYWORD_WITH_REST_RE = new RegExp(`^([ \\t]*)(${KW_GROUP})[ \\t]+(.+?)[ \\t]*$`);
// Keywords that stand alone on a line: IF, ELSE, PARALLEL and the DISTILL levels.
const KEYWORD_BARE_RE = new RegExp(`^([ \\t]*)(IF|ELSE|PARALLEL|!?DISTILL!{0,2})[ \\t]*$`);

// Lifecycle hook opener: `ON-X` or `ON-X:` (bare keyword, optional block colon).
// The optional trailing colon is captured into the keyword's rest so a colon
// form desugars into a `WHEN <phase>:` block opener — byte-identical to a
// hand-written WHEN block — while the bare form stays a prose WHEN line. The
// legacy `ON-INVOKE <text>` form is handled by KEYWORD_WITH_REST_RE above.
const LIFECYCLE_BARE_RE = new RegExp(`^([ \\t]*)(${LIFECYCLE_ALT})([ \\t]*:)?[ \\t]*$`);
const PROC_REF_RE = /^([ \t]*)(@[a-zA-Z0-9][\w-]*)\b[ \t]*(.*?)[ \t]*$/;
const RAW_OPEN_RE = /^[ \t]*RAW:[ \t]*$/;
const RAW_CLOSE_RE = /^[ \t]*:RAW[ \t]*$/;

/**
 * Block-opener line: `<KEY>[ <rest>]:` at any indent.
 *
 * KEY is any uppercase identifier — the lexer does NOT validate against a
 * primitive whitelist. The downstream parser (parseBlocks) looks up KEY in
 * the BlockType registry; unknown keys produce a parser-level diagnostic,
 * not a lex error. This keeps the lexer kind-agnostic and lets new
 * primitives be added by registering them, with zero lexer change.
 *
 * `rest` is the text between KEY and the trailing `:` (may contain spaces),
 * carrying the block's name (e.g. `PROCEDURE foo:`), trigger phrase
 * (`WHEN something happens:`), or be empty (`PARALLEL:`).
 */
const BLOCK_OPENER_RE = /^([ \t]*)([A-Z][A-Z0-9_-]*)(?:[ \t]+(.*?))?[ \t]*:[ \t]*$/;

export interface Position {
  /** 1-based line number in the source. */
  line: number;
  /** 1-based column of the first non-space character (1 for blank lines). */
  col: number;
  /** Number of leading space characters (tabs counted as 1). */
  indent: number;
}

export type Token =
  | (Position & { kind: 'blank' })
  | (Position & { kind: 'comment'; raw: string })
  | (Position & { kind: 'rawLine'; raw: string })
  | (Position & { kind: 'keyword'; keyword: Keyword; rest: string; raw: string })
  | (Position & { kind: 'blockOpener'; key: string; rest: string; raw: string })
  | (Position & { kind: 'procRef'; name: string; trailing: string; raw: string })
  | (Position & { kind: 'unknown'; raw: string });

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * Raw lexer — emits tokens as written in the source, with no alias resolution.
 * Prefer `lex()` in application code; use `lexRaw()` only in tests that need
 * to inspect pre-desugar token shapes.
 */
export function lexRaw(source: string): Token[] {
  const out: Token[] = [];
  const lines = source.split(/\r?\n/);
  let inRaw = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + 1;

    // RAW: ... :RAW block — verbatim passthrough. Delimiter lines emit no
    // token; inner lines become rawLine tokens.
    if (inRaw) {
      if (RAW_CLOSE_RE.test(raw)) { inRaw = false; continue; }
      out.push({ kind: 'rawLine', line, col: 1, indent: 0, raw });
      continue;
    }
    if (RAW_OPEN_RE.test(raw)) { inRaw = true; continue; }

    if (raw.trim() === '') {
      out.push({ kind: 'blank', line, col: 1, indent: 0 });
      continue;
    }

    const indent = indentOf(raw);
    const col = indent + 1;

    // Lines starting with `#` are comments — ignored by the compiler and not
    // emitted to the bundled .md output.
    if (raw.startsWith('#')) {
      out.push({ kind: 'comment', line, col: 1, indent: 0, raw });
      continue;
    }

    // Block-opener: `<NEW-KEY>[ <rest>]:` for primitives that are NOT in the
    // existing keyword whitelist (POLICY, PLAYBOOK,
    // AGENT, TOOL …). Known keywords keep their legacy emission to
    // preserve every downstream lint/render consumer. The universal parser
    // (parseBlocks) recognises both forms via a normalising helper, so the
    // grammar `<KEY> <name>: <block>` works regardless of whether KEY is a
    // legacy keyword or a new one — but the *token stream* changes only for
    // keys that didn't exist before.
    const bo = raw.match(BLOCK_OPENER_RE);
    if (bo && !KEYWORDS.includes(bo[2])) {
      out.push({
        kind: 'blockOpener', line, col, indent,
        key: bo[2],
        rest: (bo[3] ?? '').trim(),
        raw,
      });
      continue;
    }

    const kw = raw.match(KEYWORD_WITH_REST_RE);
    if (kw) {
      out.push({
        kind: 'keyword', line, col, indent,
        keyword: kw[2] as Keyword,
        rest: kw[3],
        raw,
      });
      continue;
    }

    const lifecycle = raw.match(LIFECYCLE_BARE_RE);
    if (lifecycle) {
      out.push({
        kind: 'keyword', line, col, indent,
        keyword: lifecycle[2] as Keyword,
        rest: lifecycle[3] ? ':' : '',   // carry the block colon, if written
        raw,
      });
      continue;
    }

    const bare = raw.match(KEYWORD_BARE_RE);
    if (bare) {
      out.push({
        kind: 'keyword', line, col, indent,
        keyword: bare[2] as Keyword,
        rest: '',
        raw,
      });
      continue;
    }

    const proc = raw.match(PROC_REF_RE);
    if (proc) {
      out.push({
        kind: 'procRef', line, col, indent,
        name: proc[2].slice(1),
        trailing: proc[3] ?? '',
        raw,
      });
      continue;
    }

    out.push({ kind: 'unknown', line, col, indent, raw });
  }
  return out;
}

/**
 * Lex a `.ap` source string and apply the desugar (alias resolution) pass.
 * This is the standard entry point for all application code.
 */
export function lex(source: string): Token[] {
  return desugar(lexRaw(source));
}
