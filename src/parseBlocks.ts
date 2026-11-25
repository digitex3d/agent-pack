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

import { DECORATOR_MARK, decoratorOf, placementMessage, danglingDecoratorMessage, emptyDecoratorMessage, definitionInDecoratorMessage, type DecoratorLine } from './decorators.js';
import { lex, type Token } from './lexer.js';
import { blockTypeOf, EXPORT_MODIFIER, AGENT_KEYS } from './blockTypes.js';
import { computeHead, splitExecutorMark } from './executor.js';
import { parseExportedVar, type VarDecl } from './vars.js';

/** Why an indented EXPORT is refused — a block's or a variable's alike. */
const EXPORT_TOP_LEVEL_ONLY = 'EXPORT is only allowed on a top-level block';

/** The key of the block an `EXPORT VAR` line becomes. */
export const EXPORTED_VAR_KEY = 'VAR';

/** Whether a block is an exported variable — the one test of every reader. */
export function isExportedVar(block: Block): block is Block & { variable: VarDecl } {
  return block.key === EXPORTED_VAR_KEY && block.variable !== undefined;
}

/** An `EXPORT … VAR …` line — the lexer gives it the keyword EXPORT (a block's EXPORT opens a block). */
export function exportedVar(token: Token): Extract<Token, { kind: 'keyword' }> | null {
  return token.kind === 'keyword' && token.keyword === EXPORT_MODIFIER ? token : null;
}

/** An `EXPORT … VAR …` line's declaration, or what is wrong with it — the parser's and the lint's one check. */
export function readExportedVar(token: Extract<Token, { kind: 'keyword' }>): VarDecl | { error: string } {
  if (token.indent > 0) return { error: EXPORT_TOP_LEVEL_ONLY };
  return parseExportedVar(token.rest) ?? { error: `\`EXPORT ${token.rest}\` is no declaration — write \`EXPORT VAR <name>\`` };
}

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
  /** The executor mark of a `PROCEDURE*` / `PROCEDURE**` head (src/executor.ts); absent = the agent. */
  executor?: number;
  /** A `COMPUTE <name>:` block — read as a PROCEDURE** whose body holds REQUIRE / RETURN AS / ENSURE. */
  computed?: boolean;
  /** An exported variable's declaration — set on the block an `EXPORT VAR` line becomes. */
  variable?: VarDecl;
  /** The decorators written right above it (`@WITHIN web`), in order (src/decorators.ts). */
  decorators?: DecoratorLine[];
  /** Set on the block a decorator opens (`@WITHIN web:`): its key is `@WITHIN`, its children the lines it decorates. */
  decorator?: DecoratorLine;
}

export type Node = Block | Line;

