// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Universal parser for `.ap` source.
 *
 * The grammar collapses to ONE shape:
 *
 *   <KEY>[ <name-or-rest>]:
 *     <indented body — lines or further blocks>
 *
 * Discriminator between block-opener and leaf line is the trailing `:` on
 * the header line; the lexer already emits `blockOpener` tokens for those.
 * This parser walks the token stream, uses indentation to nest blocks
 * (Python-style), and asks the BlockType registry whether each key carries
 * a name or a free-form `rest`.
 *
 * The parser is kind-agnostic: it has no special case for any primitive.
 * Semantics (rendering, frontmatter, validation) live in BLOCK_TYPES.
 */

import { lex, Token } from './lexer.js';
import { blockTypeOf, EXPORT_MODIFIER } from './blockTypes.js';

export interface Line {
  type: 'line';
  /** The DSL keyword as emitted by the lexer (DO, RUN, ALWAYS, MUST!, …). */
  keyword: string;
  /** Post-keyword text. */
  rest: string;
  raw: string;
  line: number;
  indent: number;
}

export interface Block {
  type: 'block';
  /** Uppercase block key — e.g. PROCEDURE, AGENT, WHEN. */
  key: string;
  /**
   * Block identifier when the BlockType registry says `hasName`; null when
   * the block is nameless (WHEN, IF, ELSE) or when the source
   * omitted the name on a name-bearing block (an error logged separately).
   */
  name: string | null;
  /**
   * Free-form trailing text on the header line. For name-bearing blocks
   * this is whatever follows the name. For nameless blocks this is the
   * trigger phrase / condition. May be the empty string.
   */
  rest: string;
  children: Node[];
  startLine: number;
  /** Indent at which the header was declared — children must indent further. */
  indent: number;
  /**
   * True when the block carried the `EXPORT` modifier (`EXPORT <KIND> <name>:`),
   * marking it as the importable/embeddable unit. False for plain top-level
   * blocks (file-local helpers) and for nested blocks. The modifier key never
   * appears in `key`; only the inner KIND does.
   */
  exported: boolean;
}

export type Node = Block | Line;

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  /**
   * Tokens that appear before the first block-opener. Allowed: blank,
   * comment, and top-level `IMPORT` keyword lines. Anything else here
   * produces an error in `errors`.
   */
  prologue: Token[];
  /** Top-level blocks in source order. */
  blocks: Block[];
  /** Diagnostics — empty when the source is well-formed. */
  errors: ParseError[];
}

/**
 * Recognise a block-opener regardless of whether the lexer emitted it as a
 * dedicated `blockOpener` token (new-key path: POLICY, AGENT, …)
 * or as a legacy `keyword` token whose `rest` ends with `:` (existing-key
 * path: PROCEDURE, TEMPLATE, STEP, WHEN, IF, FLOW). Returns the normalised
 * `{ key, rest }` pair, or null when the token is not a block-opener.
 */
function asBlockOpener(t: Token): { key: string; rest: string } | null {
  if (t.kind === 'blockOpener') return { key: t.key, rest: t.rest };
  if (t.kind === 'keyword') {
    const trimmed = t.rest.trimEnd();
    if (trimmed.endsWith(':')) {
      return { key: String(t.keyword), rest: trimmed.slice(0, -1).trim() };
    }
  }
  return null;
}

/**
 * Universal split: first whitespace-delimited token is the block's name,
 * everything after is free-form `rest`. Applies uniformly to every block
 * (primitive declarations AND control-flow constructs): there is no longer
 * a `hasName` switch — every block is treated as named. For control-flow
 * keys (WHEN, IF, ELSE) the "name" is just the first word of the trigger
 * phrase; semantically loose but uniform.
 */
function splitNameAndRest(rest: string): { name: string | null; rest: string } {
  const trimmed = rest.trim();
  if (trimmed === '') return { name: null, rest: '' };
  const m = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return { name: null, rest: '' };
  // Defensive cleanup: users sometimes write `PROCEDURE foo : ` with a
  // space before the colon, so the colon survives the lexer's strip.
  const name = m[1].replace(/:$/, '');
  return { name: name === '' ? null : name, rest: (m[2] ?? '').trim() };
}

/**
 * Outcome of unwrapping an `EXPORT <KIND> <name>:` modifier opener.
 * `ok` carries the inner opener (the KIND becomes the block key, the remainder
 * is the name-source rest) ready to flow through `splitNameAndRest`; `error`
 * carries a parser diagnostic message for a malformed EXPORT header.
 */
type ExportResolution =
  | { ok: true; inner: { key: string; rest: string } }
  | { ok: false; error: string };

/**
 * Unwrap an `EXPORT <KIND> <name>` opener into its inner block opener.
 *
 * EXPORT is a visibility modifier, not a primitive of its own: the importable
 * unit is the inner block (`POLICY context-engineering`) marked exported. The
 * modifier `rest` is `<KIND> <name…>`; the first whitespace token is the inner
 * KIND, which must be a registered (non-modifier) block type, and everything
 * after is the name source.
 *
 * A single token is ambiguous: `EXPORT POLICY:` is a KIND with no name, while
 * `EXPORT context-engineering:` is a name with no KIND. We disambiguate by
 * asking the registry whether that token is itself a block type.
 */
