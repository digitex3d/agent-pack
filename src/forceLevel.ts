// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { renderKeywordBlock } from './services/text.js';
import { FORCE_LEVEL_PRIMITIVES, type BulletGroupPrimitive } from './primitives.js';
import { lex, type Token } from './lexer.js';
import { desugar } from './desugar.js';
import { getIntroByKeyword } from './forceLevelConfig.js';
import type { BundleContext } from './dispatch/types.js';

/**
 * Walk the token stream (after alias desugaring) and collapse runs of
 * consecutive same-keyword, same-indent lines into a single labelled block.
 *
 * Force-level keywords (MUST, MUST!, !MUST, ALWAYS, !ALWAYS, etc.) are
 * recognised via getIntroByKeyword() — no hardcoded list here.
 *
 * Non-force-level bullet groups (WHEN/RUN/DO/BY) share the same
 * rendering loop but may use inline format variants.
 *
 * Non-matching lines (headings, comments, blanks, unknown text) are emitted
 * verbatim from their `raw` form.
 *
 * `ctx` is optional; when provided it is forwarded to RunPrimitive for
 * polymorphic kind-aware rendering of `RUN <name>` tokens.
 */
export function applyForceLevels(text: string, ctx?: BundleContext): string {
  // Non-force-level bullet groups that share this rendering pass.
  const nonForceLevelByKeyword = new Map<string, BulletGroupPrimitive>(
    FORCE_LEVEL_PRIMITIVES.map(primitive => [primitive.keyword, primitive]),
  );

  const tokens = desugar(lex(text));
  const out: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind !== 'keyword') {
      out.push(rawOf(token));
      index++;
      continue;
    }

    const keyword = token.keyword as string;
    const forceLevelIntro = getIntroByKeyword(keyword);
    const nonForceLevel = forceLevelIntro === null
      ? nonForceLevelByKeyword.get(keyword)
      : undefined;

    if (forceLevelIntro === null && nonForceLevel === undefined) {
      out.push(rawOf(token));
      index++;
      continue;
    }

    const indent = token.indent;
    const actions: string[] = [token.rest];
    let nextIndex = index + 1;
    while (nextIndex < tokens.length) {
      const tt = tokens[nextIndex];
      if (tt.kind !== 'keyword' || (tt.keyword as string) !== keyword || tt.indent !== indent) break;
      actions.push(tt.rest);
      nextIndex++;
    }

    let block: string;
    if (forceLevelIntro !== null) {
      block = renderKeywordBlock(forceLevelIntro, actions);
    } else {
      const primitive = nonForceLevel!;
      // Pass ctx so RunPrimitive can resolve kind from the registry.
      block = primitive.renderNeutral(actions, ctx).trimEnd();
    }

    const indentStr = ' '.repeat(indent);
    for (const line of block.split('\n')) out.push(indent ? indentStr + line : line);
    index = nextIndex;
  }
  return out.join('\n');
}

function rawOf(token: Token): string {
  if (token.kind === 'blank') return '';
  return 'raw' in token ? token.raw : '';
}
