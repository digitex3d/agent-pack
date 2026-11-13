// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Generic primitive helpers. A "primitive" is a leading uppercase keyword
 * that introduces a single line of metadata in a `.ap` file
 * (e.g. `ABOUT …`, `WRITES …`, `WHEN …`).
 */
import { FORMULAS } from '../formulas.js';
import { lex, escapeRegex, type Keyword } from '../lexer.js';
import { parseBlocks, type Block } from '../parseBlocks.js';
export { escapeRegex };

// ---------------------------------------------------------------------------
// Block-scoped metadata model (EXPORT) — TRANSITIONAL
//
// The metadata chain (extractPrimitive(s), stripPrimitives, partitionMetadata,
// extractAbout) reads ONLY indent-0 lines: in a legacy file the unit's
// ABOUT/APPLIES sit at file-top (indent 0) and its body follows at
// indent 0. After the codemod wraps a module as `EXPORT <KIND> <name>:`, those
// same lines become children of the block at indent ≥ 1, so the indent-0
// readers stop seeing them.
//
// `unwrapExportFile` normalises an EXPORT file back into its legacy-equivalent
// shape — drop the `EXPORT <KIND> <name>:` opener and de-indent each block's
// children by the block's own child-indent — so every downstream indent-0
// reader keeps working unchanged and byte-for-byte. A file with no EXPORT block
// is returned verbatim (legacy path, zero behaviour change).
//
// This helper and its call sites (one `unwrapExportFile(...)` line per metadata
// reader) are the only seam to remove once every module is migrated and the
// readers can assume the block-scoped shape directly.
// ---------------------------------------------------------------------------

/**
 * Normalise an EXPORT-block file into its legacy file-top shape. For each
 * top-level `EXPORT <KIND> <name>:` block, drop the opener line and lift its
 * children up by one indent step (the block's own child indent), so the unit's
 * metadata lands back at indent 0 and its body de-indents to the level it had
 * before migration. Prologue lines (H1 comment, file-top IMPORTs) are kept
 * verbatim. Returns the source unchanged when no top-level block is exported.
 */
export function unwrapExportFile(body: string): string {
  const blocks = parseBlocks(body).blocks;
  if (!isExportFile(blocks)) return body;

  // Map every source line owned by an exported block to the de-indent width to
  // apply (the block's child indent). Opener lines are flagged for removal.
  // Split exactly as the lexer does so line numbers from parseBlocks align.
  const lines = body.split(/\r?\n/);
  const dedentByLine = new Map<number, number>();
  const dropLine = new Set<number>();

  for (const block of exportedBlocksOf(blocks)) {
    dropLine.add(block.startLine);
    indexBlockDedent(block, dedentByLine);
  }

  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    if (dropLine.has(lineNo)) continue;
    const dedent = dedentByLine.get(lineNo);
    out.push(dedent ? lines[index].slice(dedent) : lines[index]);
  }
  return out.join('\n');
}

/**
 * Record, for every descendant line of one exported `block`, the de-indent
 * width that restores it to the column it would occupy with the block opener
 * removed. Child indent = the indent of the block's first descendant line; the
 * codemod indents children one step deeper than the opener, so de-indenting by
 * that width lands metadata back at indent 0 and body at its pre-wrap column.
 * The single source of truth for "how far to de-indent an exported block",
 * shared by {@link unwrapExportFile} (whole file) and {@link exportedBlockBodies}
 * (per block).
 */
function indexBlockDedent(block: Block, dedentByLine: Map<number, number>): void {
  const childIndent = firstChildIndent(block.children);
  if (childIndent === null) return;
  for (const ln of descendantLines(block.children)) {
    dedentByLine.set(ln, childIndent);
  }
}

/**
 * One exported block, split into its header signature and its de-indented body.
 * `key` is the inner KIND (AGENT, ROLE, …), `name` the block name, `rest` the
 * header text after the name (e.g. `AS <role>` for an AGENT), and `body` the
 * block's children de-indented to indent 0 — ready to flow through the same
 * metadata/inline-definition pipeline a standalone file would.
 */