function resolveExportModifier(rest: string): ExportResolution {
  const trimmed = rest.trim();
  if (trimmed === '') {
    return { ok: false, error: 'EXPORT requires a block KIND and a name' };
  }
  const m = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  // `trimmed` is non-empty, so the leading-token match always succeeds.
  const kind = m![1].replace(/:$/, '');
  const tail = (m![2] ?? '').trim();

  const innerType = blockTypeOf(kind);
  if (innerType === null || innerType.modifier) {
    // First token is not a usable block KIND. Distinguish "no KIND at all"
    // (`EXPORT name:`, single token) from "unknown KIND" (`EXPORT Foo name:`).
    return tail === ''
      ? { ok: false, error: `EXPORT requires a block KIND before the name (got "${kind}")` }
      : { ok: false, error: `EXPORT names an unknown block KIND "${kind}"` };
  }
  if (tail === '') {
    return { ok: false, error: `EXPORT ${kind} requires a name` };
  }
  return { ok: true, inner: { key: kind, rest: tail } };
}

export function parseBlocks(source: string): ParseResult {
  const tokens = lex(source);
  const errors: ParseError[] = [];
  const blocks: Block[] = [];
  const prologue: Token[] = [];

  // --- Phase 1: collect prologue (blanks, comments, top-level IMPORTs) ---
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (asBlockOpener(t) !== null) break;
    if (t.kind === 'blank' || t.kind === 'comment') {
      prologue.push(t);
      i++;
      continue;
    }
    if (t.kind === 'keyword' && t.indent === 0 && t.keyword === 'IMPORT') {
      prologue.push(t);
      i++;
      continue;
    }
    // Anything else before the first block-opener is illegal. Every token
    // that reaches this point carries `line` and `raw` (blank+comment were
    // consumed above; block-openers exit the loop above).
    const raw = 'raw' in t ? t.raw : '';
    errors.push({
      line: t.line,
      message: `content before first primitive header: "${raw.trim()}"`,
    });
    i++;
  }

  // --- Phase 2: walk the remaining tokens, nest by indent ---
  const stack: Block[] = [];

  const popUntilParentOf = (indent: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
  };

  const addNode = (node: Node): void => {
    if (stack.length === 0) {
      if (node.type === 'block') blocks.push(node);
      else {
        errors.push({
          line: node.line,
          message: `top-level line outside any block: "${node.raw.trim()}"`,
        });
      }
    } else {
      stack[stack.length - 1].children.push(node);
    }
  };

  while (i < tokens.length) {
    const t = tokens[i++];

    if (t.kind === 'blank' || t.kind === 'comment') continue;

    const bo = asBlockOpener(t);
    if (bo !== null && 'indent' in t) {
      popUntilParentOf(t.indent);

      // EXPORT is a visibility modifier wrapping an inner block. Unwrap it to
      // the inner KIND + name and flag the block exported. The modifier key
      // itself never reaches the AST.
      let opener = bo;
      let exported = false;
      let modifierFailed = false;
      if (bo.key === EXPORT_MODIFIER) {
        if (t.indent > 0) {
          // Only a top-level block can be exported. Reject the modifier but
          // still parse the inner block (private) so its children stay nested.
          errors.push({
            line: t.line,
            message: 'EXPORT is only allowed on a top-level block',
          });
        }
        const resolved = resolveExportModifier(bo.rest);
        if (resolved.ok) {
          opener = resolved.inner;
          exported = t.indent === 0;
        } else {
          errors.push({ line: t.line, message: resolved.error });
          modifierFailed = true;
          // Unresolvable EXPORT header: keep the raw opener as the block key so
          // the indent stack stays consistent for any indented children.
        }
      }

      const { name, rest } = splitNameAndRest(opener.rest);
      const block: Block = {
        type: 'block',
        key: opener.key,
        name,
        rest,
        children: [],
        startLine: t.line,
        indent: t.indent,
        exported,
      };
      // Registered primitives must declare a name. Control-flow keys (WHEN,
      // IF, ELSE) are not registered and bypass this check — their lack of
      // an identifier is by design, not an authoring mistake. A failed EXPORT
      // modifier has already reported its own diagnostic — don't pile on.
      if (!modifierFailed && blockTypeOf(opener.key) !== null && name === null) {
        errors.push({
          line: t.line,
          message: `${opener.key} requires a name`,
        });
      }
      addNode(block);
      stack.push(block);
      continue;
    }

    if (t.kind === 'keyword') {
      popUntilParentOf(t.indent);
      addNode({
        type: 'line',
        keyword: String(t.keyword),
        rest: t.rest,
        raw: t.raw,
        line: t.line,
        indent: t.indent,
      });
      continue;
    }

    if (t.kind === 'procRef' || t.kind === 'unknown' || t.kind === 'rawLine') {
      // Opaque content — attach to the current block under a sentinel keyword
      // so PR3 renderers can roundtrip them verbatim. No error: the lexer's
      // `unknown` already signals weirdness; failing the parse would be too
      // aggressive while the bundler still routes some pass-through prose.
      const indent = 'indent' in t ? t.indent : 0;
      popUntilParentOf(indent);
      const raw = 'raw' in t ? t.raw : '';
      const line = 'line' in t ? t.line : 0;
      addNode({
        type: 'line',
        keyword: '__opaque__',
        rest: raw,
        raw,
        line,
        indent,
      });
    }
  }

  // --- Phase 3: validate uniqueness of (key, name) across the file ---
  const seen = new Map<string, number>();
  const walkForDup = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.name !== null) {
        const k = `${b.key}::${b.name}`;
        const prior = seen.get(k);
        if (prior !== undefined) {
          errors.push({
            line: b.startLine,
            message: `duplicate primitive ${b.key.toLowerCase()} ${b.name} (first declared at line ${prior})`,
          });
        } else {
          seen.set(k, b.startLine);
        }
      }
      walkForDup(b.children.filter((c): c is Block => c.type === 'block'));
    }
  };
  walkForDup(blocks);

  if (blocks.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: 'file contains no primitive blocks' });
  }

  return { prologue, blocks, errors };
}