export interface ParseError {
  line: number;
  message: string;
  /** A decorator that decorates no block — the one parse error the lint reports as is (src/decorators.ts). */
  decorator?: true;
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
function asBlockOpener(token: Token): { key: string; rest: string; executor?: number } | null {
  if (token.kind === 'blockOpener') return { key: token.key, rest: token.rest };
  if (token.kind === 'keyword') {
    const trimmed = token.rest.trimEnd();
    if (trimmed.endsWith(':')) {
      return { key: String(token.keyword), rest: trimmed.slice(0, -1).trim(), ...(token.executor ? { executor: token.executor } : {}) };
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
  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return { name: null, rest: '' };
  // Defensive cleanup: users sometimes write `PROCEDURE foo : ` with a
  // space before the colon, so the colon survives the lexer's strip.
  const name = match[1].replace(/:$/, '');
  return { name: name === '' ? null : name, rest: (match[2] ?? '').trim() };
}

/**
 * Outcome of unwrapping an `EXPORT <KIND> <name>:` modifier opener.
 * `ok` carries the inner opener (the KIND becomes the block key, the remainder
 * is the name-source rest) ready to flow through `splitNameAndRest`; `error`
 * carries a parser diagnostic message for a malformed EXPORT header.
 */
type ExportResolution =
  | { ok: true; inner: { key: string; rest: string; executor?: number } }
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
  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  // `trimmed` is non-empty, so the leading-token match always succeeds.
  // `EXPORT PROCEDURE** name:` — the stars are the head's executor mark (src/executor.ts).
  const { word: kind, executor } = splitExecutorMark(match![1].replace(/:$/, ''));
  const tail = (match![2] ?? '').trim();

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
  return { ok: true, inner: { key: kind, rest: tail, ...(executor ? { executor } : {}) } };
}

/**
 * The blocks declared directly in an agent's body (an AGENT or SKILL block of
 * `blocks`) — of `key` when given — each with the agent that owns it. One level
 * down only: a block nested deeper (in a PROCEDURE, say) is not the agent's.
 */
export function agentNestedBlocks(blocks: readonly Block[], key?: string): { agent: Block; block: Block }[] {
  return blocks.filter(candidate => AGENT_KEYS.has(candidate.key)).flatMap(agent => agent.children
    .filter((child): child is Block => child.type === 'block' && (key === undefined || child.key === key))
    .map(block => ({ agent, block })));
}

export function parseBlocks(source: string): ParseResult {
  const tokens = lex(source);
  const errors: ParseError[] = [];
  const blocks: Block[] = [];
  const prologue: Token[] = [];

  // --- Phase 1: collect prologue (blanks, comments, top-level IMPORTs) ---
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (asBlockOpener(token) !== null || exportedVar(token)?.indent === 0 || token.kind === 'decorator') break;
    if (token.kind === 'blank' || token.kind === 'comment') {
      prologue.push(token);
      index++;
      continue;
    }
    if (token.kind === 'keyword' && token.indent === 0 && token.keyword === 'IMPORT') {
      prologue.push(token);
      index++;
      continue;
    }
    // Anything else before the first block-opener is illegal. Every token
    // that reaches this point carries `line` and `raw` (blank+comment were
    // consumed above; block-openers exit the loop above).
    const raw = 'raw' in token ? token.raw : '';
    errors.push({
      line: token.line,
      message: `content before first primitive header: "${raw.trim()}"`,
    });
    index++;
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

  // The decorators read above the next block, waiting for it (src/decorators.ts).
  let pending: (DecoratorLine & { indent: number })[] = [];
  const dangling = (): void => {
    for (const decorator of pending) errors.push({ line: decorator.line, message: danglingDecoratorMessage(decorator.key), decorator: true });
    pending = [];
  };
  /** The decorators the block `key` opened at `indent` takes: those right above it, at its indent — each where it may stand. */
  const takePending = (indent: number, key: string): DecoratorLine[] | undefined => {
    if (pending.length === 0) return undefined;
    if (pending.some(decorator => decorator.indent !== indent)) { dangling(); return undefined; }
    for (const decorator of pending) placed(decorator, key);
    const taken = pending.map(({ key, rest, line }) => ({ key, rest, line }));
    pending = [];
    return taken;
  };
  /** A decorator held to some blocks, above another one (`block`) or opening one (null): the error, once. */
  const placed = (decorator: { key: string; line: number }, block: string | null): void => {
    const spec = decoratorOf(decorator.key);
    const message = spec ? placementMessage(spec, block) : null;
    if (message) errors.push({ line: decorator.line, message, decorator: true });
  };

  while (index < tokens.length) {
    const token = tokens[index++];

    if (token.kind === 'blank' || token.kind === 'comment') continue;

    if (token.kind === 'decorator') {
      if (!token.opens) {
        pending.push({ key: token.key, rest: token.rest, line: token.line, indent: token.indent });
        continue;
      }
      popUntilParentOf(token.indent);
      const above = takePending(token.indent, `${DECORATOR_MARK}${token.key}`);
      placed(token, null);
      const block: Block = {
        type: 'block', key: `${DECORATOR_MARK}${token.key}`, name: null, rest: token.rest, children: [],
        startLine: token.line, indent: token.indent, exported: false, decorator: { key: token.key, rest: token.rest, line: token.line },
        ...(above ? { decorators: above } : {}),
      };
      addNode(block);
      stack.push(block);
      continue;
    }

    // `EXPORT VAR x` is a declaration a module exports: a top-level block with
    // no body, named by its variable, so IMPORT resolves it like any export.
    // Indented, it is no declaration — a template's literal text, or the lint's error.
    const ev = exportedVar(token);
    if (ev && ev.indent === 0) {
      const decl = readExportedVar(ev);
      if (ev.indent === 0) popUntilParentOf(0);
      if ('error' in decl) errors.push({ line: ev.line, message: decl.error });
      else blocks.push({ type: 'block', key: EXPORTED_VAR_KEY, name: decl.name, rest: ev.rest, children: [], startLine: ev.line, indent: 0, exported: true, variable: decl });
      continue;
    }

    const bo = asBlockOpener(token);
    if (bo !== null && 'indent' in token) {
      popUntilParentOf(token.indent);

      // EXPORT is a visibility modifier wrapping an inner block. Unwrap it to
      // the inner KIND + name and flag the block exported. The modifier key
      // itself never reaches the AST.
      let opener = bo;
      let exported = false;
      let modifierFailed = false;
      if (bo.key === EXPORT_MODIFIER) {
        if (token.indent > 0) {
          // Only a top-level block can be exported. Reject the modifier but
          // still parse the inner block (private) so its children stay nested.
          errors.push({
            line: token.line,
            message: EXPORT_TOP_LEVEL_ONLY,
          });
        }
        const resolved = resolveExportModifier(bo.rest);
        if (resolved.ok) {
          opener = resolved.inner;
          exported = token.indent === 0;
        } else {
          errors.push({ line: token.line, message: resolved.error });
          modifierFailed = true;
          // Unresolvable EXPORT header: keep the raw opener as the block key so
          // the indent stack stays consistent for any indented children.
        }
      }

      const { name, rest } = splitNameAndRest(opener.rest);
      // `COMPUTE <name>:` is a procedure a program carries out — src/executor.ts.
      const compute = computeHead(opener.key);
      if (compute) opener = { ...opener, key: compute.key, executor: compute.executor };
      const above = takePending(token.indent, opener.key);
      const block: Block = {
        type: 'block',
        key: opener.key,
        name,
        rest,
        children: [],
        startLine: token.line,
        indent: token.indent,
        exported,
        ...(opener.executor ? { executor: opener.executor } : {}),
        ...(compute ? { computed: true } : {}),
        ...(above ? { decorators: above } : {}),
      };
      // Registered primitives must declare a name. Control-flow keys (WHEN,
      // IF, ELSE) are not registered and bypass this check — their lack of
      // an identifier is by design, not an authoring mistake. A failed EXPORT
      // modifier has already reported its own diagnostic — don't pile on.
      if (!modifierFailed && blockTypeOf(opener.key) !== null && name === null) {
        errors.push({
          line: token.line,
          message: `${opener.key} requires a name`,
        });
      }
      addNode(block);
      stack.push(block);
      continue;
    }

    if (token.kind === 'keyword') {
      dangling();
      popUntilParentOf(token.indent);
      addNode({
        type: 'line',
        keyword: String(token.keyword),
        rest: token.rest,
        raw: token.raw,
        line: token.line,
        indent: token.indent,
      });
      continue;
    }

    if (token.kind === 'procRef' || token.kind === 'unknown') {
      dangling();
      // Opaque content — attach to the current block under a sentinel keyword
      // so PR3 renderers can roundtrip them verbatim. No error: the lexer's
      // `unknown` already signals weirdness; failing the parse would be too
      // aggressive while the bundler still routes some pass-through prose.
      const indent = 'indent' in token ? token.indent : 0;
      popUntilParentOf(indent);
      const raw = 'raw' in token ? token.raw : '';
      const line = 'line' in token ? token.line : 0;
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

  dangling();
  // A decorator's block holds the lines it decorates: one that holds none says nothing, and a definition is decorated from above.
  const emptyDecorators = (bs: readonly Node[]): void => {
    for (const node of bs) {
      if (node.type !== 'block') continue;
      if (node.decorator && node.children.length === 0) errors.push({ line: node.startLine, message: emptyDecoratorMessage(node.decorator.key), decorator: true });
      if (node.decorator) {
        for (const child of node.children) {
          if (child.type === 'block' && !child.decorator && blockTypeOf(child.key)) errors.push({ line: child.startLine, message: definitionInDecoratorMessage(node.decorator.key, child.key), decorator: true });
        }
      }
      emptyDecorators(node.children);
    }
  };
  emptyDecorators(blocks);

  // --- Phase 3: validate uniqueness of (key, name) across the file ---
  const seen = new Map<string, number>();
  const walkForDup = (bs: Block[]): void => {
    for (const block of bs) {
      if (block.name !== null) {
        const key = `${block.key}::${block.name}`;
        const prior = seen.get(key);
        if (prior !== undefined) {
          errors.push({
            line: block.startLine,
            message: `duplicate primitive ${block.key.toLowerCase()} ${block.name} (first declared at line ${prior})`,
          });
        } else {
          seen.set(key, block.startLine);
        }
      }
      walkForDup(block.children.filter((child): child is Block => child.type === 'block'));
    }
  };
  walkForDup(blocks);

  if (blocks.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: 'file contains no primitive blocks' });
  }

  return { prologue, blocks, errors };
}