export interface ExportedBlockBody {
  key: string;
  name: string;
  rest: string;
  body: string;
  /** The executor mark of its head (`EXPORT PROCEDURE** name:`) — src/executor.ts. */
  executor?: number;
}

/**
 * Split a multi-export source (e.g. a flat agent file holding `EXPORT AGENT` and
 * `EXPORT ROLE`) into its exported blocks, each carrying its de-indented body.
 *
 * This is the structural counterpart to {@link unwrapExportFile}: where unwrap
 * flattens every exported block into ONE indent-0 stream (correct for a
 * single-unit module), this keeps each block's body separate so two units in one
 * file never bleed into each other. Reuses the same per-block dedent index, so
 * "how far to de-indent" lives in exactly one place.
 */
export function exportedBlockBodies(source: string): ExportedBlockBody[] {
  const lines = source.split(/\r?\n/);
  return exportedBlocksOf(parseBlocks(source).blocks).map(block => {
    const dedentByLine = new Map<number, number>();
    indexBlockDedent(block, dedentByLine);
    const out: string[] = [];
    for (const [lineNo, dedent] of [...dedentByLine.entries()].sort((left, right) => left[0] - right[0])) {
      const raw = lines[lineNo - 1] ?? '';
      out.push(dedent ? raw.slice(dedent) : raw);
    }
    return { key: block.key, name: block.name!, rest: block.rest, body: out.join('\n').trimEnd(), ...(block.executor ? { executor: block.executor } : {}) };
  });
}

/**
 * Every line of `source` NOT owned by an exported block: the prologue (imports,
 * comments) and any non-exported top-level blocks (e.g. an agent file's workflow
 * TEMPLATE/PROCEDURE/WHEN). The complement of {@link exportedBlockBodies} — same
 * line ownership computation (opener + descendants), so a flat multi-export file
 * can be split into "exported units" + "the rest" without a second line model.
 */
