// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { DIMENSION_LINES, DOMAIN_LINES, type Keyword } from './lexer.js';
import { ACTION_VERBS } from './actionVerbs.js';
import { FORK_VERB, WAIT_VERB, MARK_VERB } from './delegation.js';
import { getFamilyBases } from './forceLevelConfig.js';
import { VERBATIM_REGIONS } from './shapeCompiler.js';
import { PLUGIN_KEY, OPERATION_KEY } from './blockTypes.js';

/**
 * The force-level families (MUST, ALWAYS/NEVER, SHOULD, MAY, …) a step admits,
 * by base: the list roles admit, less MEM — whoever runs the flow may have no
 * memory in its harness — and AS, a step handing nothing over itself. Listing
 * a base admits every declared declension (`MUST!`, `!ALWAYS`, …) — the
 * validator normalises a child to its family base.
 */
const STEP_EXCLUDED: Partial<Record<Keyword, string>> = {
  MEM: "whoever runs a flow may have no memory in its harness; MEM goes in an agent, a role or a procedure",
  // A step is a label: who does the work, with what context and in what shape, is its DELEGATE's to say (src/delegation.ts).
  BY: 'a step names no one — whoever runs the flow carries it out: hand its work over with `DELEGATE <task> BY <agent> [AS <template>]`',
  AS: 'a step hands nothing over itself — the shape of what is handed over is its DELEGATE\'s: `DELEGATE <task> BY <agent> AS <template>`',
};
const STEP_FAMILIES = familiesWithout(STEP_EXCLUDED);
/** The actions only a flow STEP takes, beside the action verbs: a fork, the WAIT that takes back what a `~` started, the MARK that binds zones to contracts. */
const STEP_ACTIONS = [FORK_VERB, WAIT_VERB, MARK_VERB] as const;
const BRANCH_FAMILIES = STEP_FAMILIES;

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
  allows: ['ABOUT', 'MANDATE', 'BUDGET', 'LENS-OUT', 'LENS-IN', 'IMPORT', 'ON-INVOKE', 'WHEN', 'VAR', ...AGENT_FAMILIES],
  excluded: AGENT_EXCLUDED,
  requiresAll: ['AS', 'MANDATE'] as const,
  unique: ['AS', 'ABOUT', 'MANDATE', 'BUDGET', 'LENS-OUT', 'LENS-IN'] as const,
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
    // A label over the lines whoever runs the flow carries out (src/delegation.ts):
    // DO it, DELEGATE it, FORK it, WAIT for what a `~` started, RUN a procedure.
    // `BY`, `AS` and `MEM` are left out — `excluded` says why.
    // A force-level line (`NEVER …`, `MUST! …`) is a rule of the step, never its
    // action: it does not count toward `requiresAnyOf`.
    // `IF <condition>` (and its `ELSE`) puts some of the step's lines under a condition.
    allows: [...ACTION_VERBS, ...STEP_ACTIONS, 'RUN', ...STEP_FAMILIES],
    branches: { keywords: ['IF', 'ELSE'], allows: [...ACTION_VERBS, ...STEP_ACTIONS, 'RUN', ...BRANCH_FAMILIES] },
    excluded: STEP_EXCLUDED,
    requiresAnyOf: [...ACTION_VERBS, ...STEP_ACTIONS, 'RUN'] as const,
  },
  // `DELEGATE <task> BY <agent>:` — the lines the one it goes to is told: what it does, its rules, its conditions.
  DELEGATE: {
    allows: ['DO', 'COMPUTE', 'RUN', ...BRANCH_FAMILIES] as const,
    branches: { keywords: ['IF', 'ELSE'], allows: ['DO', 'COMPUTE', 'RUN', ...BRANCH_FAMILIES] },
    excluded: { MEM: STEP_EXCLUDED.MEM! },
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
  // A domain is a region of the code: ABOUT what it is, WRITES the files work
  // within it may write, READS the ones it may only read — lines that add up
  // (src/domains.ts), APPLIES its tags — tags only, a domain holds nowhere by
  // itself. `@WITHIN <domain>` (or `@WITHIN #tag`) puts work within it, and a
  // CONTRACT's DOMAIN line names one. Nothing else: a domain holds no rule, it only says where.
  DOMAIN: {
    allows: ['ABOUT', 'APPLIES', ...DOMAIN_LINES] as const,
    requiresAll: ['ABOUT'] as const,
    requiresAnyOf: DOMAIN_LINES,
    unique: ['ABOUT', 'APPLIES'] as const,
    excluded: { FOR: 'a domain says its files with `WRITES IN <glob>, …` (and `READS IN <glob>, …` for the ones it only reads)' },
  },
  // A plugin's manifest: ABOUT what its block is, AS the template its lines
  // are, and an OPERATION block per apx command — ABOUT what it does, AS the
  // template of its input when it takes one. Checked on the parsed manifest
  // (pluginManifestErrors) before the plugin is installed.
  [PLUGIN_KEY]: {
    allows: ['ABOUT', 'AS', OPERATION_KEY] as const,
    requiresAll: ['ABOUT', 'AS'] as const,
    unique: ['ABOUT', 'AS'] as const,
    // Each OPERATION is held to its own contract, not to the PLUGIN's.
    regions: [OPERATION_KEY] as const,
  },
  [OPERATION_KEY]: {
    allows: ['ABOUT', 'AS'] as const,
    requiresAll: ['ABOUT'] as const,
    unique: ['ABOUT', 'AS'] as const,
  },
  // A team is its `EXPORT TEAM <name>:` block: ABOUT, the MEMBER lines that
  // name its agents (several add up), `LENS-IN <agent> <template>` overrides,
  // its routing (`WHEN …:` with `RUN <flow>` beneath — a lifecycle `ON-…:` is a
  // WHEN once desugared) and its FLOW blocks. The WHEN and FLOW blocks are its
  // regions: a flow takes the FLOW/STEP contracts line by line as it does in a
  // flow file, and a routing WHEN holds what a WHEN holds. Checked on the
  // parsed block (teamBlockErrors): the EXPORT form is not the token pass's.
  TEAM: {
    allows: ['ABOUT', 'MEMBER', 'LENS-IN', 'WHEN', 'FLOW'] as const,
    requiresAll: ['ABOUT'] as const,
    unique: ['ABOUT'] as const,
    regions: ['WHEN', 'FLOW'] as const,
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
