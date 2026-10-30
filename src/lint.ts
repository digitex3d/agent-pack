// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { DECORATOR_MARK, decoratorOf, decoratorItemError, splitDecoratorRest, unknownDecoratorMessage } from './decorators.js';
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { lex, Token, Keyword, KEYWORDS, GLOBS_LINE, DOMAIN_LINES, isTriggerKind, opensBlock, type DimensionLine, type DomainLine } from './lexer.js';
import { parseDomainLine, domainLineIssue } from './domains.js';
import { ACTION_VERBS } from './actionVerbs.js';
import { desugar } from './desugar.js';
import { parseApplies, PERIMETER_FORMS, PERIMETER_KINDS } from './services/tags.js';
import { getFamilyBases, getIntroByKeyword, forceLevelBaseOf, splitBangs, forceLevelFamilies, toCanonicalKeyword, parseForceLevel, NON_RULE_FAMILIES } from './forceLevelConfig.js';
import { enumPrimitiveFor } from './primitives.js';
import { BLOCK_CONTRACTS, BlockContract, VAR_BLOCK } from './blockContracts.js';
import { TEAM_KEY } from './services/teamMetadata.js';
import { parseBlocks, agentNestedBlocks, exportedVar, readExportedVar, isExportedVar, type Block, type Node, type Line } from './parseBlocks.js';
import { isExportFile } from './services/text.js';
import { agentAsText } from './definitionArgs.js';
import { isDelegationVerb, delegationLineErrors, waitLineErrors, markLineErrors, concurrencyErrors, parseDelegation, WAIT_VERB, MARK_VERB } from './delegation.js';
import { kindFromDir, unitNameFromPath } from './ingest.js';
import { plugins, pluginOf, pluginOfKey, recordOfLines, lineIssues } from './plugins.js';
import { BLOCK_TYPES, blockTypeOf, EXPORT_MODIFIER, AGENT_KEYS, PLUGIN_KEY, OPERATION_KEY } from './blockTypes.js';
import { COMPUTE_SECTIONS, executorMark, returnShape, splitExecutorMark } from './executor.js';
import { parseTypeSpec } from './shapeSchema.js';
import { SLOT_LINE_RE, VERBATIM_REGIONS } from './shapeCompiler.js';
import { STORE_LIFETIMES } from './storeTypes/types.js';
import { stripTrailingColon, buildTree, type Node as TreeNode } from './bundlers/renderTree.js';
import { condCheckOf, checkedKeyword, sugaredHead, splitMax, maxIssue, type CheckKind, type CheckSite } from './check.js';
import { parseVarLine, parseEachHead, isVarKeyword, splitBy, splitInto, takesInto, readsOf } from './vars.js';
import { splitList, spacedListError, WORD_LIST_LINES } from './lists.js';

export interface LintError {
  file: string;
  line: number;
  message: string;
  severity?: 'error' | 'warning';
  /** 1-based column of the first character, and just past the last — when known. */
  col?: number;
  endCol?: number;
  /** What reported it: the id of the rule or check, when it has one. */
  code?: string;
  /** Which phase reported it — the lint (default) or the judge. */
  source?: 'lint' | 'judge';
  /** Machine data of the diagnostic (a judge verdict: p, key). */
  data?: Record<string, unknown>;
}

export interface LintOptions {
  maxLineLength?: number;
}

export const DEFAULT_MAX_LINE_LENGTH = 180;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Validate an APPLIES payload through the one reader of the line
 * (`parseApplies`, src/services/tags.ts): every token a `#tag` — `#` + an
 * alphanumeric start + alphanumerics and hyphens — or a perimeter.
 */
function validateAppliesPayload(rest: string): string | null {
  if (!rest.trim()) return `APPLIES payload is empty — provide at least one #hashtag, or ${PERIMETER_FORMS}`;
  const spaced = spacedListError('APPLIES', rest);
  if (spaced) return spaced;
  const [tok] = parseApplies([rest]).invalid;
  return tok === undefined ? null
    : `APPLIES token "${tok}" is invalid — expected a classic flat hashtag like #kebab-slug (no slashes, no missing #), or ${PERIMETER_FORMS}`;
}

function validateTriggerContent(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return 'trigger has no condition';
  if (/\s+OR\s+/.test(trimmed)) {
    return 'OR not supported in triggers — write separate rules instead';
  }
  if (/\bAND\b/.test(trimmed)) {
    if (/^AND\b/.test(trimmed) || /\bAND$/.test(trimmed)) {
      return 'AND must join non-empty conditions on both sides';
    }
    const parts = trimmed.split(/\s+AND\s+/);
    if (parts.length < 2 || parts.some(p => !p.trim())) {
      return 'AND must join non-empty conditions on both sides';
    }
  }
  return null;
}

function quoteRaw(t: Token): string {
  if (t.kind === 'blank') return '';
  return ('raw' in t ? t.raw : '').trim().slice(0, 60);
}

function lengthErrors(file: string, tokens: Token[], maxLen: number): LintError[] {
  const errors: LintError[] = [];
  for (const t of tokens) {
    const raw = 'raw' in t ? t.raw : '';
    if (raw.length > maxLen) {
      errors.push({ file, line: t.line, message: `line exceeds max length of ${maxLen} (${raw.length} chars)` });
    }
  }
  return errors;
}