export function nonExportedSource(source: string): string {
  const lines = source.split(/\r?\n/);
  return nonExportedLines(source)
    .map(lineNo => lines[lineNo - 1])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The 1-based numbers of the lines {@link nonExportedSource} keeps, in order —
 * the one line-ownership computation, so a caller composing a text from them
 * knows which file line each one was.
 */
export function nonExportedLines(source: string): number[] {
  const owned = new Set<number>();
  for (const block of exportedBlocksOf(parseBlocks(source).blocks)) {
    owned.add(block.startLine);
    // The decorators above an exported block are its own: they travel with it (src/sources.ts span).
    for (const decorator of block.decorators ?? []) owned.add(decorator.line);
    const dedentByLine = new Map<number, number>();
    indexBlockDedent(block, dedentByLine);
    for (const lineNo of dedentByLine.keys()) owned.add(lineNo);
  }
  return source.split(/\r?\n/).map((_line, idx) => idx + 1).filter(lineNo => !owned.has(lineNo));
}

/**
 * The well-formed EXPORT units of a parsed file: top-level blocks carrying the
 * EXPORT modifier with a resolved name. The name guard is the severe variant —
 * an exported block without a name is already a parse error (flagged separately
 * by parseBlocks), so guarding it here drops nothing real while letting callers
 * treat every returned block as named.
 *
 * The single predicate behind "what does this file export"; consumers that need
 * the units use this, and the file-level gate {@link isExportFile} derives from it.
 */
export function exportedBlocksOf(blocks: Block[]): Block[] {
  return blocks.filter(block => block.exported && block.name !== null);
}

/** True when the file declares at least one well-formed EXPORT unit. */
export function isExportFile(blocks: Block[]): boolean {
  return exportedBlocksOf(blocks).length > 0;
}

type Children = ReturnType<typeof parseBlocks>['blocks'][number]['children'];

/** Indent of the first descendant line of `children`, or null when empty. */
function firstChildIndent(children: Children): number | null {
  return children.length > 0 ? children[0].indent : null;
}

/** Every source line number under `children`, recursively (lines and nested blocks). */
function descendantLines(children: Children): number[] {
  const out: number[] = [];
  for (const child of children) {
    if (child.type === 'line') {
      out.push(child.line);
    } else {
      // The decorators right above a block are its lines too (src/decorators.ts).
      for (const decorator of child.decorators ?? []) out.push(decorator.line);
      out.push(child.startLine);
      out.push(...descendantLines(child.children));
    }
  }
  return out;
}

/**
 * Find the first top-level (indent 0) `<KEYWORD> <rest>` line and return its
 * rest. Driven by the shared lexer; indented occurrences (inside code fences,
 * nested examples) are intentionally ignored — only declarations at column 0
 * count as metadata.
 */
export function extractPrimitive(body: string, keyword: Keyword): string | null {
  // TRANSITIONAL: see unwrapExportFile — exposes EXPORT-block metadata at indent 0.
  for (const token of lex(unwrapExportFile(body))) {
    if (token.kind === 'keyword' && token.indent === 0 && token.keyword === keyword && token.rest) return token.rest;
  }
  return null;
}

/** All top-level `<KEYWORD> <rest>` lines, in order, returned as their `rest`. */
export function extractPrimitives(body: string, keyword: Keyword): string[] {
  const out: string[] = [];
  // TRANSITIONAL: see unwrapExportFile — exposes EXPORT-block metadata at indent 0.
  for (const token of lex(unwrapExportFile(body))) {
    if (token.kind === 'keyword' && token.indent === 0 && token.keyword === keyword && token.rest) out.push(token.rest);
  }
  return out;
}

/**
 * Remove every top-level (indent 0) line whose keyword is in the given set.
 * Indented occurrences are preserved verbatim (they may be inside RAW blocks
 * or nested examples). Blanks and unknown lines are preserved. Comment lines
 * (#-prefixed) are stripped — they are compiler-internal. Leading blank lines
 * are stripped.
 */
export function stripPrimitives(body: string, ...keywords: Keyword[]): string {
  const set = new Set<string>(keywords);
  const out: string[] = [];
  // TRANSITIONAL: see unwrapExportFile — drops the EXPORT opener and de-indents
  // the block body so the indent-0 strip below matches the legacy output byte-for-byte.
  for (const token of lex(unwrapExportFile(body))) {
    if (token.kind === 'comment') continue;
    if (token.kind === 'keyword' && token.indent === 0 && set.has(token.keyword)) continue;
    out.push(token.kind === 'blank' ? '' : ('raw' in token ? token.raw : ''));
  }
  return out.join('\n').replace(/^\n+/, '');
}

/**
 * The role's identity, lifted out of its rule body.
 *
 * The block name IS the role (its display name is the de-slugified name); a role
 * optionally declares ABOUT and EXPERTISE. The agent that binds it via
 * `AS <role>` renders them in its `# Identity` block. `rules` is the body with
 * the ABOUT/APPLIES/EXPERTISE lines removed — only the behaviours
 * (ALWAYS/NEVER/WHEN/…) remain, to fuse into Identity or render in the Roles
 * chapter. Single source of truth for both the imported role-file and inline
 * (`ROLE <role>:`) paths.
 */
export interface RoleIdentity {
  about: string | null;
  expertise: string | null;
  rules: string;
}

export function liftRoleIdentity(body: string): RoleIdentity {
  return {
    about: extractPrimitive(body, 'ABOUT'),
    expertise: extractPrimitive(body, 'EXPERTISE'),
    rules: stripPrimitives(body, 'ABOUT', 'APPLIES', 'EXPERTISE'),
  };
}

/**
 * One-shot extract + strip: lex the source once, collect rest values for the
 * requested keywords, and emit the body without those lines. Replaces
 * `extractPrimitives + stripPrimitives` chains, halving the number of lex
 * calls per source file.
 */
export function partitionMetadata(
  body: string,
  keywords: Keyword[],
): { metadata: Map<Keyword, string[]>; stripped: string } {
  const set = new Set<string>(keywords);
  const metadata = new Map<Keyword, string[]>();
  const out: string[] = [];
  // TRANSITIONAL: see unwrapExportFile — exposes EXPORT-block metadata at indent 0
  // and de-indents the body so extract + strip match the legacy output byte-for-byte.
  for (const token of lex(unwrapExportFile(body))) {
    if (token.kind === 'comment') continue;
    if (token.kind === 'keyword' && token.indent === 0 && set.has(token.keyword)) {
      if (token.rest) {
        const arr = metadata.get(token.keyword) ?? [];
        arr.push(token.rest);
        metadata.set(token.keyword, arr);
      }
      continue;
    }
    out.push(token.kind === 'blank' ? '' : ('raw' in token ? token.raw : ''));
  }
  return { metadata, stripped: out.join('\n').replace(/^\n+/, '') };
}

/**
 * Merge `source` metadata into `target` in place. ABOUT is first-wins (the
 * first non-empty value sticks across multiple source files). All other
 * keywords accumulate.
 */
export function mergeMetadata(
  target: Map<string, string[]>,
  source: Map<string, string[]>,
): void {
  for (const [keyword, vs] of source) {
    if (keyword === 'ABOUT' && target.has('ABOUT')) continue;
    target.set(keyword, [...(target.get(keyword) ?? []), ...vs]);
  }
}

export function extractAbout(body: string): string | null {
  return extractPrimitive(body, 'ABOUT');
}

/**
 * Strip ABOUT metadata from `.ap` source via the lexer, which also drops `#`
 * comment lines. For plain-markdown shared blocks whose `#` headings must
 * survive, use `stripAboutPreservingMarkdown` in bundleDefaults.ts instead —
 * the two are a deliberately matched pair, kept apart by that one difference.
 */
export function stripAbout(body: string): string {
  return stripPrimitives(body, 'ABOUT');
}

// ---------------------------------------------------------------------------
// Verbatim protection
// ---------------------------------------------------------------------------

/**
 * The ONE exception mechanism for content the compiler must NOT recursively
 * compile. Content wrapped with `markVerbatim` is shielded from every post-emit
 * rewrite pass (substitutions, force-levels, control-flow): the agent receives
 * it exactly as written. Used for a TEMPLATE's BODY layout and EXAMPLE block —
 * and available to any other block that must pass through untouched.
 *
 * Producers call `markVerbatim(content)`; the single post-process driver wraps
 * its passes in `protectVerbatim`, which masks every marked region, runs the
 * passes on the rest, then splices the regions back in unchanged. The markers
 * are distinctive ASCII tokens that no pass (and no real source) matches.
 */
const VERBATIM_OPEN = '<<<VERBATIM>>>';
const VERBATIM_CLOSE = '<<</VERBATIM>>>';
const VERBATIM_RE = /<<<VERBATIM>>>([\s\S]*?)<<<\/VERBATIM>>>/g;

export function markVerbatim(content: string): string {
  return `${VERBATIM_OPEN}${content}${VERBATIM_CLOSE}`;
}

export function protectVerbatim(text: string, transform: (masked: string) => string): string {
  const stash: string[] = [];
  const masked = text.replace(VERBATIM_RE, (_m, inner: string) => {
    stash.push(inner);
    return `<<<VB${stash.length - 1}>>>`;
  });
  return transform(masked).replace(/<<<VB(\d+)>>>/g, (_m, index) => stash[Number(index)]);
}

/**
 * Render a labelled bullet group. With one value renders inline (`<intro> <v>`);
 * with multiple values renders as `<intro>:` followed by `- v1`, `- v2`, …
 *
 * Shared by ForceLevels (per-keyword consecutive grouping) and primitives that
 * need the same shape (e.g. WHEN — several trigger lines).
 */
export function renderKeywordBlock(intro: string, values: string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return `${intro} ${values[0]}`;
  const header = intro.endsWith(':') ? intro : `${intro}:`;
  return `${header}\n${values.map(value => `- ${value}`).join('\n')}`;
}

/**
 * Lower-case the IF/ELSE/UNTIL keywords and append a trailing colon when
 * missing — all signal "the indented block below is the body of this head"
 * in a way the LLM reads natively (Python/YAML idiom). UNTIL is the loop
 * exit-condition counterpart of IF.
 *
 * Driven by the lexer's keyword recognition rather than ad-hoc regex.
 */
export const CONTROL_FLOW_HEADS: Partial<Record<string, string>> = Object.fromEntries(
  (['IF', 'ELSE', 'UNTIL', 'STEP', 'IN'] as const).map(keyword => [keyword, FORMULAS.keywords[keyword].head]),
);

export function renderControlFlow(text: string): string {
  const tokens = lex(text);
  return tokens.map(token => {
    if (token.kind === 'keyword' && CONTROL_FLOW_HEADS[token.keyword]) {
      const indent = ' '.repeat(token.indent);
      const head = CONTROL_FLOW_HEADS[token.keyword]!;
      if (token.rest) {
        const rest = token.rest.endsWith(':') ? token.rest.slice(0, -1).trimEnd() : token.rest;
        return `${indent}${head} ${rest}:`;
      }
      return `${indent}${head}:`;
    }
    if (token.kind === 'blank') return '';
    return 'raw' in token ? token.raw : '';
  }).join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// String similarity
// ────────────────────────────────────────────────────────────────────────────

export const SIMILARITY_RATIO_THRESHOLD = 0.25;

/**
 * Plain dynamic-programming Levenshtein distance. O(|first|·|second|).
 * Returns the minimum number of single-character edits (insert, delete, replace)
 * needed to transform `first` into `second`.
 */
export function levenshtein(first: string, second: string): number {
  const firstLength = first.length;
  const secondLength = second.length;

  let prev = Array.from({ length: secondLength + 1 }, (_cell, index) => index);
  let curr = new Array<number>(secondLength + 1);

  for (let row = 1; row <= firstLength; row++) {
    curr[0] = row;
    for (let column = 1; column <= secondLength; column++) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      curr[column] = Math.min(
        curr[column - 1] + 1,
        prev[column] + 1,
        prev[column - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[secondLength];
}

/**
 * Levenshtein ratio = distance / max(len(first), len(second)).
 * Returns 1 when both strings are empty (edge case: no similarity risk).
 */
export function levenshteinRatio(first: string, second: string): number {
  const maxLen = Math.max(first.length, second.length);
  if (maxLen === 0) return 1;
  return levenshtein(first, second) / maxLen;
}

/** True when `first` is a substring of `second` or `second` is a substring of `first`. */
export function isSubstring(first: string, second: string): boolean {
  return first.includes(second) || second.includes(first);
}

/**
 * True when `first` and `second` are similar enough to be considered conflicting.
 *
 * Criterion (OR):
 *   - Levenshtein ratio ≤ SIMILARITY_RATIO_THRESHOLD
 *   - One is a substring of the other
 *
 * Identical strings return false.
 */
export function areSimilar(first: string, second: string): boolean {
  if (first === second) return false;
  return isSubstring(first, second) || levenshteinRatio(first, second) <= SIMILARITY_RATIO_THRESHOLD;
}

/** First entry in `existing` similar to `candidate`, or null when none. */
export function findSimilar(candidate: string, existing: Iterable<string>): string | null {
  for (const known of existing) {
    if (areSimilar(candidate, known)) return known;
  }
  return null;
}
