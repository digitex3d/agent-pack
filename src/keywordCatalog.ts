// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The language's words, each with the role it plays — for the tools that show
 * `.ap` sources to a developer (the IDE plugin colours by it). Built from the
 * registries the compiler reads, never a list of its own: the build writes it
 * to `dist/keywords.json`.
 *
 *   block    opens a named block — `AGENT`, `ROLE`, `TEMPLATE`, `EXPORT`
 *   rule     a force level of a rule family — `MUST`, `NEVER` (and `MUST!!`, `!ALWAYS`)
 *   meta     a descriptive field of an agent — `ABOUT`, `MANDATE`, `BUDGET`
 *   keyword  every other word — actions, control flow, `VAR`, `AS`, `INTO`
 *
 * A force-level word is listed by its base: a reader strips its `!`s and its
 * executor `*`s (`IF!`, `PROCEDURE*`, `!MUST`) before looking it up.
 */
import { KEYWORDS } from './lexer.js';
import { BLOCK_TYPES } from './blockTypes.js';
import { forceLevelBaseOf, toCanonicalKeyword, isRuleKeyword } from './forceLevelConfig.js';
import { AGENT_METADATA_KEYWORDS } from './primitives.js';
import { COMPUTE_SECTIONS } from './executor.js';

export type KeywordRole = 'block' | 'rule' | 'meta' | 'keyword';

/** Words the lexer spells inside its patterns rather than in a registry: `IMPORT … FROM`, `… INTO <name>`, `… MAX <n>`, `DISTILL`. */
const PATTERN_WORDS = ['FROM', 'INTO', 'MAX', 'DISTILL'];

/** Every word of the language, mapped to its role. */
export function keywordCatalog(): Record<string, KeywordRole> {
  const meta = new Set<string>(AGENT_METADATA_KEYWORDS);
  const roleOf = (word: string): KeywordRole => {
    if (word in BLOCK_TYPES) return 'block';
    const family = forceLevelBaseOf(toCanonicalKeyword(word));
    if (family) return isRuleKeyword(word) ? 'rule' : 'keyword';
    return meta.has(word) ? 'meta' : 'keyword';
  };
  const words = new Set([...KEYWORDS, ...Object.keys(BLOCK_TYPES), ...COMPUTE_SECTIONS, ...PATTERN_WORDS]);
  return Object.fromEntries([...words].sort().map(word => [word, roleOf(word)]));
}
