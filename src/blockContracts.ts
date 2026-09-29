// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { Keyword } from './lexer.js';

export interface BlockContract {
  /** Keywords admitted as direct children of this block. */
  allows: readonly Keyword[];
  /** Every keyword listed here must appear at least once in the block. */
  requiresAll?: readonly Keyword[];
  /** At least one of these must appear (logical OR). */
  requiresAnyOf?: readonly Keyword[];
  /** Keywords whose occurrence count must not exceed 1. */
  unique?: readonly Keyword[];
  /**
   * Forbidden child keywords that belong to the bound ROLE, not this block.
   * Always disjoint from `allows` (a keyword is either admitted or an identity
   * keyword, never both), so this is the single declaration of which rejections
   * carry the "declare it in the role" hint instead of the generic message —
   * the lint reads it instead of re-listing the same keywords.
   */
  identityKeywords?: readonly Keyword[];
}

/**
 * Declarative contracts: which keywords are allowed as children of which
 * block-opening keyword, and what cardinality constraints apply.
 *
 * The lint pass `validateBlockContracts` reads this map to enforce structural
 * rules generically. Adding a new block kind = adding an entry here, not
 * writing custom lint logic.
 */
export const BLOCK_CONTRACTS: Record<string, BlockContract> = {
  FLOW: {
    allows: ['STEP', 'PARALLEL', 'RUN'] as const,
    requiresAll: ['STEP'] as const,
  },
  STEP: {
    // Listing the force-family base `AS` admits every declension (AS, AS!,
    // AS!!, !AS) — the validator normalises children to their family base.
    // `BY` binds the step to its executor (agent or team); at most one.
    // `LOG` appends an entry to the shared run log (stripped by the bundle's
    // logging threshold at compile time).
    allows: ['DO', 'RUN', 'CONTEXT', 'AS', 'BY'] as const,
    unique: ['CONTEXT', 'BY'] as const,
    requiresAnyOf: ['DO', 'RUN'] as const,
  },
  PARALLEL: {
    allows: ['STEP'] as const,
    requiresAll: ['STEP'] as const,
  },
  // A store is a named working table an agent reads and writes. TYPE names the
  // backing plugin — required even while one type exists, so a second one is an
  // addition rather than a migration. LASTS is its lifetime, KEY the field that
  // identifies a record so re-ingesting the same thing updates instead of
  // duplicating. The record shape is declared in a SLOTS region, which is a
  // region and not a keyword — the same grammar TEMPLATE uses, so there is no
  // second type language to learn or maintain.
  STORE: {
    allows: ['ABOUT', 'TAGS', 'TYPE', 'LASTS', 'KEY'] as const,
    requiresAll: ['TYPE'] as const,
    unique: ['ABOUT', 'TYPE', 'LASTS', 'KEY'] as const,
  },
  // First-class `EXPORT AGENT <name> AS <role>:` block. `AS` here is a
  // *signature* argument on the header line (the role binding) — NOT the same
  // `AS` as a STEP child (which declares a response shape). An AGENT block binds
  // a reusable ROLE by name and carries its OWN behavioural rules
  // (ALWAYS/NEVER/MUST + WHEN workflows); EXPERTISE stays exclusive to the ROLE,
  // so it is deliberately absent from `allows` and the lint emits a HARD error
  // pointing back to the role. `LENS-IN` is admitted as the agent's own default
  // input shape — the team-side `LENS-IN <agent> <template>` override in flows.ap
  // stays authoritative and is a separate grammar.
  // `requiresAll` + `unique` both name MANDATE so the contract declares the full
  // "exactly 1 MANDATE" rule in one place; `lintAgentBlocks` reads these instead
  // of hand-counting. (`AS` is the header signature, validated separately there.)
  // This is the single source of truth for the agent surface: `lintAgentBlocks`
  // in lint.ts reads `allows`, `requiresAll`, `unique`, and `identityKeywords`
  // directly — no second, hand-authored keyword list. `identityKeywords` names
  // the role-owned children (ROLE/EXPERTISE/TAGS) that are rejected with the
  // "declare it in the role" hint; they are deliberately absent from `allows`, so
  // the two fields can never silently contradict.
  AGENT: {
    allows: ['AS', 'ABOUT', 'MANDATE', 'OWNS', 'LENS-OUT', 'LENS-IN', 'IMPORT', 'ALWAYS', 'NEVER', 'MUST', 'ON-INVOKE', 'WHEN'] as const,
    requiresAll: ['AS', 'MANDATE'] as const,
    unique: ['AS', 'ABOUT', 'MANDATE', 'LENS-OUT', 'LENS-IN'] as const,
    identityKeywords: ['ROLE', 'EXPERTISE', 'TAGS'] as const,
  },
};
