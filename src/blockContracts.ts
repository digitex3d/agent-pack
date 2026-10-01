// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { Keyword } from './lexer.js';
import { getFamilyBases } from './forceLevelConfig.js';

/**
 * The force-level families (MUST, ALWAYS/NEVER, SHOULD, MAY, …) a step admits,
 * by base: the list roles and playbooks admit, less DISTILL — a procedure's
 * mark, never a step's line — and less MEM — a step's BY agent may have no
 * memory in its harness. Listing a base admits every declared declension
 * (`MUST!`, `!ALWAYS`, …) — the validator normalises a child to its family
 * base. `AS` is among them as the step's shape signature, so a branch, which
 * holds only conditional lines, leaves it out.
 */
const STEP_EXCLUDED: Partial<Record<Keyword, string>> = {
  DISTILL: 'DISTILL marks a PROCEDURE, never a step',
  MEM: "a step's BY agent may have no memory in its harness; MEM goes in an agent, a role or a procedure",
};
const STEP_FAMILIES = familiesWithout(STEP_EXCLUDED);
const BRANCH_FAMILIES = STEP_FAMILIES.filter(base => base !== 'AS');

/**
 * The force-level families an agent's top level admits, by base: every one —
 * MEM included, an agent being where memory is written — less DISTILL, a
 * procedure's mark. `AS` is among them as the agent's header signature (its
 * role binding); a bare `AS` body line stays rejected by `lintAgentBlocks`.
 */
const AGENT_EXCLUDED: Partial<Record<Keyword, string>> = {
  DISTILL: 'DISTILL marks a PROCEDURE, never an agent',
};
const AGENT_FAMILIES = familiesWithout(AGENT_EXCLUDED);

/** Every force-level family base, less those `excluded` names. */
function familiesWithout(excluded: Partial<Record<Keyword, string>>): Keyword[] {
  return (getFamilyBases() as Keyword[]).filter(base => !(base in excluded));
}

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
  /**
   * Children that open a conditional branch of this block (IF and its ELSE, or
   * an UNTIL loop). A branch is admitted like any allowed child, may hold only
   * `allows` — plus further branches when `nests` is set — and is transparent:
   * what it holds, at any depth, counts as this block's own children, so a
   * block whose required lines all sit under an IF or an UNTIL still has them.
   */
  branches?: { keywords: readonly Keyword[]; allows: readonly Keyword[]; nests?: boolean };
  /**
   * Why a keyword (by family base) is left out of `allows` — appended to its
   * "not allowed" error, in this block and in its branches.
   */
  excluded?: Partial<Record<Keyword, string>>;
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
    // `IF <condition>:` (and its `ELSE`) and `UNTIL <condition>:` put some of
    // the flow's steps under a condition or in a loop; they hold what the flow
    // holds — STEP, PARALLEL, RUN — and nest further IF/ELSE/UNTIL. The
    // condition is prose, judged by whoever runs the flow.
    allows: ['STEP', 'PARALLEL', 'RUN'] as const,
    branches: { keywords: ['IF', 'ELSE', 'UNTIL'], allows: ['STEP', 'PARALLEL', 'RUN'], nests: true },
    requiresAll: ['STEP'] as const,
  },
  STEP: {
    // The force families come in by base, `AS` among them: every declension
    // (AS, AS!, AS!!, !AS) is admitted — `AS` declares the step's shape.
    // `BY` binds the step to its executor (agent or team); at most one.
    // `MEM` and `DISTILL` are left out — `excluded` says why.
    // A force-level line (`NEVER …`, `MUST! …`) is a rule of the step, never its
    // action: it does not count toward `requiresAnyOf`.
    // `IF <condition>` (and its `ELSE`) puts some of the step's DO/RUN and rule
    // lines under a condition; the signature lines (BY, CONTEXT, AS) stay
    // unconditional.
    allows: ['DO', 'RUN', 'CONTEXT', 'BY', ...STEP_FAMILIES],
    branches: { keywords: ['IF', 'ELSE'], allows: ['DO', 'RUN', ...BRANCH_FAMILIES] },
    excluded: STEP_EXCLUDED,
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
  // (force-level lines of every family but DISTILL — `excluded` says why — + WHEN workflows); EXPERTISE stays exclusive to the ROLE,
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
    allows: ['ABOUT', 'MANDATE', 'OWNS', 'LENS-OUT', 'LENS-IN', 'IMPORT', 'ON-INVOKE', 'WHEN', ...AGENT_FAMILIES],
    excluded: AGENT_EXCLUDED,
    requiresAll: ['AS', 'MANDATE'] as const,
    unique: ['AS', 'ABOUT', 'MANDATE', 'LENS-OUT', 'LENS-IN'] as const,
    identityKeywords: ['ROLE', 'EXPERTISE', 'TAGS'] as const,
  },
};