function nextSubstantive(tokens: Token[], from: number): number {
  for (let j = from; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === 'blank' || t.kind === 'comment' || t.kind === 'rawLine') continue;
    return j;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Block-scoped metadata model (EXPORT) — TRANSITIONAL
//
// The exportable unit is a top-level `EXPORT <KIND> <name>:` block: its metadata
// (ABOUT/APPLIES) lives in block scope, not at file-top. A file that uses
// EXPORT blocks takes the block-scoped lint path; a legacy file (file-top
// metadata, no EXPORT block) keeps the current file-top path unchanged.
//
// The legacy path and the `usesExport` branch in runLint are the only seam to
// remove once the codemod migration has wrapped every module in an EXPORT block.
// ---------------------------------------------------------------------------

/** Metadata keywords that, in an EXPORT file, must live inside a block, not at file-top. */
const METADATA_KEYWORDS = new Set<Keyword>(['ABOUT', 'APPLIES', 'SCOPE']);

interface ExportModel {
  /** True when any top-level block carries the EXPORT modifier. */
  usesExport: boolean;
  /**
   * Line numbers of the direct line-children of top-level blocks — the "unit
   * body" a `topLevelOnly` spec should walk once statements live one level
   * deeper inside an EXPORT block (indent-width-agnostic, unlike a raw indent
   * threshold). Empty unless `usesExport`.
   */
  unitBodyLines: Set<number>;
  /** Metadata structural errors (missing ABOUT, file-top strays). Empty unless `usesExport`. */
  errors: LintError[];
}

/**
 * Derive the EXPORT-mode model from a single parse. Validates two block-scoped
 * rules — every exported block needs an ABOUT child (APPLIES optional, WHEN
 * children valid); file-top metadata outside a block is an error — and collects
 * the unit-body line set used to scope the body walk. Metadata inside a private
 * (non-exported) block is permitted and inert.
 */
function buildExportModel(file: string, body: string, tokens: Token[]): ExportModel {
  const blocks = parseBlocks(body).blocks;
  const usesExport = isExportFile(blocks);
  if (!usesExport) return { usesExport: false, unitBodyLines: new Set(), errors: [] };

  const errors: LintError[] = [];
  const unitBodyLines = new Set<number>();

  for (const block of blocks) {
    let hasAbout = false;
    for (const child of block.children) {
      if (child.type === 'line') {
        unitBodyLines.add(child.line);
        if (child.keyword === 'ABOUT') hasAbout = true;
      }
    }
    // An exported VAR is one line with no body: its declaration says what it is.
    if (block.exported && !hasAbout && !isExportedVar(block)) {
      errors.push({ file, line: block.startLine, message: 'exported block requires ABOUT' });
    }
  }

  // A metadata keyword at indent 0 cannot be a block child (children indent
  // further than their block opener), so it is necessarily a file-top stray.
  for (const t of tokens) {
    if (t.kind === 'keyword' && t.indent === 0 && METADATA_KEYWORDS.has(t.keyword)) {
      errors.push({
        file, line: t.line,
        message: `${t.keyword} at file-top is not allowed in a file using EXPORT blocks — move it inside the block`,
      });
    }
  }

  return { usesExport, unitBodyLines, errors };
}

// ---------------------------------------------------------------------------
// Generic lint engine
// ---------------------------------------------------------------------------

type State = Record<string, number | string | boolean | null>;

type KeywordToken = Extract<Token, { kind: 'keyword' }>;
type ProcRefToken = Extract<Token, { kind: 'procRef' }>;

interface LintCtx {
  file: string;
  spec: LintSpec;
  tokens: Token[];
  index: number;
  errors: LintError[];
  state: State;
  /** Emit the spec-defined "unexpected line" error for this token. */
  unexpected(t: Token): void;
}

type KeywordHandler = (t: KeywordToken, ctx: LintCtx) => void;
type ProcRefHandler = (t: ProcRefToken, ctx: LintCtx) => void;

interface LintSpec {
  /** Whether to skip indented (`indent >= 2`) tokens — used by file kinds whose
   *  inner statements are validated only via their parent IF/ELSE check. */
  topLevelOnly: boolean;
  /** Accept top-level `blockOpener` tokens (e.g. inline `ROLE <role>:`).
   *  Their bodies are validated by the inline-block path, not here. */
  acceptBlockOpeners?: boolean;
  /** Per-keyword logic. A keyword absent from the map → "unexpected". */
  keywords: Map<Keyword, KeywordHandler>;
  /** Optional handler for `@<name>` references; absent → "unexpected". */
  procRef?: ProcRefHandler;
  /** Build the "unexpected line" message for a token. */
  unexpected(t: Token): string;
  /** Optional file-level pre-check. Runs once before the walk. */
  preCheck?(file: string, errors: LintError[]): void;
  /** Optional finalizer: emits invariant errors based on accumulated state. */
  finalize?(state: State, errors: LintError[], file: string): void;
}

/**
 * Resolve the handler for a keyword. Exact match wins; otherwise, a force-level
 * declension falls back to its family base — so a spec that lists the base
 * (`AS`, `MUST`, `ALWAYS`) admits every declared declension (`AS!`, `!AS`,
 * `!ALWAYS`, …) without enumerating them. The `getIntroByKeyword` gate ensures
 * only *declared* levels match: an undeclared amplification (e.g. `ALWAYS!`,
 * which has no level 1) stays "unexpected".
 */
function handlerFor(spec: LintSpec, keyword: Keyword): KeywordHandler | undefined {
  const exact = spec.keywords.get(keyword);
  if (exact) return exact;
  if (getIntroByKeyword(keyword) === null) return undefined;
  const base = forceLevelBaseOf(keyword);
  return base !== null ? spec.keywords.get(base as Keyword) : undefined;
}

function runLint(spec: LintSpec, file: string, body: string, options: LintOptions): LintError[] {
  const maxLen = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const tokens = desugar(lex(body));
  const errors: LintError[] = lengthErrors(file, tokens, maxLen);

  // TRANSITIONAL: EXPORT-block files lint metadata in block scope, not file-top.
  // While the ~146 library files still carry file-top metadata they take the
  // legacy path unchanged. Remove the `usesExport` branches (here and at the end)
  // once the codemod migration has wrapped every module in an EXPORT block.
  const ex = buildExportModel(file, body, tokens);

  spec.preCheck?.(file, errors);

  const state: State = {};
  const ctx: LintCtx = {
    file, spec, tokens, errors, state, index: 0,
    unexpected: t => errors.push({ file, line: t.line, message: spec.unexpected(t) }),
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'blank' || t.kind === 'comment' || t.kind === 'rawLine') continue;
    if (ex.usesExport) {
      // The `EXPORT <KIND> <name>:` opener lexes as a blockOpener; in an EXPORT
      // file it is the unit header, not an unexpected line.
      if (t.kind === 'blockOpener') continue;
      // A `topLevelOnly` spec validates only unit-body statements, never nested
      // sub-block bodies (SLOTS, IF/ELSE). The unit body now lives one level
      // deeper inside the EXPORT block, so scope to its direct children.
      if (spec.topLevelOnly && !ex.unitBodyLines.has(t.line)) continue;
    } else if (spec.topLevelOnly && t.indent >= 2) {
      continue;
    }

    // Inline block openers (e.g. `ROLE <role>:`) are unit headers, not body
    // statements: their bodies are validated by the inline-block path. Accept
    // them when the spec opts in, regardless of indent skipping above.
    if (spec.acceptBlockOpeners && t.kind === 'blockOpener') continue;

    ctx.index = i;

    if (t.kind === 'keyword') {
      const handler = handlerFor(spec, t.keyword);
      if (handler) { handler(t, ctx); continue; }
    } else if (t.kind === 'procRef' && spec.procRef) {
      spec.procRef(t, ctx);
      continue;
    }

    ctx.unexpected(t);
  }

  if (ex.usesExport) {
    // The per-spec finalizer and file-top ABOUT check both assume a file-top
    // unit header (one file = one primitive). In an EXPORT file the header is
    // the block opener and a file may hold several units, so structural
    // requirements are validated per-block instead.
    errors.push(...ex.errors);
  } else {
    // TRANSITIONAL: file-top finalizer + ABOUT requirement — retire with the
    // legacy branch once every module is wrapped in an EXPORT block.
    spec.finalize?.(state, errors, file);
    checkAbout(state, errors, file);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Reusable keyword handlers
// ---------------------------------------------------------------------------

const passthrough: KeywordHandler = () => { /* metadata; accept silently */ };

/** ABOUT handler: require non-empty rest and flag state.hasAbout. */
const aboutHandler: KeywordHandler = (t, ctx) => {
  if (!t.rest) { ctx.unexpected(t); return; }
  ctx.state.hasAbout = true;
};

/** Standard ABOUT-missing check used by every file kind's finalizer. */
function checkAbout(state: State, errors: LintError[], file: string): void {
  if (!state.hasAbout) errors.push({ file, line: 1, message: 'missing ABOUT' });
}

/** APPLIES: validate its hashtag / perimeter payload, accept silently when valid. */
const appliesHandler: KeywordHandler = (t, ctx) => {
  const err = validateAppliesPayload(t.rest);
  if (err) ctx.errors.push({ file: ctx.file, line: t.line, message: err });
};

/** Keyword is allowed iff `rest` is non-empty. Empty rest → unexpected. No state effect. */
const accept: KeywordHandler = (t, ctx) => {
  if (!t.rest) ctx.unexpected(t);
};

/** Same as `accept` but bumps a counter on `state[key]` when rest is present. */
const counts = (key: string): KeywordHandler => (t, ctx) => {
  if (!t.rest) { ctx.unexpected(t); return; }
  ctx.state[key] = ((ctx.state[key] as number | undefined) ?? 0) + 1;
};

/** Same as `accept` but sets `state[key] = true` when rest is present. */
const flags = (key: string): KeywordHandler => (t, ctx) => {
  if (!t.rest) { ctx.unexpected(t); return; }
  ctx.state[key] = true;
};

/** WHEN/IF-style trigger: validate content, prefix label in errors, optional state effect. */
function triggerHandler(label: 'WHEN' | 'IF', onAccept?: (state: State) => void): KeywordHandler {
  return (t, ctx) => {
    onAccept?.(ctx.state);
    const err = validateTriggerContent(t.rest);
    if (err) ctx.errors.push({ file: ctx.file, line: t.line, message: `${label} trigger: ${err}` });
  };
}

/**
 * IF/ELSE/UNTIL line at `index`: its IF or UNTIL condition is valid, an ELSE
 * comes right after an IF in the same body, and its body is indented ≥ 2 deeper.
 */
function ifElseErrors(t: KeywordToken, tokens: Token[], index: number, file: string): LintError[] {
  const errors: LintError[] = [];
  if (t.keyword === 'IF' || t.keyword === 'UNTIL') {
    const err = validateTriggerContent(t.rest);
    if (err) errors.push({ file, line: t.line, message: `${t.keyword} trigger: ${err}` });
  }
  if (t.keyword === 'ELSE') {
    // An ELSE is the second branch of an IF before it in the same body (the document
    // builder binds it to the last one) — never a line of its own.
    let hasIf = false;
    for (let j = index - 1; j >= 0 && !hasIf; j--) {
      const p = tokens[j];
      if (p.kind === 'blank' || p.kind === 'comment' || p.kind === 'rawLine' || p.indent > t.indent) continue;
      if (p.indent < t.indent) break;
      hasIf = p.kind === 'keyword' && p.keyword === 'IF';
    }
    if (!hasIf) errors.push({ file, line: t.line, message: 'ELSE must follow an IF in the same body' });
  }
  const next = nextSubstantive(tokens, index + 1);
  if (next === -1 || tokens[next].indent < t.indent + 2) {
    const head = t.keyword === 'UNTIL' ? 'UNTIL' : 'IF/ELSE';
    errors.push({ file, line: t.line, message: `${head} block body must be indented (Python-style): "${quoteRaw(t)}"` });
  }
  return errors;
}

/** IF/ELSE block: validate IF trigger and require ≥ 2-deeper indent on the body. */
const ifElseHandler: KeywordHandler = (t, ctx) => {
  ctx.errors.push(...ifElseErrors(t, ctx.tokens, ctx.index, ctx.file));
};

/** Header keyword (PROCEDURE, TEMPLATE): bump counter on `state[key]`, optional first-time capture. */
function headerHandler(stateKey: string, onFirst?: (t: KeywordToken, state: State) => void): KeywordHandler {
  return (t, ctx) => {
    if (!t.rest) { ctx.unexpected(t); return; }
    const prior = (ctx.state[stateKey] as number | undefined) ?? 0;
    ctx.state[stateKey] = prior + 1;
    if (prior === 0) onFirst?.(t, ctx.state);
  };
}

/** Compose two handlers: run both when keyword matches. */
function compose(...hs: KeywordHandler[]): KeywordHandler {
  return (t, ctx) => { for (const h of hs) h(t, ctx); };
}

/** Standard "no header / too many headers" finalizer. */
function checkHeaderCount(stateKey: string, name: string) {
  return (state: State, errors: LintError[], file: string) => {
    const n = (state[stateKey] as number | undefined) ?? 0;
    if (n === 0) errors.push({ file, line: 1, message: `${name} has no ${stateKey} header` });
    if (n > 1)  errors.push({ file, line: 1, message: `${name} has ${n} ${stateKey} headers (expected 1)` });
  };
}

// ---------------------------------------------------------------------------
// Per-file-kind specs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent-level identity keyword enforcement
// ---------------------------------------------------------------------------

/** A keyword→handler that rejects the keyword with `message`, pointing home. */
function makeRejectHandler(keyword: Keyword, message: string): readonly [Keyword, KeywordHandler] {
  return [keyword, (t, ctx) => {
    ctx.errors.push({ file: ctx.file, line: t.line, message });
  }] as const;
}

/**
 * Where a misplaced identity keyword was found. The canonical message
 * (`identityBelongsToRole`) reads the same everywhere; only this lead-in clause —
 * naming the offending surface — changes per call-site.
 */
type IdentityOffense = 'role' | 'AGENT block';

const IDENTITY_OFFENSE_CLAUSE: Record<IdentityOffense, string> = {
  'role':        'is only allowed in a role',
  'AGENT block': 'is not allowed inside an AGENT block',
};

/**
 * The one canonical message that sends an author's misplaced identity keyword
 * home: a single sentence, three call-sites. `offense` only selects the lead-in
 * clause naming the surface where the keyword was found.
 */
function identityBelongsToRole(kw: string, offense: IdentityOffense): string {
  return `${kw} ${IDENTITY_OFFENSE_CLAUSE[offense]} — it is the bound role's identity; declare it in the role the agent binds via AS`;
}

/**
 * These keywords belong to an agent's identity and are only valid inside an
 * `EXPORT AGENT` block. EXPERTISE moved to the role (an AGENT block binds a role
 * by name and may not redeclare it); MANDATE is the agent's own directive. Every
 * other file kind rejects them with a clear error pointing at the correct home.
 *
 * Distinct concern from `BLOCK_CONTRACTS.AGENT` (`requiresAll`/`unique` for
 * MANDATE): this list rejects MANDATE *outside* an AGENT block (wrong file kind),
 * while the contract enforces *exactly one* MANDATE *inside* one. The two never
 * overlap — placement here, cardinality there.
 */
const AGENT_ONLY_KEYWORDS: Keyword[] = ['MANDATE'];

const agentOnlyEntries = AGENT_ONLY_KEYWORDS.map(
  kw => makeRejectHandler(kw, `${kw} is only allowed inside an EXPORT AGENT block`),
);

/**
 * Role-identity keywords. They are valid in a role (and, for compat, a
 * directory-anchored `agent.ap`). Every OTHER file kind rejects them with a
 * message pointing at the role — an AGENT binds a role by name and never
 * redeclares its EXPERTISE. (ROLE is the block keyword itself, not an identity
 * attribute: the block name IS the role.)
 */
const ROLE_IDENTITY_KEYWORDS: Keyword[] = ['EXPERTISE'];

const roleIdentityEntries = ROLE_IDENTITY_KEYWORDS.map(
  kw => makeRejectHandler(kw, identityBelongsToRole(kw, 'role')),
);

/**
 * These keywords are only valid in a flow. Every other file kind must
 * reject them with a clear error pointing at the correct home.
 */
const FLOW_ONLY_KEYWORDS: Keyword[] = ['FLOW', 'STEP'];

/** The metadata every unit's file opens with — its ABOUT, its SCOPE, its APPLIES line. */
const unitMetadataEntries: [Keyword, KeywordHandler][] = [
  ['ABOUT',   aboutHandler],
  ['SCOPE',   passthrough],
  ['APPLIES', appliesHandler],
];

const flowOnlyEntries = FLOW_ONLY_KEYWORDS.map(
  kw => makeRejectHandler(kw, `${kw} is only allowed in a flow`),
);

// Policy files accept only the ALWAYS family. Listing the base `ALWAYS` admits
// its declensions (ALWAYS + !ALWAYS, i.e. NEVER post-desugar) via handlerFor.
const POLICY_ASSERTION_KEYWORDS: Keyword[] = ['ALWAYS'];

// ---------------------------------------------------------------------------
// Per-file-kind specs
// ---------------------------------------------------------------------------

const POLICY_SPEC: LintSpec = {
  topLevelOnly: false,
  keywords: new Map<Keyword, KeywordHandler>([
    ...unitMetadataEntries,
    ...POLICY_ASSERTION_KEYWORDS.map(kw => [kw, flags('hasAssertion')] as const),
    // INVARIANT: every file-kind spec except role and agent must include both
    // agentOnlyEntries and roleIdentityEntries — identity keywords are only
    // valid where an agent or role is defined, and rejected everywhere else.
    ...agentOnlyEntries,
    ...roleIdentityEntries,
    ...flowOnlyEntries,
  ]),
  unexpected: t => `unexpected line in a policy (expected ALWAYS/NEVER or metadata): "${quoteRaw(t)}"`,
  finalize: (state, errors, file) => {
    if (!state.hasAssertion) errors.push({ file, line: 1, message: 'policy has no ALWAYS or NEVER assertion' });
  },
};

// Force-level family bases — the list roles admit — plus the
// action/flow keywords. handlerFor expands each base to all its declensions:
// `AS <shape>` declares the procedure's output, `NEVER …`/`MUST! …` are its rules.
const PROCEDURE_FLOW_KEYWORDS: Keyword[] = ['IMPORT', ...ACTION_VERBS, 'VAR', 'UNTIL', 'RUN', ...getFamilyBases()];

const PROCEDURE_SPEC: LintSpec = {
  topLevelOnly: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ...unitMetadataEntries,
    ['PROCEDURE', headerHandler('PROCEDURE')],
    ['IF',        ifElseHandler],
    ['ELSE',      ifElseHandler],
    // The procedure's input contract — the shape of what it takes, when it has one.
    ['LENS-IN',   accept],
    ...PROCEDURE_FLOW_KEYWORDS.map(kw => [kw, accept] as const),
    // The removed DISTILL, in any of its old levels: its one error is checkVocabulary's.
    ...['DISTILL', 'DISTILL!', 'DISTILL!!', '!DISTILL'].map(kw => [kw, passthrough] as const),
    ...agentOnlyEntries,
    ...roleIdentityEntries,
    ...flowOnlyEntries,
  ]),
  procRef: () => { /* allowed, no count */ },
  unexpected: t => `unexpected line in a procedure: "${quoteRaw(t)}"`,
  finalize: checkHeaderCount('PROCEDURE', 'procedure'),
};

