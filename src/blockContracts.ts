// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { DIMENSION_LINES, type Keyword } from './lexer.js';
import { ACTION_VERBS } from './actionVerbs.js';
import { getFamilyBases } from './forceLevelConfig.js';
import { VERBATIM_REGIONS } from './shapeCompiler.js';

/**
 * The force-level families (MUST, ALWAYS/NEVER, SHOULD, MAY, …) a step admits,
 * by base: the list roles admit, less MEM — a step's BY agent may have no
 * memory in its harness — and WITH — it loads the skills it imports itself. Listing a base admits every declared declension
 * (`MUST!`, `!ALWAYS`, …) — the validator normalises a child to its family
 * base. `AS` is among them as the step's shape signature, so a branch, which
 * holds only conditional lines, leaves it out.
 */
const STEP_EXCLUDED: Partial<Record<Keyword, string>> = {
  MEM: "a step's BY agent may have no memory in its harness; MEM goes in an agent, a role or a procedure",
  WITH: "a step's BY agent uses the skills it imports; WITH goes in an agent, a role or a procedure",
};
const STEP_FAMILIES = familiesWithout(STEP_EXCLUDED);
const BRANCH_FAMILIES = STEP_FAMILIES.filter(base => base !== 'AS');

/**
 * The force-level families an agent's top level admits, by base: every one —
 * MEM included, an agent being where memory is written. `AS` is among them as the agent's header signature (its
 * role binding); a bare `AS` body line stays rejected by `lintAgentBlocks`.
 */
const AGENT_EXCLUDED: Partial<Record<Keyword, string>> = {};
const AGENT_FAMILIES = familiesWithout(AGENT_EXCLUDED);

/**
 * What a `VAR <name>:` block holds, at any depth beneath its head: a procedure
 * body's lines — DO, RUN, IF/ELSE, UNTIL, IN and the rule families. Its type
 * sits on its head, so no AS inside; a nested VAR is
 * the vocabulary check's own error. Not a BLOCK_CONTRACTS entry: the vocabulary
 * check applies it to every line under the head, in every file.
 */
const VAR_EXCLUDED: Partial<Record<Keyword, string>> = {
  AS: "a VAR block's type sits on its head — `VAR <name> AS <template>:`",
};

/** What a DIMENSION's rules leave out: they say how its value is produced, not what the agent remembers or loads. */
const DIMENSION_EXCLUDED: Partial<Record<Keyword, string>> = {
  MEM: "a dimension's rules say how its value is produced; MEM goes in an agent, a role or a procedure",
  WITH: "a dimension's rules say how its value is produced; WITH goes in an agent, a role or a procedure",
};

/** Every force-level family base, less those `excluded` names. */
function familiesWithout(excluded: Partial<Record<Keyword, string>>): Keyword[] {
  return (getFamilyBases() as Keyword[]).filter(base => !(base in excluded));
}

export const VAR_BLOCK: BlockContract = {
  allows: [...ACTION_VERBS, 'RUN', 'IN', 'IF', 'ELSE', 'UNTIL', ...familiesWithout(VAR_EXCLUDED)],
  excluded: VAR_EXCLUDED,
};

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
  /**
   * The regions it holds — nested blocks of the author's text (a store's
   * SLOTS: VERBATIM_REGIONS), never read as lines. Any other nested block opens on a line the
   * contract must allow, and its keyword lines are held to the contract too.
   */
  regions?: readonly string[];
}

/**
 * Declarative contracts: which keywords are allowed as children of which
 * block-opening keyword, and what cardinality constraints apply.
 *
 * The lint pass `validateBlockContracts` reads this map to enforce structural
 * rules generically. Adding a new block kind = adding an entry here, not
 * writing custom lint logic.
 */
