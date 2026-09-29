// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, readFileSync } from 'fs';
import { lex, Token, Keyword, KEYWORDS } from './lexer.js';
import { desugar } from './desugar.js';
import { TAG_RE } from './services/tags.js';
import { getFamilyBases, getIntroByKeyword, forceLevelBaseOf, forceLevelFamilies } from './forceLevelConfig.js';
import { enumPrimitiveFor } from './primitives.js';
import { BLOCK_CONTRACTS, BlockContract } from './blockContracts.js';
import { parseBlocks, type Block } from './parseBlocks.js';
import { isExportFile } from './services/text.js';
import { parseAgentSignature } from './definitionArgs.js';
import { kindFromDir, unitNameFromPath } from './ingest.js';
import { BLOCK_TYPES, blockTypeOf, EXPORT_MODIFIER } from './blockTypes.js';
import { parseTypeSpec } from './shapeSchema.js';
import { STORE_LIFETIMES } from './storeTypes/types.js';

export interface LintError {
  file: string;
  line: number;
  message: string;
  severity?: 'error' | 'warning';
}

export interface LintOptions {
  maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 120;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Validate a TAGS payload using the shared TAG_RE from tags.ts.
 *
 * TAG_RE enforces the `.ap` DSL contract: `#` + alphanumeric start + only
 * alphanumeric/hyphen chars. No commas, slashes, underscores, or missing `#`.
 */
function validateTagsPayload(rest: string): string | null {
  const trimmed = rest.trim();
  if (!trimmed) return 'TAGS payload is empty — provide at least one #hashtag';
  const tokens = trimmed.split(/\s+/);
  for (const tok of tokens) {
    if (!TAG_RE.test(tok)) {
      return `TAGS token "${tok}" is invalid — expected classic flat hashtag like #kebab-slug (no commas, slashes, or missing #)`;
    }
  }
  return null;
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
// (ABOUT/TAGS/APPLIES) lives in block scope, not at file-top. A file that uses
// EXPORT blocks takes the block-scoped lint path; a legacy file (file-top
// metadata, no EXPORT block) keeps the current file-top path unchanged.
//
// The legacy path and the `usesExport` branch in runLint are the only seam to
// remove once the codemod migration has wrapped every module in an EXPORT block.
// ---------------------------------------------------------------------------

/** Metadata keywords that, in an EXPORT file, must live inside a block, not at file-top. */
const METADATA_KEYWORDS = new Set<Keyword>(['ABOUT', 'TAGS', 'APPLIES', 'SCOPE']);

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
 * rules — every exported block needs an ABOUT child (TAGS optional, APPLIES/WHEN
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
    if (block.exported && !hasAbout) {
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

/** TAGS: validate classic flat hashtag payload, accept silently when valid. */
const tagsHandler: KeywordHandler = (t, ctx) => {
  const err = validateTagsPayload(t.rest);
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

/** IF/ELSE block: validate IF trigger and require ≥ 2-deeper indent on the body. */
const ifElseHandler: KeywordHandler = (t, ctx) => {
  if (t.keyword === 'IF') {
    const err = validateTriggerContent(t.rest);
    if (err) ctx.errors.push({ file: ctx.file, line: t.line, message: `IF trigger: ${err}` });
  }
  const next = nextSubstantive(ctx.tokens, ctx.index + 1);
  if (next === -1 || ctx.tokens[next].indent < t.indent + 2) {
    ctx.errors.push({
      file: ctx.file, line: t.line,
      message: `IF/ELSE block body must be indented (Python-style): "${quoteRaw(t)}"`,
    });
  }
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
const FLOW_ONLY_KEYWORDS: Keyword[] = ['FLOW', 'STEP', 'PARALLEL'];

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
    ['ABOUT',   aboutHandler],
    ['SCOPE',   passthrough],
    ['APPLIES', passthrough],
    ['TAGS',    tagsHandler],
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

// Force-level family bases (post-desugar), plus DO. handlerFor() expands each
// base to all its declensions at lookup time — no enumeration needed here.
const PLAYBOOK_ACTION_KEYWORDS: Keyword[] = ['DO', ...getFamilyBases()];
const PLAYBOOK_FLOW_KEYWORDS: Keyword[] = ['RETURN', 'UNTIL', 'RUN', 'IMPORT'];

const PLAYBOOK_SPEC: LintSpec = {
  topLevelOnly: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ['ABOUT',   aboutHandler],
    ['SCOPE',   passthrough],
    ['APPLIES', passthrough],
    ['TAGS',    tagsHandler],
    ['WHEN',  triggerHandler('WHEN', s => { s.whenCount = ((s.whenCount as number) ?? 0) + 1; })],
    ['IF',    ifElseHandler],
    ['ELSE',  ifElseHandler],
    ...PLAYBOOK_ACTION_KEYWORDS.map(kw => [kw, counts('doCount')] as const),
    ...PLAYBOOK_FLOW_KEYWORDS.map(kw => [kw, accept] as const),
    ...agentOnlyEntries,
    ...roleIdentityEntries,
    ...flowOnlyEntries,
  ]),
  procRef: (_t, ctx) => { ctx.state.doCount = ((ctx.state.doCount as number) ?? 0) + 1; },
  unexpected: t => `unexpected line in a playbook (expected WHEN/force-level/DO/IF/ELSE/RUN/@ref or metadata): "${quoteRaw(t)}"`,
  finalize: (state, errors, file) => {
    if (!state.whenCount) errors.push({ file, line: 1, message: 'playbook has no WHEN trigger' });
    if (!state.doCount)   errors.push({ file, line: 1, message: 'playbook has no DO action' });
  },
};

// `AS` (base) admits every declension via handlerFor — a procedure declares
// its output shape with `AS <shape>`, replacing the former `RETURN AS` combo.
const PROCEDURE_FLOW_KEYWORDS: Keyword[] = ['IMPORT', 'DO', 'RETURN', 'UNTIL', 'RUN', 'AS'];

const PROCEDURE_SPEC: LintSpec = {
  topLevelOnly: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ['ABOUT',   aboutHandler],
    ['SCOPE',     passthrough],
    ['APPLIES',   passthrough],
    ['TAGS',      tagsHandler],
    ['PROCEDURE', headerHandler('PROCEDURE')],
    ['IF',        ifElseHandler],
    ['ELSE',      ifElseHandler],
    ...PROCEDURE_FLOW_KEYWORDS.map(kw => [kw, accept] as const),
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
  'DO', ...getFamilyBases(),
  'IF', 'ELSE', 'UNTIL', 'RETURN', 'RUN', 'IMPORT',
];

const ROLE_SPEC: LintSpec = {
  topLevelOnly: false,
  acceptBlockOpeners: true,
  keywords: new Map<Keyword, KeywordHandler>([
    ['ABOUT',     aboutHandler],
    ['SCOPE',     passthrough],
    ['APPLIES',   passthrough],
    ['TAGS',      tagsHandler],
    // The block name IS the role; ROLE is the block opener (a `ROLE <name>:`
    // header), never an identity attribute. EXPERTISE (0-1) is the only
    // identity attribute a role declares; an AGENT binds the role by name and
    // cannot redeclare it.
    ['ROLE',      headerHandler('roleCount')],
    ['EXPERTISE', counts('expertiseCount')],
    ['EXTENDS',   counts('extendsCount')],
    ['WHEN',      triggerHandler('WHEN', s => { s.hasRule = true; })],
    ...ROLE_RULE_KEYWORDS.map(kw => [kw, compose(accept, flags('hasRule'))] as const),
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
    ['ABOUT',   aboutHandler],
    ['SCOPE',    passthrough],
    ['APPLIES',  passthrough],
    ['TAGS',     tagsHandler],
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
// block. Its surface contract — required AS + MANDATE, forbidden EXPERTISE/TAGS,
// allowed ALWAYS/NEVER/MUST/WHEN — lives entirely in `BLOCK_CONTRACTS.AGENT` and
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
 *   - HARD error on any ROLE/EXPERTISE/TAGS child — define them in the role;
 *   - any child keyword outside the contract's `allows` is rejected.
 *
 * This is the single agent contract: a flat agent file IS its `EXPORT AGENT`
 * block, so `lintFile` routes every `.ap` here. There is no separate file-top
 * `agent.ap` spec.
 */
export function lintAgentBlocks(file: string, body: string): LintError[] {
  const errors: LintError[] = [];
  const contract = BLOCK_CONTRACTS.AGENT;
  // Role-owned children that get the "declare it in the role" hint — read from
  // the contract so `allows` and this set can never silently diverge.
  const forbidden = new Set<string>(contract.identityKeywords ?? []);

  for (const block of parseBlocks(body).blocks) {
    if (block.key !== 'AGENT') continue;

    // Header signature: `AS <role>` is required.
    if (!parseAgentSignature(block.rest).role) {
      errors.push({
        file, line: block.startLine,
        message: 'AGENT block requires an `AS <role>` binding on its header line',
      });
    }

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
        errors.push({
          file, line: child.line,
          message: `${child.keyword} is not allowed inside AGENT (expected one of: ${contract.allows.join(', ')})`,
        });
      }
    }

    // Cardinality is read from the contract — the single source of truth. `AS` is
    // the header signature (handled above), so it is excluded from the child-body
    // cardinality pass even though the contract lists it.
    for (const required of contract.requiresAll ?? []) {
      if (required === 'AS') continue;
      if ((childCounts.get(required) ?? 0) === 0) {
        errors.push({ file, line: block.startLine, message: `AGENT block requires a ${required}` });
      }
    }
    for (const u of contract.unique ?? []) {
      if (u === 'AS') continue;
      const count = childCounts.get(u) ?? 0;
      if (count > 1) {
        errors.push({
          file, line: block.startLine,
          message: `AGENT block has ${count} occurrences of ${u} (expected at most 1)`,
        });
      }
    }
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
  if (contract.allows.includes(keyword)) return true;
  const base = forceLevelBaseOf(keyword);
  return base !== null && contract.allows.includes(base as Keyword);
}

export function validateBlockContracts(
  tokens: ReturnType<typeof lex>,
  file: string,
  contracts: Record<string, BlockContract> = BLOCK_CONTRACTS,
): LintError[] {
  const errors: LintError[] = [];
  const stack: OpenBlock[] = [];

  const popClosedBlocks = (currentIndent: number) => {
    while (stack.length > 0 && currentIndent <= stack[stack.length - 1].indent) {
      finalizeBlock(stack.pop()!, contracts, errors, file);
    }
  };

  for (const t of tokens) {
    if (t.kind !== 'keyword') continue;
    popClosedBlocks(t.indent);

    const parent = stack[stack.length - 1];
    if (parent) {
      const c = contracts[parent.keyword];
      if (c && !isAllowedChild(c, t.keyword)) {
        errors.push({
          file,
          line: t.line,
          message: `${t.keyword} is not allowed inside ${parent.keyword} (expected one of: ${c.allows.join(', ')})`,
        });
      }
      parent.children.set(t.keyword, (parent.children.get(t.keyword) ?? 0) + 1);
    }

    if (contracts[t.keyword]) {
      stack.push({ keyword: t.keyword, line: t.line, indent: t.indent, children: new Map() });
    }
  }

  while (stack.length > 0) {
    finalizeBlock(stack.pop()!, contracts, errors, file);
  }
  return errors;
}

function finalizeBlock(
  block: OpenBlock,
  contracts: Record<string, BlockContract>,
  errors: LintError[],
  file: string,
): void {
  const c = contracts[block.keyword];
  if (!c) return;

  for (const required of c.requiresAll ?? []) {
    if (!block.children.has(required)) {
      errors.push({
        file,
        line: block.line,
        message: `${block.keyword} block requires at least one ${required}`,
      });
    }
  }

  if (c.requiresAnyOf && c.requiresAnyOf.length > 0) {
    const hasAny = c.requiresAnyOf.some(k => block.children.has(k));
    if (!hasAny) {
      errors.push({
        file,
        line: block.line,
        message: `${block.keyword} block requires at least one of: ${c.requiresAnyOf.join(', ')}`,
      });
    }
  }

  for (const u of c.unique ?? []) {
    const count = block.children.get(u) ?? 0;
    if (count > 1) {
      errors.push({
        file,
        line: block.line,
        message: `${block.keyword} block has ${count} occurrences of ${u} (expected at most 1)`,
      });
    }
  }
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
      const flowName = flowToken.rest.trim().split(/\s+/)[0] ?? '';
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

  for (const child of block.children) {
    if (child.type !== 'line') continue;
    counts.set(child.keyword, (counts.get(child.keyword) ?? 0) + 1);
    if (!(contract.allows as readonly string[]).includes(child.keyword)) {
      errors.push({
        file,
        line: child.line,
        message: `${child.keyword} is not allowed inside ${key} (expected one of: ${contract.allows.join(', ')})`,
      });
    }
  }
  for (const required of contract.requiresAll ?? []) {
    if (!counts.has(required)) {
      errors.push({ file, line: block.startLine, message: `${key} block requires at least one ${required}` });
    }
  }
  for (const u of contract.unique ?? []) {
    const count = counts.get(u) ?? 0;
    if (count > 1) {
      errors.push({ file, line: block.startLine, message: `${key} block has ${count} occurrences of ${u} (expected at most 1)` });
    }
  }
  return errors;
}

/**
 * Shared skeleton for the single-block kinds (STORE): exactly one block
 * of the kind, its name matching the filename slug, and its declared contract.
 */
function lintSingleBlockKind(
  file: string, body: string, key: string, options: LintOptions = {},
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

  errors.push(...checkBlockContract(file, block, key));
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const lintPolicy     = (file: string, body: string, options: LintOptions = {}) => runLint(POLICY_SPEC,     file, body, options);
export const lintPlaybook   = (file: string, body: string, options: LintOptions = {}) => runLint(PLAYBOOK_SPEC,   file, body, options);
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
 * (`flows.ap`) and roster (`team.ap`), a folder-per-agent body (`agent.ap`), an
 * import list (`imports.ap`), and a scope index (`index.ap`). Validated by
 * `lintAgentBlocks` like the original suffix dispatch did for any non-kind name.
 */
const ORCHESTRATION_BASENAMES = new Set(['flows.ap', 'team.ap', 'imports.ap', 'index.ap']);

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
 * agent; `flows.ap`/`team.ap` mark a team's orchestration; `.phase.ap`
 * are scaffold files. These must escape the dir-folder switch because a
 * built-in scaffold lives at `templates/agents/<name>/agent.ap`, whose ancestor build-output `templates/`
 * directory would otherwise be read as a kind-folder.
 */
function isAgentOrOrchestration(file: string, body: string): boolean {
  const base = file.split(/[/\\]/).pop() ?? '';
  if (ORCHESTRATION_BASENAMES.has(base)) return true;
  if (NON_KIND_SUFFIXES.some(s => base.endsWith(s))) return true;
  if (/^AS\s+\S/m.test(body)) return true;
  return parseBlocks(body).blocks.some(b => b.key.toUpperCase() === 'AGENT');
}

// ---------------------------------------------------------------------------
// Vocabulary — every line of every file speaks the language
// ---------------------------------------------------------------------------

/** Template regions whose lines are the author's literal text, never keywords. */
const VERBATIM_REGIONS = new Set(['SLOTS', 'BODY', 'EXAMPLE']);

/** A line that opens with a keyword-like word: `STPE`, `ON-AGENT-PROMPT`, `MEM!!!`. */
const KEYWORD_LIKE_RE = /^\s*(!*[A-Z][A-Z0-9-]+!*)(?=[\s:]|$)/;

/** The old DISTILL form: a suffix on a rule line or a procedure header. */
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
const SLOT_TYPES = ['TEXT', 'NUMBER', 'ENUM[a b]', '<template>', 'LIST <template>'];

/** A SLOTS line (`name[?]: TYPE … "description"`) whose TYPE is none of the language's. */
function slotTypeError(raw: string): string | null {
  const m = raw.trim().match(/^([a-z][\w-]*)\??\s*:\s*(.+)$/);
  if (!m) return null;
  const type = m[2].replace(/\s*".*$/, '').trim();
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
 * The language's own words, checked in every file whatever its kind: an unknown
 * keyword, an undeclared force level, an enum value outside its set, the old
 * DISTILL suffix, and DISTILL's place — alone, directly inside a PROCEDURE that
 * has an `AS` result, once. Template regions and RAW blocks are the author's text.
 */
export function checkVocabulary(file: string, body: string): LintError[] {
  const errors: LintError[] = [];
  const err = (line: number, message: string) => errors.push({ file, line, message });
  const tokens = lex(body);
  /** Enclosing lines, innermost last — a line's parent is the nearest shallower one. */
  const stack: { indent: number; key: string; line: number }[] = [];
  const distills = new Map<number, number[]>();   // procedure line → DISTILL lines
  const results = new Set<number>();                // procedure lines with an AS
  let region = -1;
  let regionKey = '';

  for (const t of tokens) {
    if (t.kind === 'blank' || t.kind === 'comment' || t.kind === 'rawLine') continue;
    if (region >= 0) {
      if (t.indent > region) {
        const typeError = regionKey === 'SLOTS' && 'raw' in t ? slotTypeError(t.raw) : null;
        if (typeError) err(t.line, typeError);
        continue;
      }
      region = -1;
    }
    while (stack.length && stack[stack.length - 1].indent >= t.indent) stack.pop();
    const parent = stack[stack.length - 1];

    let key = '';
    if (t.kind === 'blockOpener') {
      key = t.key === EXPORT_MODIFIER ? t.rest.split(/\s+/)[0] : t.key;
      if (VERBATIM_REGIONS.has(key)) { region = t.indent; regionKey = key; continue; }
      if (!blockTypeOf(key)) err(t.line, unknownKeyword(key));
    } else if (t.kind === 'keyword') {
      key = t.keyword as string;
      const base = forceLevelBaseOf(key);
      if (base && getIntroByKeyword(key) === null) err(t.line, unknownLevel(key, base));
      const prim = enumPrimitiveFor(key);
      const value = t.rest.trim().replace(/:$/, '');
      if (prim && value && !prim.values[value]) {
        err(t.line, `${key}: unknown value \`${value}\` (allowed: ${Object.keys(prim.values).join(', ')})`);
      }
      if (key === 'LASTS' && !(STORE_LIFETIMES as readonly string[]).includes(value)) {
        err(t.line, `LASTS: unknown value \`${value}\`${didYouMean(value, STORE_LIFETIMES)} (allowed: ${STORE_LIFETIMES.join(', ')})`);
      }
      if (DISTILL_SUFFIX_RE.test(t.rest.trim())) {
        err(t.line, 'DISTILL is no longer a suffix — write it alone on its own line inside the PROCEDURE');
      }
      if (base === 'DISTILL') {
        if (t.rest.trim()) err(t.line, `${key} takes no text — write it alone on its line`);
        if (parent?.key !== 'PROCEDURE') {
          err(t.line, `${key} goes directly inside a PROCEDURE${parent ? ` — found inside ${parent.key}` : ''}`);
        } else {
          distills.set(parent.line, [...(distills.get(parent.line) ?? []), t.line]);
        }
      }
      if (base === 'AS' && parent?.key === 'PROCEDURE') results.add(parent.line);
    } else if (t.kind === 'unknown') {
      const word = t.raw.match(KEYWORD_LIKE_RE)?.[1];
      if (word) {
        const base = forceLevelBaseOf(word);
        err(t.line, base ? unknownLevel(word, base) : unknownKeyword(word));
      }
    }
    stack.push({ indent: t.indent, key, line: t.line });
  }

  for (const [procedure, lines] of distills) {
    if (lines.length > 1) err(lines[1], `a PROCEDURE takes one DISTILL line — found ${lines.length} (lines ${lines.join(', ')})`);
    if (!results.has(procedure)) err(procedure, 'a PROCEDURE with DISTILL needs its result contract — add AS <template>');
  }
  return errors;
}

export function lintFile(file: string, body: string, options: LintOptions = {}): LintError[] {
  return [...checkVocabulary(file, body), ...lintByKind(file, body, options)];
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
  if (isAgentOrOrchestration(file, body)) return lintAgentBlocks(file, body);

  // Otherwise the lint dispatch is dir-authoritative: the kind-folder a file
  // lives under names the linter, never a suffix and never a block. A loose
  // `policies/x.ap` holding only ALWAYS/NEVER lines is still a policy.
  // `kindFromDir` derives this from the one kind registry.
  switch (kindFromDir(file)) {
    case 'policy':    return lintPolicy(file, body, options);
    case 'playbook':  return lintPlaybook(file, body, options);
    case 'procedure': return lintProcedure(file, body, options);
    case 'role':      return lintRole(file, body, options);
    case 'template':  return lintTemplate(file, body, options);
    case 'flow':      return lintFlow(file, body, options);
    case 'store':     return lintStore(file, body, options);
  }
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
    return `${tag}  ${e.file}:${e.line}  ${e.message}`;
  }).join('\n');
}