// Force-level family bases + action/flow keywords. handlerFor expands each
// base to all declensions at lookup time.
const ROLE_RULE_KEYWORDS: Keyword[] = [
  ...ACTION_VERBS, ...getFamilyBases(),
  'IF', 'ELSE', 'UNTIL', 'VAR', 'RUN', 'IMPORT',
];

const ROLE_SPEC: LintSpec = {
  topLevelOnly: false,
  acceptBlockOpeners: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ...unitMetadataEntries,
    // The block name IS the role; ROLE is the block opener (a `ROLE <name>:`
    // header), never an identity attribute. EXPERTISE (0-1) is the only
    // identity attribute a role declares; an AGENT binds the role by name and
    // cannot redeclare it.
    ['ROLE',      headerHandler('roleCount')],
    ['EXPERTISE', counts('expertiseCount')],
    ['EXTENDS',   counts('extendsCount')],
    ['WHEN',      triggerHandler('WHEN', s => { s.hasRule = true; })],
    ...ROLE_RULE_KEYWORDS.map(kw => [kw, compose(accept, flags('hasRule'))] as const),
    // IF/ELSE heads take the shared branch check: a bare `ELSE` has no rest, so
    // the generic rule-line handler above would reject it. Listed after the
    // spread, they override its entries.
    ['IF',        compose(ifElseHandler, flags('hasRule'))],
    ['ELSE',      ifElseHandler],
    ...agentOnlyEntries,
    ...flowOnlyEntries,
  ]),
  unexpected: t => `unexpected line in a role (expected EXPERTISE/ALWAYS/NEVER/WHEN/DO, EXTENDS, or metadata): "${quoteRaw(t)}"`,
  finalize: (state, errors, file) => {
    if (!state.hasRule) errors.push({ file, line: 1, message: 'role has no rules (ALWAYS/NEVER/WHEN/DO)' });
    const ext = (state.extendsCount as number | undefined) ?? 0;
    if (ext > 1) errors.push({ file, line: 1, message: `role has ${ext} EXTENDS clauses (expected at most 1)` });
    const expertise = (state.expertiseCount as number | undefined) ?? 0;
    if (expertise > 1) errors.push({ file, line: 1, message: `role has ${expertise} occurrences of EXPERTISE (expected at most 1)` });
  },
};

const TEMPLATE_SPEC: LintSpec = {
  topLevelOnly: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ...unitMetadataEntries,
    // Templates compose other templates: `IMPORT <tpl> FROM @lib.templates`
    // brings the shapes referenced by `<tpl>` / `LIST <tpl>` slots into scope.
    ['IMPORT',   accept],
    ['TEMPLATE', headerHandler('TEMPLATE', (t, state) => {
      // Tolerate a trailing colon (`TEMPLATE name:` block-opener form).
      const m = t.rest.match(/^([^\s:]+)/);
      if (m) { state.templateName = m[1]; state.templateNameLine = t.line; }
    })],
    ...agentOnlyEntries,
    ...roleIdentityEntries,
    ...flowOnlyEntries,
  ]),
  unexpected: t => `unexpected top-level line in a template (expected TEMPLATE header or metadata): "${quoteRaw(t)}"`,
  finalize: (state, errors, file) => {
    checkHeaderCount('TEMPLATE', 'template')(state, errors, file);
    const name = state.templateName as string | undefined;
    if (typeof name === 'string') {
      const fileSlug = unitNameFromPath(file);
      if (fileSlug && fileSlug !== name) {
        errors.push({
          file,
          line: (state.templateNameLine as number | undefined) ?? 1,
          message: `template name "${name}" does not match filename slug "${fileSlug}"`,
          severity: 'warning',
        });
      }
    }
  },
};

// A flat agent file is a `.ap` file holding an `EXPORT AGENT <name> AS <role>:`
// block. Its surface contract — required AS + MANDATE, forbidden EXPERTISE/APPLIES,
// allowed force-level lines (every family but DISTILL) and WHEN — lives entirely in `BLOCK_CONTRACTS.AGENT` and
// is validated by `lintAgentBlocks` (below). There is no separate file-top
// `agent.ap` spec: the block IS the unit.

// ---------------------------------------------------------------------------
// AGENT block lint — first-class `AGENT <name> AS <role>:` blocks
// ---------------------------------------------------------------------------

/**
 * Lint the inline `AGENT <name> AS <role>:` blocks in a generic `.ap` file.
 *
 * Reuses `BLOCK_CONTRACTS.AGENT` as the single source of truth: the allowed-
 * children surface (`allows`), the required children (`requiresAll`), the
 * at-most-one children (`unique`), and the role-owned children
 * (`identityKeywords`) are all read from the contract — this function adds no
 * second hand-authored keyword list. It only contributes what the generic
 * validator cannot: `AS <role>` is the header signature (parsed from the block's
 * `rest`), not a child, so it is excluded from the body cardinality passes and
 * validated separately. Enforces:
 *   - `AS <role>` present on the header (the role binding);
 *   - exactly one child MANDATE (contract: `requiresAll` ≥1 + `unique` ≤1);
 *   - HARD error on any ROLE/EXPERTISE/APPLIES child — define them in the role;
 *   - any child keyword outside the contract's `allows` is rejected.
 *
 * This is the single agent contract: a flat agent file IS its `EXPORT AGENT`
 * block, so `lintFile` routes every `.ap` here. There is no separate file-top
 * `agent.ap` spec.
 */