/** The agent surface — see its comment in BLOCK_CONTRACTS.AGENT. */
const AGENT_CONTRACT: BlockContract = {
  allows: ['ABOUT', 'MANDATE', 'OWNS', 'LENS-OUT', 'LENS-IN', 'IMPORT', 'ON-INVOKE', 'WHEN', 'VAR', ...AGENT_FAMILIES],
  excluded: AGENT_EXCLUDED,
  requiresAll: ['AS', 'MANDATE'] as const,
  unique: ['AS', 'ABOUT', 'MANDATE', 'LENS-OUT', 'LENS-IN'] as const,
  identityKeywords: ['ROLE', 'EXPERTISE', 'APPLIES'] as const,
};

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
    // `MEM` is left out — `excluded` says why.
    // A force-level line (`NEVER …`, `MUST! …`) is a rule of the step, never its
    // action: it does not count toward `requiresAnyOf`.
    // `IF <condition>` (and its `ELSE`) puts some of the step's DO/RUN and rule
    // lines under a condition; the signature lines (BY, CONTEXT, AS) stay
    // unconditional.
    allows: [...ACTION_VERBS, 'RUN', 'CONTEXT', 'BY', ...STEP_FAMILIES],
    branches: { keywords: ['IF', 'ELSE'], allows: [...ACTION_VERBS, 'RUN', ...BRANCH_FAMILIES] },
    excluded: STEP_EXCLUDED,
    unique: ['CONTEXT', 'BY'] as const,
    requiresAnyOf: [...ACTION_VERBS, 'RUN'] as const,
  },
  PARALLEL: {
    allows: ['STEP'] as const,
    requiresAll: ['STEP'] as const,
  },
  // `PARALLEL EACH <item> IN <list> MAX <n>`: one step, run once per element.
  'PARALLEL EACH': {
    allows: ['STEP'] as const,
    requiresAll: ['STEP'] as const,
    unique: ['STEP'] as const,
  },
  // A store is a named working table an agent reads and writes. TYPE names the
  // backing plugin — required even while one type exists, so a second one is an
  // addition rather than a migration. LASTS is its lifetime, KEY the field that
  // identifies a record so re-ingesting the same thing updates instead of
  // duplicating. The record shape is declared in a SLOTS region, which is a
  // region and not a keyword — the same grammar TEMPLATE uses, so there is no
  // second type language to learn or maintain.
  STORE: {
    allows: ['ABOUT', 'APPLIES', 'TYPE', 'LASTS', 'KEY'] as const,
    requiresAll: ['TYPE'] as const,
    unique: ['ABOUT', 'TYPE', 'LASTS', 'KEY'] as const,
    regions: VERBATIM_REGIONS,
  },
  // A dimension is an answer about the code an agent works out once and the apx
  // keeps: ABOUT the question it answers, FOR the files it covers, EACH what to
  // translate in a file, AS the template its value is a list of. When it is
  // worth reading is the reader's to say — a WITH names it (src/withUse.ts).
  // Its rules are the force-level families — AS among them as the value's
  // shape, which takes no level (the compiler's check); MEM and WITH are an
  // agent's, not a rule of how a value is produced. Nothing else: no WHEN, no
  // action, no prose line, no nested block (IF, UNTIL…) — checked on the parsed
  // block, at any depth.
  DIMENSION: {
    allows: ['ABOUT', ...DIMENSION_LINES, ...familiesWithout(DIMENSION_EXCLUDED)],
    excluded: DIMENSION_EXCLUDED,
    requiresAll: ['ABOUT', ...DIMENSION_LINES, 'AS'] as const,
    unique: ['ABOUT', ...DIMENSION_LINES, 'AS'] as const,
  },
  // A team is its `EXPORT TEAM <name>:` block: ABOUT, the MEMBER lines that
  // name its agents (several add up), `LENS-IN <agent> <template>` overrides,
  // its routing (`WHEN …:` with `RUN <flow>` beneath — a lifecycle `ON-…:` is a
  // WHEN once desugared) and its FLOW blocks. The WHEN and FLOW blocks are its
  // regions: a flow takes the FLOW/STEP contracts line by line as it does in a
  // flow file, and a routing WHEN holds what a WHEN holds. Checked on the
  // parsed block (teamBlockErrors): the EXPORT form is not the token pass's.
  // Under `STRATEGY contracts` the team declares a LEAD, the DOMAINS dimension
  // and CONTRACT blocks instead of MEMBER, WHEN and FLOW — which of the two sets
  // holds is the lint's (teamBlockErrors); the contract admits both.
  TEAM: {
    allows: ['ABOUT', 'MEMBER', 'LENS-IN', 'WHEN', 'FLOW', 'STRATEGY', 'LEAD', 'DOMAINS', 'CONTRACT'] as const,
    requiresAll: ['ABOUT'] as const,
    unique: ['ABOUT', 'STRATEGY', 'LEAD', 'DOMAINS'] as const,
    regions: ['WHEN', 'FLOW', 'CONTRACT'] as const,
  },
  // A contract: ABOUT and DOMAIN, what the lead reads to pick it for a zone; AS,
  // the template of the spec it fills; BY, the agents that carry it out, or the
  // one team it is handed to. Checked on the parsed block (contractBlockErrors).
  CONTRACT: {
    allows: ['ABOUT', 'DOMAIN', 'AS', 'BY'] as const,
    requiresAll: ['ABOUT', 'AS', 'BY'] as const,
    unique: ['ABOUT', 'DOMAIN', 'AS', 'BY'] as const,
  },
  // First-class `EXPORT AGENT <name> AS <role>:` block. `AS` here is a
  // *signature* argument on the header line (the role binding) — NOT the same
  // `AS` as a STEP child (which declares a response shape). An AGENT block binds
  // a reusable ROLE by name and carries its OWN behavioural rules
  // (force-level lines of every family + WHEN workflows); EXPERTISE stays exclusive to the ROLE,
  // so it is deliberately absent from `allows` and the lint emits a HARD error
  // pointing back to the role. `LENS-IN` is admitted as the agent's own default
  // input shape — the team-side `LENS-IN <agent> <template>` override in the TEAM block
  // stays authoritative and is a separate grammar.
  // `requiresAll` + `unique` both name MANDATE so the contract declares the full
  // "exactly 1 MANDATE" rule in one place; `lintAgentBlocks` reads these instead
  // of hand-counting. (`AS` is the header signature, validated separately there.)
  // `VAR` declares a session variable of the agent, or assigns one the outcome
  // of the block beneath it (I7); where a VAR may stand is checkVocabulary's.
  // This is the single source of truth for the agent surface: `lintAgentBlocks`
  // in lint.ts reads `allows`, `requiresAll`, `unique`, and `identityKeywords`
  // directly — no second, hand-authored keyword list. `identityKeywords` names
  // the role-owned children (ROLE/EXPERTISE/APPLIES) that are rejected with the
  // "declare it in the role" hint; they are deliberately absent from `allows`, so
  // the two fields can never silently contradict.
  AGENT: AGENT_CONTRACT,
  // A SKILL is an AGENT the adapter writes as a skill — and, like a policy, it
  // holds where its APPLIES line or a WITH says (src/withUse.ts): APPLIES is its
  // own, never its role's.
  SKILL: {
    ...AGENT_CONTRACT,
    allows: [...AGENT_CONTRACT.allows, 'APPLIES'],
    identityKeywords: ['ROLE', 'EXPERTISE'] as const,
  },
};
