// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Extract inline `<KIND> <name>: <body>` blocks from an agent or skill
 * body and route them through the SAME collection path used for imported
 * kind files.
 *
 * Symmetry with `resolveFile`:
 *   resolveFile collects an imported procedure into `ctx.procedures`
 *   as a Definition. extractInlineDefinitions does the same for an inline
 *   `PROCEDURE foo:` block found in the agent's own file. Downstream
 *   `emitCollectedSections` is agnostic about the origin — the chapter,
 *   numbering, RUN resolution, and `AS` back-reference all work
 *   identically.
 *
 * Reuses STRATEGIES → every kind with a `headerKeyword` (procedure,
 * template, flow) is supported automatically. Adding inline support for a
 * new kind costs zero lines here.
 */

import { lex, opensBlock } from '../lexer.js';
import { EXPORT_MODIFIER } from '../blockTypes.js';
import { computeHead, splitExecutorMark } from '../executor.js';
import { STRATEGIES, type DefinitionStrategy, type Definition } from '../definition.js';
import type { BundleContext } from './types.js';
import { liftRoleIdentity } from '../services/text.js';
import { deslugifyRole } from '../services/role.js';
import { extendInlineRole } from './role.js';
import { liftUnitMetadata } from '../ingest.js';

interface InlineHeader {
  /** 1-based line of the `KEYWORD name:` line. */
  startLine: number;
  /** Indentation of the header (must be 0 for top-level extraction). */
  indent: number;
  /** Block name. */
  name: string;
  /** The executor mark of a `PROCEDURE*` / `PROCEDURE**` head — src/executor.ts. */
  executor?: number;
  /** Strategy resolved from the header keyword. */
  strat: DefinitionStrategy;
}

/**
 * Discover top-level (`indent === 0`) block-opener tokens whose key matches
 * a STRATEGIES entry with a non-null headerKeyword. Returns headers in source
 * order.
 *
 * Recognises both token shapes the lexer can emit:
 *   - `blockOpener` (new keys: POLICY, AGENT, …) — gated by the
 *     lexer for keys outside its legacy whitelist.
 *   - `keyword` with `rest` ending in `:` (existing keys: PROCEDURE,
 *     TEMPLATE, FLOW, STEP, WHEN, IF) — the legacy lexer emits these as
 *     keyword tokens, so we recognise the trailing colon as the
 *     block-opener marker.
 */
function findInlineHeaders(rawBody: string): InlineHeader[] {
  const headers: InlineHeader[] = [];
  for (const token of lex(rawBody)) {
    if (!('indent' in token) || token.indent !== 0) continue;
    let key: string | null = null;
    let rest = '';
    let executor = token.kind === 'keyword' ? token.executor ?? 0 : 0;
    if (token.kind === 'blockOpener') {
      key = token.key;
      rest = token.rest;
    } else if (token.kind === 'keyword') {
      // Legacy keyword block openers. The trailing colon is optional: PROCEDURE
      // and TEMPLATE write `KIND name:`, but FLOW writes `FLOW name` (no colon).
      // Non-strategy keywords (WHEN/IF/STEP/…) are filtered out below.
      key = String(token.keyword);
      const trimmed = token.rest.trimEnd();
      rest = trimmed.endsWith(':') ? trimmed.slice(0, -1).trim() : trimmed;
    }
    if (key === null) continue;

    // `EXPORT <KIND> <name>:` — EXPORT is a modifier wrapping another block
    // type (blockTypes.ts), so the real key is the next word. Without this an
    // export declared INSIDE an agent file fell through a gap: it matched no
    // strategy here, so it was never collected, and it is not in a library
    // root, so `RUN` resolution could not find it either — the block vanished
    // in silence, with only an unrelated warning about the RUN target.
    // An export declared in an agent file is that agent's own: nobody can
    // import it, but it must be visible in its own scope.
    if (key === EXPORT_MODIFIER) {
      const space = rest.indexOf(' ');
      if (space === -1) continue;
      ({ word: key, executor } = splitExecutorMark(rest.slice(0, space)));
      rest = rest.slice(space + 1).trim();
    }

    // `COMPUTE <name>:` is a procedure a program carries out — src/executor.ts. Without
    // its colon, `COMPUTE …` is a line a program carries out, never a block.
    const compute = key !== null ? computeHead(key) : null;
    if (compute && token.kind === 'keyword' && !opensBlock(token)) continue;
    if (compute) ({ key, executor } = compute);
    const strat = STRATEGIES.find(strategy => strategy.headerKeyword === key);
    if (!strat) continue;
    const name = rest.split(/\s+/)[0] ?? '';
    if (!name) continue;
    headers.push({ startLine: token.line, indent: 0, name, strat, ...(executor ? { executor } : {}) });
  }
  return headers;
}

/**
 * Find the line at which a header's block ends — the next indent-0 non-blank
 * non-comment line after `startLine`, or `totalLines + 1` when no such line
 * exists (block extends to EOF).
 */
