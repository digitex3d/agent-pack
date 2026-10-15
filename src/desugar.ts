// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Token-level alias resolution (desugar pass).
 *
 * Maps source-level syntactic aliases to their canonical keyword equivalents
 * so that all downstream consumers (parser, linter, bundler) see only the
 * canonical form. The alias table has two layers:
 *
 *   - STATIC_ALIASES: lifecycle hooks from `lifecycles.json` (e.g. ON-INVOKE →
 *     WHEN with rest override "this agent is called", ON-AGENT-PROMPTED → WHEN
 *     "the agent receives a new user prompt"). The source block colon is
 *     re-appended so `ON-X:` becomes a `WHEN <phase>:` block opener.
 *   - FORCE_LEVEL_ALIASES: derived at module load from `force-levels.json`
 *     (e.g. NON-NEGOTIABLE → MUST!!, NEVER → !ALWAYS, MUST-NOT → !MUST).
 *
 * Design notes:
 * - Pure function: does not mutate its input, always returns a new array.
 * - Non-alias tokens pass through by reference (no allocation).
 * - `raw`, `line`, `col`, and `indent` are preserved from the source token so
 *   error messages point to the original source line, not the expansion.
 * - When a rule defines `rest`, it overrides the source rest. Otherwise the
 *   source rest is preserved.
 *
 * Circular-dependency note:
 * This module uses `import type` from `lexer.ts` exclusively. TypeScript erases
 * type-only imports, so the compiled `desugar.js` contains no runtime import
 * from `lexer.js`. The runtime graph is one-directional: lexer.js → desugar.js.
 */

import type { Token, Keyword } from './lexer.js';
import { getAliasNames, aliasToCanonical } from './forceLevelConfig.js';
import { getLifecycleAliases, lifecycleToWhen } from './lifecycleConfig.js';

export interface AliasRule {
  from: string;
  to: { keyword: string; rest?: string };
}

/**
 * Static aliases: lifecycle hooks (`ON-INVOKE`, `ON-AGENT-PROMPTED`, …) built
 * from `lifecycles.json`. Each maps to a canonical module-level WHEN whose rest
 * is the phase text, so it behaves exactly like a WHEN.
 *
 * The trailing block colon is NOT part of the static rest: the lexer emits a
 * lifecycle keyword with `rest === ':'` when the source wrote `ON-X:`, and
 * `desugar` re-appends that colon so `ON-X:` expands to `WHEN <phase>:`
 * (a block opener) while bare `ON-X` expands to `WHEN <phase>` (a prose line).
 */
export const STATIC_ALIASES: AliasRule[] = getLifecycleAliases().map(name => ({
  from: name,
  to: { keyword: 'WHEN', rest: lifecycleToWhen(name) as string },
}));

/** Force-level aliases built from `force-levels.json` at module load. */
export const FORCE_LEVEL_ALIASES: AliasRule[] = getAliasNames().map(name => ({
  from: name,
  to: { keyword: aliasToCanonical(name) },   // rest NOT overridden — preserved from source
}));

const ALL_ALIASES = new Map<string, AliasRule['to']>(
  [...STATIC_ALIASES, ...FORCE_LEVEL_ALIASES].map(r => [r.from, r.to]),
);

/**
 * Resolve all alias keywords in `tokens` to their canonical equivalents.
 *
 * Only `keyword` tokens are inspected; all other token kinds pass through
 * unchanged. For matched aliases, a new token object is returned that carries
 * the canonical `keyword` (and the rule's `rest` when provided) while
 * preserving `kind`, `raw`, `line`, `col`, and `indent` from the source token.
 */
export function desugar(tokens: Token[]): Token[] {
  return checkedTriggers(tokens).map(t => {
    if (t.kind !== 'keyword') return t;
    const target = ALL_ALIASES.get(t.keyword as string);
    if (!target) return t;
    // When the alias overrides the rest (lifecycle hooks), re-append the block
    // colon the lexer carried in the source rest, so `ON-X:` → `WHEN <phase>:`
    // (block opener) and bare `ON-X` → `WHEN <phase>` (prose line).
    const rest = target.rest === undefined
      ? t.rest                                                 // preserve source rest
      : target.rest + (t.rest.trimEnd().endsWith(':') ? ':' : '');
    return {
      ...t,
      keyword: target.keyword as Keyword,
      rest,
    };
  });
}

/**
 * `WHEN! <condition>:` is sugar for a prose trigger with a checked branch beneath:
 *
 *   WHEN! {{request}} submits one idea:      WHEN {{request}} submits one idea:
 *       RUN shape-idea                 →         IF! {{request}} submits one idea:
 *                                                    RUN shape-idea
 *
 * The agent still picks the moment, as for every WHEN; the judge decides the
 * condition, as for every IF!, and everything downstream sees only that pair.
 * The IF! head takes the body's indent and the body moves one level deeper —
 * the level being the body's own, so the rewrite is byte-identical to the
 * hand-written form. Every rewritten token's `raw` is its rewritten line: the
 * pipeline rebuilds a block's body from `raw` and lexes it again, so the pass
 * must be idempotent — a re-lex of its output finds nothing left to rewrite.
 * Both heads keep the source line. `WHEN!!` (level 2) and `!WHEN` (level -1)
 * are left as they are: the vocabulary check rejects them — a sealed
 * condition could not sit in a prose head.
 */
function checkedTriggers(tokens: Token[]): Token[] {
  const isSugar = (t: Token): t is Token & { kind: 'keyword' } => t.kind === 'keyword' && t.keyword === 'WHEN' && t.level === 1;
  if (!tokens.some(isSugar)) return tokens;
  const out: Token[] = [];
  const shifts: { above: number; by: number }[] = [];   // open rewrites: a line deeper than `above` moves by `by`
  const moved = <T extends Token>(t: T, by: number): T =>
    by && t.kind !== 'blank' && 'raw' in t ? { ...t, indent: t.indent + by, raw: ' '.repeat(by) + t.raw } : t;
  tokens.forEach((t, i) => {
    if (t.kind !== 'blank') while (shifts.length && t.indent <= shifts[shifts.length - 1].above) shifts.pop();
    const by = shifts.reduce((n, s) => n + s.by, 0);
    if (!isSugar(t)) { out.push(moved(t, by)); return; }
    const body = tokens.slice(i + 1).find(n => n.kind !== 'blank');
    const step = body && body.indent > t.indent ? body.indent - t.indent : 4;
    const { level: _level, ...plain } = t;
    const line = (keyword: string, indent: number) => `${' '.repeat(indent)}${keyword} ${t.rest}`;
    out.push({ ...plain, indent: t.indent + by, raw: line('WHEN', t.indent + by) });
    out.push({ ...plain, keyword: 'IF' as Keyword, level: 1, indent: t.indent + by + step, raw: line('IF!', t.indent + by + step) });
    shifts.push({ above: t.indent, by: step });
  });
  return out;
}