export function lintAgentBlocks(file: string, body: string): LintError[] {
  const errors: LintError[] = [];

  for (const block of parseBlocks(body).blocks) {
    if (!AGENT_KEYS.has(block.key)) continue;
    // A SKILL is an agent that also carries an APPLIES line: its own contract.
    const contract = BLOCK_CONTRACTS[block.key] ?? BLOCK_CONTRACTS.AGENT;
    // Role-owned children that get the "declare it in the role" hint — read from
    // the contract so `allows` and this set can never silently diverge.
    const forbidden = new Set<string>(contract.identityKeywords ?? []);

    // Header signature: `AS <role>, …` is optional — an agent may bind no role, one, or several,
    // written like every list of the language.
    const asText = agentAsText(block.rest);
    const spaced = asText ? spacedListError('AS', asText) : null;
    if (spaced) errors.push({ file, line: block.startLine, message: spaced });

    const childCounts = new Map<string, number>();
    for (const child of block.children) {
      if (child.type !== 'line') continue;

      childCounts.set(child.keyword, (childCounts.get(child.keyword) ?? 0) + 1);

      if (forbidden.has(child.keyword)) {
        errors.push({
          file, line: child.line,
          message: identityBelongsToRole(child.keyword, 'AGENT block'),
        });
        continue;
      }
      // `AS` as a child is rejected: the AGENT block's `AS` is its header
      // signature, never a body line. Everything else defers to the contract
      // (which expands force-level declensions to their family base internally).
      if (child.keyword === 'AS' || !isAllowedChild(contract, child.keyword as Keyword)) {
        errors.push({ file, line: child.line, message: notAllowed(child.keyword as Keyword, block.key, contract) });
      }
    }

    // Cardinality is read from the contract — the single source of truth. `AS` is
    // the header signature (handled above), so it is excluded from the child-body
    // cardinality pass even though the contract lists it.
    errors.push(...cardinalityErrors(file, block.startLine, block.key, contract, childCounts, ['AS']));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Generic block-contract validator
// ---------------------------------------------------------------------------

interface OpenBlock {
  keyword: Keyword;
  line: number;
  indent: number;
  children: Map<string, number>;
  contract: BlockContract;
  /** For a branch (IF/ELSE/UNTIL), at any depth: the block it belongs to, which counts its children too. */
  host?: OpenBlock;
}

/**
 * Walk `tokens` with an indent-based stack and enforce the contracts declared
 * in `contracts`. Returns lint errors for:
 *   - child keywords not listed in `allows`
 *   - missing `requiresAll` members
 *   - no `requiresAnyOf` member present
 *   - `unique` keywords appearing more than once
 */
/**
 * A child keyword is allowed when it is listed verbatim in `allows`, OR when
 * its force-level family base is listed (so a contract that lists `AS` admits
 * `AS`, `AS!`, `AS!!`, `!AS` without enumerating every declension).
 */
function isAllowedChild(contract: BlockContract, keyword: Keyword): boolean {
  if (contract.allows.includes(keyword) || isBranch(contract, keyword)) return true;
  const base = familyBaseOf(keyword);
  return base !== null && contract.allows.includes(base as Keyword);
}

/**
 * The force-level family base of a keyword in any declension or alias
 * (`MUST!`, `!ALWAYS`, `NEVER`, `MUST-NOT` → their base), or null. An alias
 * reaches here undesugared from `lintAgentBlocks`, which reads raw blocks.
 */
function familyBaseOf(keyword: string): string | null {
  return forceLevelBaseOf(toCanonicalKeyword(keyword));
}

/**
 * The "not allowed" error under `parent` — the one wording of a contract's
 * errors: `what` is wrong (by default `keyword`), then the reason the contract
 * gives for `keyword` — its family's `excluded` one — and what the block
 * admits instead.
 */
function notAllowed(keyword: Keyword, parent: string, contract: BlockContract, what: string = keyword): string {
  const why = contract.excluded?.[(familyBaseOf(keyword) ?? keyword) as Keyword];
  const expected = [...contract.allows, ...(contract.branches?.keywords ?? [])].join(', ');
  return `${what} is not allowed inside ${parent}${why ? ` — ${why}` : ''} (expected one of: ${expected})`;
}

/** The contract of an `EACH <item> IN {{<list>}} MAX <n>:` block — keyed apart from a DIMENSION's EACH line. */
const EACH_BLOCK = 'EACH IN';

/** Whether `keyword` opens a branch (IF/ELSE, UNTIL) of a block under `contract`. */
function isBranch(contract: BlockContract, keyword: Keyword): boolean {
  return contract.branches?.keywords.includes(keyword) ?? false;
}

/** The contracts checked line by line — a DIMENSION, a DOMAIN and a TEAM are checked on their parsed block (coveringBlockErrors, teamBlockErrors). */
const { DIMENSION: _parsed, DOMAIN: _domain, TEAM: _team, [PLUGIN_KEY]: _plugin, [OPERATION_KEY]: _operation, ...TOKEN_CONTRACTS } = BLOCK_CONTRACTS;
/** The blocks checked on their parsed block: their contract names every line they do not hold, so no other check repeats it. */
const PARSED_CONTRACTS = new Set(Object.keys(BLOCK_CONTRACTS).filter(key => !(key in TOKEN_CONTRACTS)));

export function validateBlockContracts(
  tokens: ReturnType<typeof lex>,
  file: string,
  contracts: Record<string, BlockContract> = TOKEN_CONTRACTS,
): LintError[] {
  const errors: LintError[] = [];
  const stack: OpenBlock[] = [];

  const popClosedBlocks = (currentIndent: number) => {
    while (stack.length > 0 && currentIndent <= stack[stack.length - 1].indent) {
      finalizeBlock(stack.pop()!, errors, file);
    }
  };

  for (const [index, t] of tokens.entries()) {
    // A block opener the contracts do not name (`EXPORT DIMENSION d:`, `SLOTS:`) still ends the blocks it is no deeper than.
    if (t.kind === 'blockOpener') popClosedBlocks(t.indent);
    if (t.kind !== 'keyword') continue;
    popClosedBlocks(t.indent);

    const parent = stack[stack.length - 1];
    // A keyword the language no longer has is the vocabulary check's to name, once.
    if (REMOVED_KEYWORDS[t.keyword as string]) continue;
    if (parent) {
      const c = parent.contract;
      const allowed = isAllowedChild(c, t.keyword);
      if (!allowed) {
        errors.push({ file, line: t.line, message: notAllowed(t.keyword, parent.keyword, c) });
      }
      // A branch is transparent: the lines it admits are its host block's lines too.
      for (const b of parent.host && allowed ? [parent, parent.host] : [parent]) {
        b.children.set(t.keyword, (b.children.get(t.keyword) ?? 0) + 1);
      }
    }

    if (parent && isBranch(parent.contract, t.keyword)) {
      // The branch is an IF/ELSE/UNTIL like anywhere else: same trigger and body
      // checks. It holds its block's branch lines — and, when the block's
      // branches nest, further branches, all hosted by that same block.
      errors.push(...ifElseErrors(t, tokens, index, file));
      const branches = parent.contract.branches!;
      stack.push({
        keyword: t.keyword, line: t.line, indent: t.indent, children: new Map(),
        contract: { allows: branches.allows, excluded: parent.contract.excluded, branches: branches.nests ? branches : undefined },
        host: parent.host ?? parent,
      });
    } else if (t.keyword === 'EACH' && contracts[EACH_BLOCK] && parseEachHead(t.rest)) {
      // `EACH <item> IN {{<list>}} MAX <n>:` holds its delegations; a malformed head is the vocabulary check's to name.
      const head = parseEachHead(t.rest)!;
      if ('error' in head) errors.push({ file, line: t.line, message: head.error });
      stack.push({ keyword: 'EACH', line: t.line, indent: t.indent, children: new Map(), contract: contracts[EACH_BLOCK] });
    } else if (contracts[t.keyword]) {
      stack.push({ keyword: t.keyword, line: t.line, indent: t.indent, children: new Map(), contract: contracts[t.keyword] });
    }
  }

  while (stack.length > 0) {
    finalizeBlock(stack.pop()!, errors, file);
  }
  return errors;
}

function finalizeBlock(block: OpenBlock, errors: LintError[], file: string): void {
  errors.push(...cardinalityErrors(file, block.line, block.keyword, block.contract, block.children));
}

/**
 * A block's counts held to its contract — every keyword it requires there, one
 * of those it requires any of, a unique one at most once. The one count check
 * and its one wording, whichever walk counted: the token contracts, the parsed
 * block-shaped kinds, an agent's body. `skip`: keywords the contract lists that
 * the caller checks elsewhere (an AGENT's `AS`, its header signature).
 */
function cardinalityErrors(
  file: string, line: number, key: string, contract: BlockContract,
  counts: ReadonlyMap<string, number>, skip: readonly string[] = [],
): LintError[] {
  const errors: LintError[] = [];
  const count = (k: string): number => counts.get(k) ?? 0;
  for (const required of contract.requiresAll ?? []) {
    if (!skip.includes(required) && count(required) === 0) errors.push({ file, line, message: `${key} block requires at least one ${required}` });
  }
  const anyOf = contract.requiresAnyOf ?? [];
  if (anyOf.length > 0 && !anyOf.some(k => count(k) > 0)) {
    errors.push({ file, line, message: `${key} block requires at least one of: ${anyOf.join(', ')}` });
  }
  for (const u of contract.unique ?? []) {
    if (!skip.includes(u) && count(u) > 1) errors.push({ file, line, message: `${key} block has ${count(u)} occurrences of ${u} (expected at most 1)` });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Flow lint (thin wrapper over generic machinery)
// ---------------------------------------------------------------------------

/**
 * Lint a flow file. Structural block rules are delegated to
 * `validateBlockContracts`; this function handles the file-level invariants
 * (H1 heading, ABOUT, exactly one FLOW block).
 */
export function lintFlow(file: string, body: string, options: LintOptions = {}): LintError[] {
  const errors: LintError[] = [];
  const tokens = desugar(lex(body));

  // Line length
  const maxLen = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  errors.push(...lengthErrors(file, tokens, maxLen));

  // ABOUT required
  if (!/^ABOUT\s+\S/m.test(body)) {
    errors.push({ file, line: 1, message: 'missing ABOUT' });
  }

  // Exactly one FLOW block; name must match filename slug
  const flowTokens = tokens.filter(t => t.kind === 'keyword' && t.keyword === 'FLOW');
  if (flowTokens.length === 0) {
    errors.push({ file, line: 1, message: 'flow has no FLOW block' });
  } else if (flowTokens.length > 1) {
    errors.push({ file, line: 1, message: `flow has ${flowTokens.length} FLOW blocks (expected exactly 1)` });
  } else {
    const flowToken = flowTokens[0];
    if (flowToken.kind === 'keyword') {
      const flowName = stripTrailingColon(flowToken.rest.trim()).split(/\s+/)[0] ?? '';
      const fileSlug = unitNameFromPath(file);
      if (fileSlug && flowName && fileSlug !== flowName) {
        errors.push({
          file,
          line: flowToken.line,
          message: `FLOW name "${flowName}" does not match filename slug "${fileSlug}"`,
          severity: 'warning',
        });
      }
    }
  }

  // Block structural contracts (generic); CONTEXT values are checked with every
  // other enum by checkVocabulary.
  errors.push(...validateBlockContracts(tokens, file));

  return errors;
}

/**
 * Enforce a declared BLOCK_CONTRACTS entry against one parsed block.
 *
 * `validateBlockContracts` is token-based and cannot see the `EXPORT <KIND>`
 * form, so the block-shaped kinds validate here instead — through parseBlocks,
 * which unwraps EXPORT. This is the shared body: a kind that declares a
 * contract gets its allowed/required/unique checks from the declaration, and
 * adding a kind stays what blockContracts.ts promises it is — one entry there,
 * not a hand-written copy of these three loops.
 */
function checkBlockContract(file: string, block: Block, key: string): LintError[] {
  const contract = BLOCK_CONTRACTS[key];
  if (!contract) return [];
  const errors: LintError[] = [];
  const counts = new Map<string, number>();

  // Its lines at any depth: a nested block is one of its regions (the author's
  // text, as written), or a line that opens a block — held to the contract like
  // any line, and so are the keyword lines beneath it. A line of prose is the
  // body's only beneath a line it belongs to; one opening with a keyword-like
  // word (`FOR` alone, `STPE`) is the vocabulary check's.
  const visit = (children: Node[], top: boolean): void => {
    for (const child of children) {
      if (child.type === 'block' && contract.regions?.includes(child.key)) continue;
      // A decorator's block is transparent: what it holds is this block's own (src/decorators.ts).
      if (child.type === 'block' && child.decorator) { visit(child.children, top); continue; }
      const keyword = child.type === 'block' ? child.key : child.keyword;
      const line = child.type === 'block' ? child.startLine : child.line;
      if (child.type === 'line' && keyword === OPAQUE_LINE) {
        // A starred trigger (`WHEN*`) is no keyword either: the vocabulary check names it.
        if (top && !KEYWORD_LIKE_RE.test(child.raw) && !starredTrigger(child.raw)) {
          errors.push({ file, line, message: notAllowed(keyword, key, contract, `a line of prose (\`${child.raw.trim()}\`)`) });
        }
        continue;
      }
      // A force-level line counts under its family base (`NEVER` → ALWAYS), as the contract lists it.
      const counted = familyBaseOf(keyword) ?? keyword;
      if (top) counts.set(counted, (counts.get(counted) ?? 0) + 1);
      if (!isAllowedChild(contract, keyword as Keyword)) {
        errors.push({ file, line, message: notAllowed(keyword as Keyword, key, contract) });
      } else if (child.type === 'block') visit(child.children, false);
    }
  };
  visit(block.children, true);
  errors.push(...cardinalityErrors(file, block.startLine, key, contract, counts));
  return errors;
}

/** The keyword parseBlocks gives a line no keyword opens — prose, kept as written. */
const OPAQUE_LINE = '__opaque__';

/** A glob that leaves the project root: absolute, from a home folder, or through `..`. */
function leavesRoot(glob: string): boolean {
  return /^([\\/~]|[A-Za-z]:[\\/])/.test(glob) || glob.split(/[\\/]/).includes('..');
}

/**
 * Every DIMENSION a file declares — at its top, or in an AGENT's body: its
 * contract, and its FOR globs, read from the project root. The one check of the
 * block wherever it is written — the lint of a library file, of an agent's
 * file, and the compiler's.
 */
export function dimensionBlockErrors(file: string, blocks: readonly Block[]): LintError[] {
  return coveringBlockErrors(file, blocks, 'DIMENSION');
}

/**
 * Every DOMAIN a file declares — at its top, or in an AGENT's body: its
 * contract, and its WRITES and READS lines (src/domains.ts) — files by IN
 * globs read from the project root; a formula, an error until a judge decides one.
 */
export function domainBlockErrors(file: string, blocks: readonly Block[]): LintError[] {
  return coveringBlockErrors(file, blocks, 'DOMAIN', DOMAIN_LINES, c => {
    const t = lex(c.raw)[0];
    const parts = parseDomainLine(c.rest);
    const issue = domainLineIssue(c.keyword as DomainLine, t?.kind === 'keyword' ? t.level ?? 0 : 0, parts);
    const spaced = spacedListError(`${c.keyword} IN`, c.rest.replace(/^.*?\bIN\s+/, ''));
    return { globs: parts.globs, issues: [issue, parts.globs.length ? spaced : null].filter((m): m is string => m !== null) };
  });
}

/**
 * The blocks that cover files (DIMENSION by FOR, DOMAIN by WRITES and READS):
 * their contract, what is wrong with each of those lines, and globs that stay
 * in the project.
 */
function coveringBlockErrors(file: string, blocks: readonly Block[], key: string, lines: readonly string[] = [GLOBS_LINE],
  read: (c: Line) => { globs: string[]; issues: string[] } = c => ({ globs: splitList(c.rest), issues: [] })): LintError[] {
  const found = blocks.flatMap(b => (b.key === key ? [b] : agentNestedBlocks([b], key).map(n => n.block)));
  return found.flatMap(b => [
    ...checkBlockContract(file, b, key),
    ...b.children.flatMap((c): LintError[] => {
      if (c.type !== 'line' || !lines.includes(c.keyword)) return [];
      const { globs, issues } = read(c);
      return [
        ...issues.map(message => ({ file, line: c.line, message })),
        ...globs.filter(leavesRoot).map(glob => ({ file, line: c.line, message: `${c.keyword} \`${glob}\`: a glob is read from the project root — no absolute path, no \`..\`` })),
      ];
    }),
  ]);
}

/**
 * Every block a plugin declares in a file — at its top, or in an AGENT's body:
 * its contract (the lines its template has, each as often as its slot says),
 * then its lines as a record of that template.
 */
export function pluginBlockErrors(file: string, blocks: readonly Block[]): LintError[] {
  return plugins().flatMap(spec => {
    const found = blocks.flatMap(b => (b.key === spec.key ? [b] : agentNestedBlocks([b], spec.key).map(n => n.block)));
    return found.flatMap(b => {
      const contract = checkBlockContract(file, b, spec.key);
      const lines = b.children.flatMap(c => (c.type === 'line' && c.keyword ? [{ key: String(c.keyword), rest: c.rest }] : []));
      const issues = contract.length > 0 ? null : lineIssues(spec, recordOfLines(spec, lines));
      return issues ? [...contract, { file, line: b.startLine, message: `${spec.key} ${b.name}: ${issues}` }] : contract;
    });
  });
}

/**
 * Every `EXPORT TEAM` block of a file against its contract: ABOUT and at least
 * one MEMBER, nothing a team does not hold. Its WHEN and FLOW blocks are its
 * regions — the token pass checks the flows, and a WHEN is a WHEN. One team per
 * file, exported, at the top: a second one, or one indented, is an error here.
 */
export function teamBlockErrors(file: string, blocks: readonly Block[]): LintError[] {
  const teams = blocks.filter(b => b.key === TEAM_KEY);
  const errors = teams.flatMap(b => [
    ...(b.exported ? [] : [{ file, line: b.startLine, message: `TEAM ${b.name ?? ''}: a team is exported — write \`EXPORT TEAM ${b.name ?? '<name>'}:\`` }]),
    ...checkBlockContract(file, b, TEAM_KEY),
    ...memberErrors(file, b),
  ]);
  if (teams.length > 1) errors.push({ file, line: teams[1].startLine, message: `a file declares one team — found ${teams.length} TEAM blocks` });
  return errors;
}

/**
 * A team's file as a compilation checks it: its TEAM block, and its flows line
 * by line — a STEP holds what a STEP holds wherever its flow is written.
 */
export function teamFileErrors(file: string, source: string): LintError[] {
  return [...teamBlockErrors(file, parseBlocks(source).blocks), ...validateBlockContracts(desugar(lex(source)), file)];
}

/** A team names its members: at least one MEMBER line. */
function memberErrors(file: string, team: Block): LintError[] {
  return team.children.some(c => c.type === 'line' && c.keyword === 'MEMBER') ? [] : [{ file, line: team.startLine, message: 'TEAM block requires at least one MEMBER' }];
}

/**
 * Shared skeleton for the single-block kinds (STORE, DIMENSION): exactly one block
 * of the kind, its name matching the filename slug, and its declared contract —
 * or the kind's own check of the block, when it has one.
 */
function lintSingleBlockKind(
  file: string, body: string, key: string, options: LintOptions = {},
  check: (block: Block) => LintError[] = block => checkBlockContract(file, block, key),
): LintError[] {
  const errors: LintError[] = [];
  const kind = key.toLowerCase();

  errors.push(...lengthErrors(file, desugar(lex(body)), options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH));

  const blocks = parseBlocks(body).blocks.filter(b => b.key === key);
  if (blocks.length === 0) {
    errors.push({ file, line: 1, message: `${kind} has no ${key} block` });
    return errors;
  }
  if (blocks.length > 1) {
    errors.push({ file, line: 1, message: `${kind} has ${blocks.length} ${key} blocks (expected exactly 1)` });
  }

  const block = blocks[0];
  const fileSlug = unitNameFromPath(file);
  if (fileSlug && block.name && fileSlug !== block.name) {
    errors.push({
      file,
      line: block.startLine,
      message: `${key} name "${block.name}" does not match filename slug "${fileSlug}"`,
      severity: 'warning',
    });
  }

  errors.push(...check(block));
  return errors;
}

/**
 * A store declares a named working table: TYPE names the backing plugin, LASTS
 * its lifetime, KEY the field that identifies a record. The record shape lives
 * in a SLOTS region and is validated by the template shape compiler, not here.
 */
export function lintStore(file: string, body: string, options: LintOptions = {}): LintError[] {
  return lintSingleBlockKind(file, body, 'STORE', options);
}

/**
 * A dimension declares an answer about the code the apx keeps: ABOUT, FOR,
 * EACH and AS once each, its rules beside them — all from its block contract.
 */
export function lintDimension(file: string, body: string, options: LintOptions = {}): LintError[] {
  return lintSingleBlockKind(file, body, 'DIMENSION', options, block => dimensionBlockErrors(file, [block]));
}

/** A domain declares a region of the code: ABOUT and FOR once each, its globs from the project root. */
export function lintDomain(file: string, body: string, options: LintOptions = {}): LintError[] {
  return lintSingleBlockKind(file, body, 'DOMAIN', options, block => domainBlockErrors(file, [block]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const lintPolicy     = (file: string, body: string, options: LintOptions = {}) => runLint(POLICY_SPEC,     file, body, options);
export const lintProcedure  = (file: string, body: string, options: LintOptions = {}) => runLint(PROCEDURE_SPEC,  file, body, options);
export const lintRole       = (file: string, body: string, options: LintOptions = {}) => runLint(ROLE_SPEC,       file, body, options);
export const lintTemplate   = (file: string, body: string, options: LintOptions = {}) => runLint(TEMPLATE_SPEC,   file, body, options);

/**
 * The old folder-per-agent layout: `<team>/definitions/<name>/agent.ap`. The
 * flat refactor replaced it with a sibling `<name>.ap` holding an `EXPORT AGENT`
 * block, so any surviving `definitions/.../agent.ap` is a regression to the
 * retired layout — a hard error, not a file to lint.
 */
const LEGACY_AGENT_DIR_RE = /(^|[/\\])definitions[/\\][^/\\]+[/\\]agent\.ap$/;

/**
 * Structural files that are never single-kind units: a team's routing
 * (an `EXPORT TEAM` block) and shared context (`team.ap`), a folder-per-agent body (`agent.ap`), an
 * import list (`imports.ap`), and a scope index (`index.ap`). Validated by
 * `lintAgentBlocks` like the original suffix dispatch did for any non-kind name.
 */
const ORCHESTRATION_BASENAMES = new Set(['team.ap', 'imports.ap', 'index.ap']);

/**
 * Runtime/scaffold files that carry their own non-kind suffix and are NEVER
 * single-kind units: `.phase.ap` (agent phase steps). Like the original suffix dispatch, they are validated by
 * `lintAgentBlocks`, not by a kind linter — important because they live under
 * the build-output `templates/` root that the dir switch would misread.
 */
const NON_KIND_SUFFIXES = ['.phase.ap'];

/**
 * An agent / orchestration / runtime file — validated by `lintAgentBlocks`,
 * never by a single-kind linter. Recognised by content or its non-kind suffix,
 * not by directory: a file-top `AS <role>` binding or an `AGENT` block marks an
 * agent; a TEAM block or `team.ap` marks a team's orchestration; `.phase.ap`
 * are scaffold files. These must escape the dir-folder switch because a
 * built-in scaffold lives at `templates/agents/<name>/agent.ap`, whose ancestor build-output `templates/`
 * directory would otherwise be read as a kind-folder.
 */
function isAgentOrOrchestration(file: string, body: string): boolean {
  const base = file.split(/[/\\]/).pop() ?? '';
  if (ORCHESTRATION_BASENAMES.has(base)) return true;
  if (NON_KIND_SUFFIXES.some(s => base.endsWith(s))) return true;
  if (/^AS\s+\S/m.test(body)) return true;
  return parseBlocks(body).blocks.some(b => AGENT_KEYS.has(b.key.toUpperCase()) || b.key.toUpperCase() === TEAM_KEY);
}

// ---------------------------------------------------------------------------
// Vocabulary — every line of every file speaks the language
// ---------------------------------------------------------------------------

/** A line only some blocks hold: those blocks, what it is of them, and — found in one of `hints`' blocks — what to write instead. */
interface LineOwner {
  owners: readonly string[];
  what: string;
  hints?: Readonly<Record<string, string>>;
}

/** An agent once named its domains with WRITES and READS: work is put within a domain by a decorator now. */
const WITHIN_HINT = 'an agent works within a domain by its decorator — write `@WITHIN <domain>` above its AGENT';

/** The lines only some blocks hold, and what each is of them: a COMPUTE's sections, a DIMENSION's FOR and EACH, a DOMAIN's WRITES and READS. */
const LINE_OWNERS = new Map<string, LineOwner>([
  ...COMPUTE_SECTIONS.map((s): [string, LineOwner] => [s, { owners: ['COMPUTE'], what: 'a section' }]),
  [GLOBS_LINE, { owners: ['DIMENSION'], what: 'a line' }],
  ...DOMAIN_LINES.map((l): [string, LineOwner] => [l, { owners: ['DOMAIN'], what: 'a line', hints: { AGENT: WITHIN_HINT } }]),
  ['EACH', { owners: ['DIMENSION'], what: 'a line' }],
  ['MEMBER', { owners: [TEAM_KEY], what: 'a line' }],
]);

/** A plugin's manifest against its contracts: the PLUGIN block, and each OPERATION block in it. */
export function pluginManifestErrors(file: string, blocks: readonly Block[]): LintError[] {
  return blocks.filter(b => b.key === PLUGIN_KEY).flatMap(plugin => [
    ...checkBlockContract(file, plugin, PLUGIN_KEY),
    ...plugin.children.flatMap(c => (c.type === 'block' && c.key === OPERATION_KEY ? checkBlockContract(file, c, OPERATION_KEY) : [])),
  ]);
}

/** Make a plugin's line one of its block's (src/plugins.ts): `ITEM` stands only in a CHECKLIST. */
export function registerLineOwner(key: string, owner: string): void {
  LINE_OWNERS.set(key, { owners: [owner], what: 'a line' });
}

/** What a keyword written alone on its line lacks — by keyword, else its text. */
const BARE_NEEDS: Record<string, string> = {
  FOR: 'at least one glob',
  EACH: 'what to translate in a file — a text, or a template\'s name',
  AS: 'the template it names',
} satisfies Record<DimensionLine | 'AS', string>;

/**
 * Where a line stands that cannot stand anywhere: a line one block holds
 * (LINE_OWNERS) directly in that block; a DIMENSION at the file top or directly
 * in an agent's body — a dimension is an agent's, reached through its apx.
 */
function placementError(key: string, parent: string | undefined, opens: boolean): string | null {
  // A block of its own (`DOMAIN api:`) is no line of another: a COMPUTE section (`ENSURE:`) still is.
  const owned = opens && blockTypeOf(key) ? undefined : LINE_OWNERS.get(key);
  if (owned && !owned.owners.includes(parent ?? '') && !PARSED_CONTRACTS.has(parent ?? '')) {
    const hint = owned.hints?.[parent ?? ''];
    return `${key} is ${owned.what} of a ${owned.owners.join(' or a ')} block — found inside ${parent || 'the file top'}${hint ? `: ${hint}` : ''}`;
  }
  if (opens && (key === 'DIMENSION' || key === 'DOMAIN' || pluginOfKey(key)) && parent && !AGENT_KEYS.has(parent)) return `a ${key} is declared at the file top or directly in an agent's body — found inside ${parent}`;
  return null;
}

/**
 * What is wrong with a trigger head's mark: `!WHEN` means nothing; `WHEN!!`
 * has no moment the agent could see — a sealed trigger is written as a prose
 * WHEN with IF!! beneath; `WHEN*` names an executor, and a trigger is no
 * condition one carries out. Null for a mark the trigger takes (none; `!` —
 * `WHEN!` desugared before this check).
 */
function triggerLevelError(key: string, level: number, stars = 0): string | null {
  if (!isTriggerKind(key)) return null;
  if (stars > 0) return `\`${key}${'*'.repeat(stars)}\` is not allowed — a trigger takes no star: write ${key}, or ${key}! (a judge decides the condition)`;
  if (level >= 0 && level <= 1) return null;
  return level < 0
    ? `\`!${key}\` is not allowed — write ${key}, or ${key}! (a judge decides the condition)`
    : `\`${key}!!\` is not allowed — a sealed trigger has no moment the agent could see: write \`${key} <moment>:\` with \`IF!! <condition>:\` beneath`;
}

/**
 * A line opening with a trigger written with stars (`WHEN*`, `WHEN!**`): the
 * lexer reads it as no keyword (splitControl), so it would pass for prose.
 */
function starredTrigger(raw: string): { key: string; level: number; stars: number } | null {
  const mark = splitExecutorMark(raw.trim().split(/[\s:]/)[0] ?? '');
  const split = mark.executor ? splitBangs(mark.word) : null;
  return split && isTriggerKind(split.base) ? { key: split.base, level: split.level, stars: mark.executor } : null;
}

/** A line that opens with a keyword-like word: `STPE`, `ON-AGENT-PROMPT`, `MEM!!!`. */
const KEYWORD_LIKE_RE = /^\s*(!*[A-Z][A-Z0-9-]+!*)(?=[\s:]|$)/;

/** The removed DISTILL (D22): a line of its own, or the older suffix on a rule line or a procedure header. */
const DISTILL_RE = /^!?DISTILL!{0,2}$/;
const DISTILL_SUFFIX_RE = /\s!?DISTILL!{0,2}:?$/;

/** Edits between two words — a swap of two neighbours counts as one (STPE → STEP). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Every word a line may open with: keywords, aliases, hooks, block kinds, template regions. */
function vocabulary(): string[] {
  return [...KEYWORDS, ...Object.keys(BLOCK_TYPES), ...VERBATIM_REGIONS];
}

/** ` — did you mean \`x\`?` when a word is one or two edits from a known one. */
function didYouMean(word: string, known: readonly string[]): string {
  const near = known.filter(w => editDistance(word, w) <= 2).sort((a, b) => editDistance(word, a) - editDistance(word, b));
  return near.length ? ` — did you mean \`${near[0]}\`?` : '';
}

function unknownKeyword(word: string): string {
  return `unknown keyword \`${word}\`${didYouMean(word, vocabulary())}`;
}

/** The slot types a SLOTS line may declare (docs: language.md, Slot type). */
const SLOT_TYPES = ['TEXT', 'NUMBER', 'ENUM[a, b]', '<template>', 'LIST <template>'];

/** A SLOTS line (`name[?]: TYPE … "description"`) whose TYPE is none of the language's. */
function slotTypeError(raw: string): string | null {
  const m = raw.trim().match(SLOT_LINE_RE);
  if (!m) return null;
  const type = m[3].replace(/\s*".*$/, '').trim();
  const values = type.match(/^ENUM\[(.*)\]$/i);
  if (values) { const spaced = spacedListError('ENUM[', values[1], ']'); if (spaced) return `slot \`${m[1]}\`: ${spaced}`; }
  if (parseTypeSpec(type).kind !== 'any') return null;
  const word = type.split(/[\s[<]/)[0].toUpperCase();
  return `slot \`${m[1]}\`: unknown type \`${type}\`${didYouMean(word, ['TEXT', 'NUMBER', 'ENUM', 'LIST'])} (types: ${SLOT_TYPES.join(', ')})`;
}

/** `MEM!!!` → the forms MEM really has, from its declared levels. */
function unknownLevel(word: string, base: string): string {
  const family = forceLevelFamilies().find(f => f.name === base)!;
  const forms = Object.keys(family.levels).map(Number).sort((a, b) => a - b)
    .map(l => (l < 0 ? '!'.repeat(-l) + base : base + '!'.repeat(l)));
  return `\`${word}\` is not a level of ${base} — use ${forms.join(', ')}`;
}

/**
 * The block a line belongs to: its nearest enclosing declaration (AGENT,
 * PROCEDURE, …) or a flow's step, from the keys of the lines enclosing it —
 * else, at a legacy file's top level, the kind of the file (by its folder).
 */
function ownerOf(ancestors: string[], file: string): string {
  return [...ancestors].reverse().find(k => blockTypeOf(k) !== null || k === 'STEP') ?? kindFromDir(file).toUpperCase();
}

/** The lines each body admits — a VAR stands in those whose list holds it. */
const BODY_KEYWORDS: Record<string, readonly Keyword[]> = {
  AGENT: BLOCK_CONTRACTS.AGENT.allows,
  SKILL: BLOCK_CONTRACTS.SKILL.allows,
  ROLE: ROLE_RULE_KEYWORDS,
  PROCEDURE: PROCEDURE_FLOW_KEYWORDS,
};
const VAR_HOMES = new Set(Object.keys(BODY_KEYWORDS).filter(k => BODY_KEYWORDS[k].includes('VAR')));

/**
 * What is wrong with a `VAR` line of a body: its form, its place, and the block
 * beneath it. `ancestors` are the keys of the lines enclosing it, outermost
 * first; `deeper` says whether indented lines follow it. A module's `EXPORT VAR`
 * is no body's: parseBlocks checks it.
 */
function varLineErrors(t: Extract<Token, { kind: 'keyword' }>, ancestors: string[], deeper: boolean, file: string): string[] {
  const decl = parseVarLine(t.keyword as string, t.rest);
  if (!decl) return [];
  if ('error' in decl) return [decl.error];
  const written = t.raw.trim();
  const errors: string[] = [];
  const owner = ownerOf(ancestors, file);
  if (ancestors.includes('VAR')) {
    errors.push('a VAR block holds no VAR — declare it before the block');
  } else if (ancestors.includes('UNTIL')) {
    errors.push('a VAR inside UNTIL would declare its variable again on every pass — declare it before the loop and reassign it with `DO … INTO`');
  } else if (!VAR_HOMES.has(owner)) {
    errors.push(`VAR goes in the body of one of: ${[...VAR_HOMES].join(', ')}${ancestors.length ? ` — found inside ${owner}` : ` — a module exports shared declarations: \`EXPORT SESSION VAR …\``}`);
  }
  if (decl.form === 'constant') {
    errors.push(`a module exports a constant (\`EXPORT VAR ${decl.name} = …\`) — a body declares private variables: \`VAR ${decl.name}\` or \`VAR ${decl.name} AS <template>\``);
  } else if (decl.scope === 'session') {
    errors.push(`a module exports a SESSION variable (\`EXPORT SESSION VAR ${decl.name}\`) for every agent that imports it — in a body, assign it with \`VAR ${decl.name}:\` or \`DO … INTO ${decl.name}\``);
  } else if (decl.block && !deeper) {
    errors.push(`\`${written}\` assigns the outcome of a block — indent that block beneath it`);
  } else if (!decl.block && deeper) {
    errors.push(`\`${written}\` has indented lines beneath — missing ':' (\`${written}:\` assigns their outcome)`);
  }
  return errors;
}

/** What is wrong with a line's trailing `INTO <name>`: only an action line takes one. */
function intoError(t: Extract<Token, { kind: 'keyword' }>): string | null {
  const into = splitInto(t.rest);
  if (!into || isVarKeyword(t.keyword as string)) return null;
  if (takesInto(t.keyword)) return null;
  return `INTO ends only a DO, DELEGATE, FORK, COMPUTE or RUN line — \`${t.raw.trim().split(/\s/)[0]}\` takes none`;
}

/** What an old `WITH x:` line is told: it is a decorator now. */
const WITH_REWRITE = 'WITH became a decorator — write `@WITH <names>` right above the block it is for, or `@WITH <names>:` around the lines';

/**
 * The keywords the language no longer has, each with the rewrite it is told —
 * still lexed, so the vocabulary check names it once and no block contract
 * repeats it.
 */
/** The rewrite every retired word of the contracts model points to (D16–18, D46). */
const CONTRACTS_REWRITE = 'a flow marks the zones and hands them out itself — in a STEP, `MARK <criterion> INTO <list> AS <spec>`, then `DELEGATE <list> BY <agent>`';
const REMOVED_KEYWORDS: Record<string, string> = {
  ASK: 'ASK became DELEGATE — write `DELEGATE <task> INTO <name> BY <agent>`',
  STRATEGY: `STRATEGY was removed — a team runs by its own flows: ${CONTRACTS_REWRITE}`,
  LEAD: `LEAD was removed — whoever runs a flow leads it: ${CONTRACTS_REWRITE}`,
  CONTRACT: `CONTRACT blocks were removed — a contract is what a MARK makes: ${CONTRACTS_REWRITE}`,
  WITHIN: 'a WITHIN line was a CONTRACT\'s — a contract may write beyond its zones by its MARK: `MARK … AS <spec> WITHIN <domain>`; work is put within a domain by `@WITHIN <domain>`',
  PARALLEL: 'PARALLEL was removed — in one STEP, start each piece with `DELEGATE~ <task> INTO <name> BY <agent>`, then `WAIT ALL`; one run per element of a list: `EACH <item> IN {{<list>}} MAX <n>:` with its DELEGATE or FORK lines beneath',
  CONTEXT: 'CONTEXT was removed — the form of a DELEGATE says the context: `DELEGATE … BY <agent>` hands over all of it, `DELEGATE … BY <agent> AS <template>` only what the template holds, `FORK …` the conversation itself',
};

/** What is wrong with a decorator line as written: its key, its items. Resolution is the compiler's. */
function decoratorLineErrors(key: string, rest: string): string[] {
  const spec = decoratorOf(key);
  if (!spec) return [unknownDecoratorMessage(key)];
  const { items, template } = splitDecoratorRest(rest);
  if (items.length === 0) return [`\`${DECORATOR_MARK}${key}\` needs what it names — a block or a tag: \`${DECORATOR_MARK}${key} <name>\``];
  const shaped = !template ? []
    : !spec.shape ? [`\`${DECORATOR_MARK}${key} … AS ${template}\`: ${DECORATOR_MARK}${key} shapes no answer — drop the AS`]
      : items.length > 1 || items[0].startsWith('#') ? [`\`${DECORATOR_MARK}${key} … AS ${template}\`: AS shapes the answer of one ${spec.shape} — name only that ${spec.shape}`] : [];
  return [...items.flatMap(item => decoratorItemError(spec, item) ?? []), ...shaped];
}

/**
 * The language's own words, checked in every file whatever its kind: an unknown
 * keyword, an undeclared force level, an enum value outside its set, the old
 * DISTILL suffix, and DISTILL's place — alone, directly inside a PROCEDURE that
 * has an `AS` result, once. VAR's place and form, a trailing INTO, a `{{…}}` read
 * where none is possible. Template regions and RAW blocks are the author's text.
 */
export function checkVocabulary(file: string, body: string): LintError[] {
  const errors: LintError[] = [];
  const err = (line: number, message: string) => errors.push({ file, line, message });
  const tokens = lex(body);
  /** Enclosing lines, innermost last — a line's parent is the nearest shallower one. */
  const stack: { indent: number; key: string; line: number }[] = [];
  /** The variables this module exports, by name — each once. */
  const exportedVars = new Map<string, number>();
  let exportsNoVariable: boolean | undefined;
  let region = -1;
  let regionKey = '';

  for (const [index, t] of tokens.entries()) {
    if (t.kind === 'blank' || t.kind === 'comment' || t.kind === 'rawLine') continue;
    if (region >= 0) {
      if (t.indent > region) {
        const typeError = regionKey === 'SLOTS' && 'raw' in t ? slotTypeError(t.raw) : null;
        if (typeError) err(t.line, typeError);
        if (regionKey !== 'SLOTS' && 'raw' in t && readsOf(t.raw).length > 0) {
          err(t.line, `a template's ${regionKey} is literal text — no \`{{…}}\` is read there`);
        }
        continue;
      }
      region = -1;
    }
    while (stack.length && stack[stack.length - 1].indent >= t.indent) stack.pop();
    const parent = stack[stack.length - 1];
    for (const { read, name, field, as, template } of readsOf('raw' in t ? t.raw : '')) {
      if (field) err(t.line, `\`${read}\`: reading a field of a variable is not supported yet — read \`{{${name}}}\``);
      if (as && as !== 'AS') err(t.line, `\`${read}\`: the AS of a read is a shape and takes no force level — write \`{{${name} AS ${template}}}\``);
    }

    // A decorator: its key and its items, then, opening a block, transparent — what it holds stands in its parent.
    if (t.kind === 'decorator') {
      for (const message of decoratorLineErrors(t.key, t.rest)) err(t.line, message);
      if (t.opens) stack.push({ indent: t.indent, key: parent?.key ?? '', line: t.line });
      continue;
    }

    let key = '';
    if (t.kind === 'blockOpener') {
      key = t.key === EXPORT_MODIFIER ? t.rest.split(/\s+/)[0] : t.key;
      // `EXPORT PROCEDURE** name:` — the stars are the head's executor mark; only a PROCEDURE takes one.
      const mark = splitExecutorMark(key);
      if (mark.executor) {
        key = mark.word;
        if (key !== 'PROCEDURE') err(t.line, `\`${key}${executorMark(mark.executor)}\`: only a PROCEDURE head takes an executor mark — a delegate (*) or a program (**) carries its body out`);
      }
      if (VERBATIM_REGIONS.includes(key)) { region = t.indent; regionKey = key; continue; }
      if (!LINE_OWNERS.has(key) && !blockTypeOf(key)) err(t.line, unknownKeyword(key));
    } else if (t.kind === 'keyword') {
      key = t.keyword as string;
      // `!IF` / `!UNTIL` mean nothing: the `!`s after the keyword say who decides the condition.
      // `WHEN!` is sugar for WHEN + IF! (desugared before this check); `WHEN!!` has no moment the agent could see.
      const trigger = triggerLevelError(key, t.level ?? 0);
      if (trigger) err(t.line, `${trigger}: "${quoteRaw(t)}"`);
      else if ((t.level ?? 0) < 0) err(t.line, `\`!${key}\` is not allowed — write ${key}, ${key}! (a judge decides) or ${key}!! (a sealed gate): "${quoteRaw(t)}"`);
      // The stars say who carries the condition out, the `!`s who judges it: a condition has one judge.
      if (t.executor && (t.level ?? 0) > 0) {
        err(t.line, `\`${t.raw.trim().split(/\s/)[0]}\` is not allowed — a condition has one judge: write ${key}! / ${key}!! (a judge decides) or ${key}* / ${key}** (a delegate or a program decides): "${quoteRaw(t)}"`);
      }
      if (key === 'COMPUTE' && splitBy(t.rest)) err(t.line, 'BY ends only a DELEGATE or a FORK line — COMPUTE is carried out by a program');
      // A delegation's parts, in their order (src/delegation.ts).
      if (isDelegationVerb(key)) for (const message of delegationLineErrors(key, t.rest)) err(t.line, message);
      if (key === WAIT_VERB) for (const message of waitLineErrors(t.rest)) err(t.line, message);
      if (key === MARK_VERB) for (const message of markLineErrors(t.rest)) err(t.line, message);
      const removed = REMOVED_KEYWORDS[key];
      if (removed) err(t.line, `${removed}: "${quoteRaw(t)}"`);
      const base = forceLevelBaseOf(key);
      if (base && getIntroByKeyword(key) === null) err(t.line, unknownLevel(key, base));
      // Every list of the language is comma-separated (src/lists.ts).
      const spaced = WORD_LIST_LINES.includes(key) ? spacedListError(key, t.rest) : null;
      if (spaced) err(t.line, spaced);
      // A perimeter says where a policy or a skill holds with no WITH: any other block has none to say.
      if (key === 'APPLIES' && parseApplies([t.rest]).scopes.length > 0) {
        const owner = ownerOf(stack.map(s => s.key), file);
        if (!PERIMETER_KINDS.includes(owner.toLowerCase())) err(t.line, `APPLIES: a perimeter (${PERIMETER_FORMS}) goes on a POLICY or a SKILL — found on ${owner}`);
      }
      const prim = enumPrimitiveFor(key);
      const value = t.rest.trim().replace(/:$/, '');
      if (prim && value && !prim.values[value]) {
        err(t.line, `${key}: unknown value \`${value}\` (allowed: ${Object.keys(prim.values).join(', ')})`);
      }
      if (key === 'LASTS' && !(STORE_LIFETIMES as readonly string[]).includes(value)) {
        err(t.line, `LASTS: unknown value \`${value}\`${didYouMean(value, STORE_LIFETIMES)} (allowed: ${STORE_LIFETIMES.join(', ')})`);
      }
      // DISTILL (D22) was removed: a program carries out a PROCEDURE** or a COMPUTE block.
      if (DISTILL_RE.test(key) || DISTILL_SUFFIX_RE.test(t.rest.trim())) {
        err(t.line, `DISTILL was removed — mark the procedure PROCEDURE** or write a COMPUTE block: "${quoteRaw(t)}"`);
      }
      // DOMAINS was removed: a contract's DOMAIN names a DOMAIN block its BY agent works within (D44).
      if (key === 'DOMAINS') {
        err(t.line, `DOMAINS was removed — the files of a domain are its \`EXPORT DOMAIN <name>:\` block's WRITES and READS, and a CONTRACT's \`DOMAIN <name>\` goes to an agent within it (\`@WITHIN <name>\`): "${quoteRaw(t)}"`);
      }
      // WITH became a decorator (src/decorators.ts).
      if (key === 'WITH') err(t.line, `${WITH_REWRITE}: "${quoteRaw(t)}"`);
      // OWNS was removed: work is put within a domain by `@WITHIN` (D44).
      if (key === 'OWNS') {
        err(t.line, `OWNS was removed — declare the files as \`EXPORT DOMAIN <name>:\` with \`WRITES IN ${splitList(t.rest).join(', ')}\`, and write \`@WITHIN <name>\` above the agent: "${quoteRaw(t)}"`);
      }
      if (!isVarKeyword(key) && stack.some(a => a.key === 'VAR') && !isAllowedChild(VAR_BLOCK, key as Keyword)) {
        err(t.line, notAllowed(key as Keyword, 'VAR', VAR_BLOCK));
      }
      const exported = exportedVar(t);
      if (exported) {
        const decl = readExportedVar(exported);
        if ('error' in decl) err(t.line, decl.error);
        else if (exportsNoVariable ??= ownsNoVariable(file, body)) {
          err(t.line, `\`EXPORT ${exported.rest}\`: a library module exports variables — an agent's file or a team's file declares one in a body (\`VAR ${decl.name}\`), or IMPORTs it`);
        } else {
          const first = exportedVars.get(decl.name);
          if (first !== undefined) err(t.line, `\`${decl.name}\` is exported twice in this module — first at line ${first}`);
          else exportedVars.set(decl.name, t.line);
          const next = nextSubstantive(tokens, index + 1);
          if (next !== -1 && tokens[next].indent > t.indent) err(tokens[next].line, `\`EXPORT ${exported.rest}\` is one line — an exported variable has no body`);
        }
      }
      if (isVarKeyword(key)) {
        const next = nextSubstantive(tokens, index + 1);
        const deeper = next !== -1 && tokens[next].indent > t.indent;
        for (const message of varLineErrors(t, stack.map(a => a.key), deeper, file)) err(t.line, message);
      }
      const into = intoError(t);
      if (into) err(t.line, into);
    } else if (t.kind === 'unknown' && /^\s*!WITH\b/.test(t.raw)) {
      err(t.line, `!WITH was removed — a policy says where it holds with its APPLIES line: to keep lines out of one, narrow its perimeter: "${t.raw.trim()}"`);
    } else if (t.kind === 'unknown') {
      const word = t.raw.match(KEYWORD_LIKE_RE)?.[1];
      const starred = starredTrigger(t.raw);
      if (starred) {
        err(t.line, `${triggerLevelError(starred.key, starred.level, starred.stars)}: "${t.raw.trim()}"`);
      } else if (word) {
        const base = forceLevelBaseOf(word);
        // A keyword alone on its line — `FOR`, `EACH`, `MUST` — lacks what it says.
        // A retired word alone on its line (`PARALLEL:`, `STRATEGY`) is told its rewrite, not what it lacks.
        const retired = REMOVED_KEYWORDS[word];
        if (retired) err(t.line, `${retired}: "${t.raw.trim()}"`);
        else if (KEYWORDS.includes(word) || (base && getIntroByKeyword(word) !== null)) err(t.line, `${word} needs ${BARE_NEEDS[base ?? word] ?? 'its text on the same line'}`);
        else err(t.line, base ? unknownLevel(word, base) : unknownKeyword(word));
      }
    }
    // `EACH <item> IN {{<list>}}` opens a flow's block, no DIMENSION line (src/vars.ts parseEachHead).
    const eachBlock = key === 'EACH' && t.kind === 'keyword' && parseEachHead(t.rest) !== null;
    const placed = eachBlock ? null : placementError(key, parent?.key, t.kind === 'blockOpener' || opensBlock(t));
    if (placed) err(t.line, placed);
    stack.push({ indent: t.indent, key, line: t.line });
  }

  errors.push(...computeBlockErrors(file, body));
  // A decorator decorating no block: the parser's to see (src/parseBlocks.ts), the lint's to report.
  errors.push(...parseBlocks(body).errors.filter(e => e.decorator).map(e => ({ file, line: e.line, message: e.message })));
  // What a `~` starts is waited for in its own block, and read after its WAIT (src/delegation.ts).
  errors.push(...concurrencyErrors(buildTree(tokens)).map(e => ({ file, ...e })));
  return errors;
}

/**
 * A COMPUTE block's shape (src/executor.ts): ABOUT and rules on top, then
 * REQUIRE:, RETURN AS <template>: and ENSURE:, once each, in this order, none
 * empty. REQUIRE and ENSURE hold rules and IF only; RETURN holds what a program
 * can carry out — DO, COMPUTE, IF, UNTIL and rules — never DELEGATE, FORK, WAIT, RUN, MEM, WITH or VAR.
 */
function computeBlockErrors(file: string, body: string): LintError[] {
  const errors: LintError[] = [];
  const err = (line: number, message: string) => errors.push({ file, line, message });
  const isRule = (keyword: string) => forceLevelBaseOf(keyword) !== null && !NON_RULE_FAMILIES.includes(forceLevelBaseOf(keyword)!);
  const RETURN_LINES = new Set(['DO', 'COMPUTE']);
  const RETURN_BLOCKS = new Set(['IF', 'ELSE', 'UNTIL']);
  const check = (nodes: Node[], section: string, name: string): void => {
    for (const c of nodes) {
      const kw = c.type === 'line' ? c.keyword : c.key;
      const allowed = section === 'RETURN'
        ? isRule(kw) || kw === 'ELSE' || (c.type === 'line' ? RETURN_LINES.has(kw) : RETURN_BLOCKS.has(kw))
        : isRule(kw) || kw === 'ELSE' || (c.type === 'block' && kw === 'IF');
      const line = c.type === 'line' ? c.line : c.startLine;
      if (!allowed) {
        err(line, section === 'RETURN'
          ? `${kw} is not allowed in RETURN of COMPUTE \`${name}\` — a program carries it out: DO, COMPUTE, IF, UNTIL and rules only`
          : `${kw} is not allowed in ${section} of COMPUTE \`${name}\` — it holds only rules (MUST, NEVER, …) and IF`);
        continue;
      }
      if (c.type === 'block') check(c.children, section, name);
    }
  };
  const visit = (blocks: Node[]): void => {
    for (const b of blocks) {
      if (b.type !== 'block') continue;
      if (!b.computed) { visit(b.children); continue; }
      const name = b.name ?? '';
      const seen: string[] = [];
      for (const c of b.children) {
        if (c.type === 'line') {
          if (c.keyword !== 'ABOUT' && c.keyword !== 'APPLIES' && !isRule(c.keyword)) {
            err(c.line, `${c.keyword} is not allowed on top of COMPUTE \`${name}\` — ABOUT and rules on how the script is written, then REQUIRE:, RETURN AS <template>: and ENSURE:`);
          }
          continue;
        }
        if (!(COMPUTE_SECTIONS as readonly string[]).includes(c.key)) {
          err(c.startLine, `${c.key} is not allowed on top of COMPUTE \`${name}\` — its sections are REQUIRE:, RETURN AS <template>: and ENSURE:`);
          continue;
        }
        const expected = COMPUTE_SECTIONS[seen.length];
        if (seen.includes(c.key) || c.key !== expected) {
          err(c.startLine, `${c.key} in COMPUTE \`${name}\` is out of order or repeated — REQUIRE:, RETURN AS <template>:, ENSURE:, once each`);
        }
        seen.push(c.key);
        if (c.key === 'RETURN') {
          const head = `${c.name ?? ''} ${c.rest}`.trim();   // the parser splits `AS <template>` into name and rest
          if (/^AS!+\s/.test(head)) err(c.startLine, 'RETURN AS takes no force level — the program\'s result is always checked against its template');
          else if (!returnShape(head)) err(c.startLine, `RETURN in COMPUTE \`${name}\` needs its result shape — write \`RETURN AS <template>:\``);
        }
        if (c.children.length === 0) err(c.startLine, `${c.key} in COMPUTE \`${name}\` holds no line — write at least one`);
        check(c.children, c.key, name);
      }
      for (const section of COMPUTE_SECTIONS) {
        if (!seen.includes(section)) err(b.startLine, `COMPUTE \`${name}\` needs its ${section} section — REQUIRE:, RETURN AS <template>: and ENSURE:, in this order`);
      }
    }
  };
  visit(parseBlocks(body).blocks);
  return errors;
}

export function lintFile(file: string, body: string, options: LintOptions = {}): LintError[] {
  // Both checks read a list's form (the vocabulary's, and APPLIES's own payload check): one error per line and message.
  const seen = new Set<string>();
  return [...checkVocabulary(file, body), ...lintByKind(file, body, options)].filter(e => {
    const key = `${e.line}\0${e.message}`;
    return !seen.has(key) && !!seen.add(key);
  });
}

/** An agent's file or a team's file: a variable exported there would be no one's — library modules export them. */
function ownsNoVariable(_file: string, body: string): boolean {
  return parseBlocks(body).blocks.some(b => AGENT_KEYS.has(b.key) || b.key === TEAM_KEY);
}

/**
 * A module's text with its top-level `EXPORT VAR` lines blanked — line numbers
 * kept — and whether nothing else but imports, comments and blanks is left.
 */
function withoutExportedVars(body: string): { body: string; onlyVars: boolean } {
  const lines = body.split(/\r?\n/);
  const tokens = lex(body);
  const exported = tokens.filter(t => exportedVar(t)?.indent === 0).map(t => t.line);
  if (exported.length === 0) return { body, onlyVars: false };
  for (const line of exported) lines[line - 1] = '';
  const rest = tokens.filter(t => t.kind !== 'blank' && t.kind !== 'comment' && !exported.includes(t.line)
    && !(t.kind === 'keyword' && t.keyword === 'IMPORT'));
  return { body: lines.join('\n'), onlyVars: rest.length === 0 };
}

function lintByKind(file: string, body: string, options: LintOptions): LintError[] {
  if (LEGACY_AGENT_DIR_RE.test(file)) {
    return [{
      file, line: 1,
      message: 'retired layout: agents are flat `<name>.ap` files holding an EXPORT AGENT block, not `definitions/<name>/agent.ap`',
    }];
  }
  // Agent and orchestration files are validated by `lintAgentBlocks`. They are
  // recognised by content, ahead of the dir switch, because they carry FLOW/ROLE
  // blocks that are NOT the file's kind and may sit under a build-output
  // `templates/` ancestor that the dir switch would misread.
  // Their FLOW blocks (a team's file) take the same block contracts as a
  // flow file: FLOW, STEP, EACH and their branches, wherever they live.
  if (isAgentOrOrchestration(file, body)) {
    const blocks = parseBlocks(body).blocks;
    return [...lintAgentBlocks(file, body), ...validateBlockContracts(desugar(lex(body)), file), ...dimensionBlockErrors(file, blocks), ...pluginBlockErrors(file, blocks), ...teamBlockErrors(file, blocks)];
  }

  // A module's exported variables are its kind lint's no business: they are
  // the vocabulary check's. A module that only exports variables has no kind.
  const declarations = withoutExportedVars(body);
  if (declarations.onlyVars) return [];
  body = declarations.body;

  // Otherwise the lint dispatch is dir-authoritative: the kind-folder a file
  // lives under names the linter, never a suffix and never a block. A loose
  // `policies/x.ap` holding only ALWAYS/NEVER lines is still a policy.
  // `kindFromDir` derives this from the one kind registry.
  switch (kindFromDir(file)) {
    case 'policy':    return lintPolicy(file, body, options);
    case 'procedure': return lintProcedure(file, body, options);
    case 'role':      return lintRole(file, body, options);
    case 'template':  return lintTemplate(file, body, options);
    case 'flow':      return lintFlow(file, body, options);
    case 'store':     return lintStore(file, body, options);
    case 'dimension': return lintDimension(file, body, options);
    case 'domain':    return lintDomain(file, body, options);
  }
  const plugin = pluginOf(kindFromDir(file));
  if (plugin) return lintSingleBlockKind(file, body, plugin.key, options, block => pluginBlockErrors(file, [block]));
  // tool / generic (agents, teams, orchestration): a `.ap` holding an
  // `EXPORT AGENT … AS …` block or the file-top AS/MANDATE form — validated by
  // `lintAgentBlocks`. Tools have no dedicated linter and inline cleanly here.
  if (file.endsWith('.ap'))           return lintAgentBlocks(file, body);
  return [];
}

/**
 * The first line of `path` that names `name` — where a broken reference sits:
 * a use (any line but an IMPORT), or the IMPORT that asks for it. 1 when unknown.
 */
export function lineOfName(path: string, name: string, on: 'use' | 'import' = 'use'): number {
  if (!existsSync(path)) return 1;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s\`(,])${escaped}($|[\\s:\`),])`);
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const i = lines.findIndex(l => /^\s*IMPORT\s/.test(l) === (on === 'import') && re.test(l));
  return i + 1 || 1;
}

export function formatErrors(errors: LintError[]): string {
  return errors.map(e => {
    const tag = e.severity === 'warning' ? 'warning' : 'error';
    const col = e.col !== undefined ? `:${e.col}` : '';
    const code = e.code ? `[${e.code}] ` : '';
    return `${tag}  ${e.file}:${e.line}${col}  ${code}${e.message}`;
  }).join('\n');
}

/**
 * The checked heads (`IF!`, `IF!!`, …) of a source no document builder walks —
 * a standalone file, the procedures it runs, a team's file as AGENTS.md renders it
 * — judged by `condCheckOf`, where each stands. Without `agentOf` (a standalone file)
 * no executable is anywhere. With it (a team's file, BY lines already
 * resolved to agents): a step's head is its BY agent's, a head between a
 * flow's steps is the flow's, and one in the team's routing has none.
 */
export function checkedHeadIssues(
  file: string, source: string, checks: object | null | undefined, agentOf?: (by: string) => string | null,
): LintError[] {
  const issues: LintError[] = [];
  const keyOf = (n: TreeNode): string => (n.token.kind === 'keyword' ? n.token.keyword as string : n.token.kind === 'blockOpener' ? n.token.key : '');
  const visit = (nodes: TreeNode[], site: CheckSite, parent: { keyword: string; condition: string } | null = null): void => {
    const first = nodes.find(c => c.token.kind !== 'blank');
    for (const n of nodes) {
      const t = n.token;
      const key = keyOf(n);
      if (t.kind === 'keyword' && (key === 'IF' || key === 'UNTIL')) {
        const split = splitMax(stripTrailingColon(t.rest));
        const { condition } = split;
        // The IF! of a desugared WHEN! reports as WHEN! — the head the author wrote.
        const head = sugaredHead(parent, n === first, t.level ?? 0, condition) ?? checkedKeyword(key as CheckKind, t.level ?? 0);
        // A loop a judge, a delegate or a program ends writes its MAX (src/check.ts maxIssue).
        const bounded = (t.level ?? 0) > 0 || (t.executor ?? 0) > 0;
        const max = maxIssue(key as CheckKind, `${head}${executorMark(t.executor ?? 0)}`, bounded, split);
        if (max) issues.push({ file, line: t.line, message: max });
        const { issue } = condCheckOf(key as CheckKind, t.level ?? 0, condition, site, checks, head, split.max);
        if (issue) issues.push({ file, line: t.line, ...issue });
      }
      let inner = site;
      if (agentOf && key === 'FLOW') inner = { at: 'flow' };
      // In a flow, a DELEGATE block's agent checks the conditions among its lines; whoever runs the flow checks none yet.
      if (agentOf && key === 'STEP') inner = { at: 'flow' };
      if (agentOf && t.kind === 'keyword' && isDelegationVerb(key) && site.at !== 'none') {
        const by = parseDelegation(key, t.rest).by;
        inner = { at: 'step', agent: by ? agentOf(by) : null };
      }
      visit(n.children, inner, t.kind === 'keyword' && key === 'WHEN' ? { keyword: 'WHEN', condition: stripTrailingColon(t.rest) } : null);
    }
  };
  visit(buildTree(lex(source)), { at: 'none' });
  return issues;
}