function findBlockEndLine(rawBody: string, startLine: number, totalLines: number): number {
  for (const token of lex(rawBody)) {
    if (!('indent' in token)) continue;
    if (token.kind === 'blank' || token.kind === 'comment') continue;
    if (token.indent !== 0) continue;
    if (token.line > startLine) return token.line;
  }
  return totalLines + 1;
}

/** Dedent every line in `lines` by the smallest common leading-whitespace prefix. */
function dedent(lines: string[]): string {
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = line.match(/^[ \t]*/);
    if (match && match[0].length < minIndent) minIndent = match[0].length;
  }
  if (minIndent === Infinity || minIndent === 0) {
    return lines.join('\n').trimEnd();
  }
  return lines
    .map(line => (line.length >= minIndent ? line.slice(minIndent) : line))
    .join('\n')
    .trimEnd();
}

/**
 * Mirror of `resolveFile`'s `collectIfKind`: synthesise a Definition for an
 * inline block and push it into the matching ctx collection. Reports a lint
 * error and skips on name collision with an already-collected entry of the
 * same kind (imported or inline).
 */
function collectInlineDefinition(
  strat: DefinitionStrategy,
  name: string,
  body: string,
  sourcePath: string,
  line: number,
  ctx: BundleContext,
  executor?: number,
): boolean {
  const collection = strat.getEntries(ctx);
  const existing = collection.find(entry => entry.name === name);
  if (existing) {
    ctx.lintErrors.push({
      file: sourcePath,
      line,
      message: `inline ${strat.kind} "${name}" collides with existing ${strat.kind} at ${existing.path}`,
    });
    return false;
  }
  // Same metadata seam as an imported unit: ABOUT/APPLIES lifted, metadata lines
  // stripped from the body.
  const lifted = liftUnitMetadata(body);
  const def: Definition = {
    kind: strat.kind,
    name,
    about: lifted.about,
    body: lifted.body,
    path: sourcePath,
    tags: lifted.tags,
    scopes: lifted.scopes,
    ...(executor ? { executor } : {}),
  };
  // An inline `ROLE <role>:` carries its identity (EXPERTISE) in-body, and its
  // display name is the de-slugified block name. Lift it onto the entry — same
  // contract as the imported path — so the binding agent renders it in
  // `# Identity` and the Roles chapter keeps only rules.
  if (strat.kind === 'role') {
    const extended = extendInlineRole(body, sourcePath, ctx);
    const identity = liftRoleIdentity(extended.body);
    def.tags = [...new Set([...extended.tags, ...def.tags])];
    def.body = identity.rules;
    def.about = identity.about;
    def.role = deslugifyRole(name);
    def.expertise = identity.expertise ?? undefined;
  }
  collection.push(def);
  return true;
}

/**
 * Strip inline definitions from `rawBody`, push each one into the matching
 * ctx collection (so emitCollectedSections renders them as numbered
 * sections), and return the cleaned body — the agent's own narrative without
 * the now-relocated definition blocks.
 *
 * No-op when the body contains no inline block-opener for a STRATEGIES kind.
 */
/** A decorator line written above a block at the top of the body — `@WITH pdf`, never one that opens a block. */
function decoratesBelow(line: string): boolean {
  const token = lex(line)[0];
  return token?.kind === 'decorator' && !token.opens && token.indent === 0;
}

export function extractInlineDefinitions(
  rawBody: string,
  ctx: BundleContext,
  sourcePath: string,
): string {
  const headers = findInlineHeaders(rawBody);
  if (headers.length === 0) return rawBody;

  const lines = rawBody.split(/\r?\n/);
  const totalLines = lines.length;
  const linesToRemove = new Set<number>();

  for (const header of headers) {
    const endLine = findBlockEndLine(rawBody, header.startLine, totalLines);
    // Body lines: between header (exclusive) and end (exclusive).
    // lines[] is 0-indexed; startLine/endLine are 1-based.
    const bodyLines = lines.slice(header.startLine, endLine - 1);
    const body = dedent(bodyLines);
    collectInlineDefinition(header.strat, header.name, body, sourcePath, header.startLine, ctx, header.executor);
    for (let lineNumber = header.startLine; lineNumber < endLine; lineNumber++) linesToRemove.add(lineNumber);
    // The decorators right above it are its own (src/decorators.ts): they leave with it.
    for (let lineNumber = header.startLine - 1; lineNumber >= 1 && (lines[lineNumber - 1].trim() === '' || decoratesBelow(lines[lineNumber - 1])); lineNumber--) {
      if (lines[lineNumber - 1].trim() !== '') linesToRemove.add(lineNumber);
    }
  }

  const remaining: string[] = [];
  for (let lineNumber = 1; lineNumber <= totalLines; lineNumber++) {
    if (!linesToRemove.has(lineNumber)) remaining.push(lines[lineNumber - 1]);
  }
  return remaining.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
