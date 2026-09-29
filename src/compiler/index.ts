// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, existsSync } from 'fs';
import { FORMULAS, fill, introOf } from '../formulas.js';
import { resolve, join, dirname, basename } from 'path';
import { unitNameFromPath } from '../ingest.js';
import { Config, BundleConfig, LintConfig, libraryRoots as libraryRootsOf, librariesAliasMap } from '../config.js';
import { BundleContext, RoleEntry } from '../dispatch/index.js';
import { processImports, resolveTargetWith } from '../dispatch/imports.js';
import { resolveBundleDefaults, resolveTeamShared } from '../bundleDefaults.js';
import { resolveTeamMembership } from '../services/teamMembership.js';
import { allAgentFiles, allUserAgentFiles, readAgentFile, standaloneDir, agentNameOf, teamRootForAgentFile, TEAM_FLOWS_FILE } from '../services/teamMetadata.js';
import { formatErrors, LintError, checkVocabulary, lineOfName } from '../lint.js';
import { extractInlineDefinitions } from '../dispatch/inlineBlocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { renderEnumLegend } from '../enumPrimitives.js';
import { partitionMetadata, mergeMetadata, protectVerbatim } from '../services/text.js';
import { lex } from '../lexer.js';
import { OwnsPrimitive, WhenPrimitive, applyBodySubstitutions, stripHeaderKeyword, injectNeutralIfUnclaimed, AGENT_METADATA_KEYWORDS } from '../primitives.js';
import { resolveShapeRefs } from '../shapeCompiler.js';
import { AdapterPlugin, PlaybookBundle } from '../../adapters/types.js';
import { renderMd } from '../../adapters/md/index.js';
import { emitChapter } from '../bundlers/sections.js';
import { STRATEGIES, strategyFor, type DefinitionStrategy, type Definition } from '../definition.js';
import { parseNamespace } from '../namespace.js';
import { DocumentBuilder } from '../apdoc/builder.js';
import type { ApDocument } from '../apdoc/document.js';
import type { StoreBlock } from '../apdoc/blocks.js';


// --- Public interfaces ---

export interface BundleOptions {
  agentName: string;
  /** The agent's `.ap` file (holding its `EXPORT AGENT` block). */
  agentFile: string;
  agentDir: string;
  libraryRoot: string;
  libraryRoots?: string[];
  libraries?: Record<string, string>;
  bundleConfig?: BundleConfig;
  lintConfig?: LintConfig;
  projectRoot?: string;
  vars?: Record<string, string>;
  /** Adapter selected for the bundle. */
  adapter?: AdapterPlugin;
}

/**
 * Resolve an agent name to its `.ap` file: the file whose `EXPORT AGENT <name>`
 * block matches. Precedence mirrors the config cascade: project shadows global
 * (user home).
 */
export function resolveAgentFile(agentName: string, config: Config): string {
  // Flat agent: the file whose `EXPORT AGENT <name>` block name matches, over the
  // shared discovery dir set (standalone + team roots). Precedence mirrors the
  // config cascade: project shadows global (user home).
  for (const file of [
    ...allAgentFiles(config.agentsDir, config.teamsDir),
    ...allUserAgentFiles(config.userRoot),
  ]) {
    if (agentNameOf(file) === agentName) return file;
  }
  // Fallback: a conventional standalone path so the bundler reports a precise
  // "Agent not found" against the expected flat location.
  return resolve(standaloneDir(config.agentsDir), `${agentName}.ap`);
}

/** The directory that hosts an agent's co-located accessories (vars.ap): its file's parent. */
export function resolveAgentDir(agentName: string, config: Config): string {
  return dirname(resolveAgentFile(agentName, config));
}


/** Subset of BundleOptions that callers typically vary; the rest is derived from Config. */
export interface BundleFromConfigOverrides {
  bundleConfig?: BundleConfig;
  lintConfig?: LintConfig;
  projectRoot?: string;
  vars?: Record<string, string>;
  adapter?: AdapterPlugin;
}

/**
 * Compose a bundle from a Config, deriving libraryRoot and agentDir from it.
 * Overrides win when provided.
 */
export async function bundleAgentFromConfig(
  agentName: string,
  config: Config,
  overrides: BundleFromConfigOverrides = {},
): Promise<string> {
  return bundleAgentToString(buildBundleOpts(agentName, config, overrides));
}

/**
 * Same as bundleAgentFromConfig but returns the full bundle object
 * (body + metadata). Used by builders that need access to bundle metadata.
 */
export async function bundleAgentObjectFromConfig(
  agentName: string,
  config: Config,
  overrides: BundleFromConfigOverrides = {},
): Promise<{ body: string; metadata: Map<string, string[]>; structure?: ApDocument }> {
  return bundleAgentObject(buildBundleOpts(agentName, config, overrides));
}

function buildBundleOpts(
  agentName: string,
  config: Config,
  overrides: BundleFromConfigOverrides,
): BundleOptions {
  const agentFile = resolveAgentFile(agentName, config);
  return {
    agentName,
    agentFile,
    agentDir: dirname(agentFile),
    libraryRoot: config.libraryRoot,
    libraryRoots: libraryRootsOf(config),
    libraries: librariesAliasMap(config),
    bundleConfig: overrides.bundleConfig,
    lintConfig: overrides.lintConfig,
    projectRoot: overrides.projectRoot,
    vars: overrides.vars,
    adapter: overrides.adapter,
  };
}

/** A name that resolves to no block fails the compilation (D30): what is missing, and how to bring it in. */
function unresolvedErrors(unresolved: { path: string; name: string; kind: string }[]): LintError[] {
  return unresolved.map(u => ({
    file: u.path,
    line: lineOfName(u.path, u.name),
    message: u.kind === 'agent'
      ? `unknown agent \`${u.name}\` — BY names a member of this team`
      : `unknown ${u.kind} \`${u.name}\` — define it, or IMPORT it FROM @<lib>.${u.kind}s`,
  }));
}

// Shared bundle pipeline helpers used by both agent bundle and playbook bundle.

export interface MakeContextOpts {
  agentName: string;
  libraryRoot: string;
  libraryRoots: string[];
  libraries?: Record<string, string>;
  lintOptions?: LintConfig;
  renderings?: Record<string, Record<string, string>>;
}

export function makeBundleContext(opts: MakeContextOpts): BundleContext {
  return {
    agentName: opts.agentName,
    libraryRoot: opts.libraryRoot,
    libraryRoots: opts.libraryRoots,
    libraries: opts.libraries,
    tools: [],
    policies: [],
    roles: [],
    templates: [],
    procedures: [],
    flows: [],
    stores: [],
    lintErrors: [],
    lintOptions: opts.lintOptions,
    renderings: opts.renderings,
    importedPaths: new Set<string>(),
  };
}

export async function expandImports(content: string, ctx: BundleContext, sourcePath?: string): Promise<string> {
  return processImports(content, ctx, sourcePath);
}

/**
 * Canonical source-body resolution: expand `IMPORT`s, then hoist inline
 * `<KIND> <name>:` blocks into `ctx` so `emitCollectedSections` renders them.
 * Single source of truth shared by every bundle path (agent, playbook,
 * standalone, orchestration) so a FLOW/PROCEDURE/TEMPLATE resolves identically
 * regardless of which file declares it.
 */
export async function resolveInlineBlocks(
  stripped: string,
  ctx: BundleContext,
  sourcePath: string,
): Promise<string> {
  return extractInlineDefinitions(await expandImports(stripped, ctx, sourcePath), ctx, sourcePath);
}

/**
 * Resolve the agent's `AS <role>` binding into its `# Identity` block.
 *
 * The agent declares only `AS <role>`; the bound role (inline or imported,
 * already collected into `ctx.roles`) owns the display name (the de-slugified
 * block name), its ABOUT, optional EXPERTISE, and its behaviours. Copy the
 * display name, ABOUT and EXPERTISE into the agent's identity metadata so
 * `renderIdentityBlock` renders a complete identity, and hand back the bound
 * role so the caller can merge its behaviours and exclude it from the Roles
 * chapter. The agent's own MANDATE is untouched. A binding with no matching
 * role contributes no identity and returns null.
 *
 * Mutates `metadata` in place: sets ROLE / ROLE-ABOUT / EXPERTISE from the bound
 * role.
 */
function bindRoleIdentity(metadata: Map<string, string[]>, ctx: BundleContext): RoleEntry | null {
  const binding = metadata.get('AS')?.[0]?.trim();
  if (!binding) return null;
  const role = ctx.roles.find(r => r.name === binding);
  if (!role) return null;
  if (role.role) metadata.set('ROLE', [role.role]);
  if (role.about) metadata.set('ROLE-ABOUT', [role.about]);
  if (role.expertise) metadata.set('EXPERTISE', [role.expertise]);
  return role;
}


/**
 * Every `{{name}}` the agent reads — its own file and every block it imports —
 * names a declared VAR, or the compilation fails where it is written.
 */
function checkVars(ctx: BundleContext, agentFilePath: string, vars: Record<string, string>): void {
  const kinds = [ctx.policies, ctx.roles, ctx.templates, ctx.procedures, ctx.flows, ctx.stores] as { path: string }[][];
  const files = new Set([agentFilePath, ...kinds.flat().map(d => d.path)]);
  for (const file of files) {
    if (!existsSync(file)) continue;
    readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
      for (const [, name] of line.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!(name in vars)) ctx.lintErrors.push({ file, line: i + 1, message: `unknown variable \`{{${name}}}\` — declare it with \`VAR ${name} = …\` in vars.ap` });
      }
    });
  }
}

/** A store its type cannot hold — an unknown TYPE, a slot the backing refuses — fails the compilation. */
function storeErrors(doc: ApDocument, ctx: BundleContext, agentFilePath: string): LintError[] {
  return (doc.byKind('store') as StoreBlock[]).flatMap(store => {
    const file = ctx.stores.find(s => s.name === store.name)?.path ?? agentFilePath;
    const p = store.projection();
    if (p.unknownType) {
      return [{ file, line: lineOfName(file, store.storeType), message: `STORE ${store.name}: unknown TYPE \`${store.storeType}\` (available: ${p.unknownType.available.join(', ')})` }];
    }
    const key = store.storeKey && !store.slots.some(sl => sl.name === store.storeKey)
      ? [{ file, line: lineOfName(file, store.storeKey), message: `STORE ${store.name}: KEY \`${store.storeKey}\` is none of its slots (${store.slots.map(sl => sl.name).join(', ')})` }]
      : [];
    return [...key, ...Object.entries(p.rejects).map(([slot, why]) => ({ file, line: lineOfName(file, slot), message: `STORE ${store.name}: ${why}` }))];
  });
}

/** Check the words of a source the pipeline reads itself (not through an IMPORT), into `ctx`. */
export function lintSource(path: string, ctx: BundleContext): void {
  if (existsSync(path)) ctx.lintErrors.push(...checkVocabulary(path, readFileSync(path, 'utf-8')));
}

/** Lint check shared by every bundle entry point. Throws on errors, logs warnings. */
export function reportLintIssues(ctx: BundleContext, label: string): void {
  const warnings = ctx.lintErrors.filter(e => e.severity === 'warning');
  if (warnings.length > 0) console.error(formatErrors(warnings));
  failOnErrors(ctx.lintErrors.filter(e => e.severity !== 'warning'), label);
}

function failOnErrors(errors: LintError[], label: string): void {
  if (errors.length > 0) {
    throw new Error(`${label} failed: ${errors.length} lint error(s):\n${formatErrors(errors)}`);
  }
}

/** Collapse runs of 3+ blank lines (residue of import expansion) and trim. */
function tidyBlankLines(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/** Apply post-process passes that run on the final composed body. */
export function postProcessBody(
  body: string,
  ctx: BundleContext,
  vars?: Record<string, string>,
): string {
  return protectVerbatim(body.trimEnd() + '\n', masked => {
    let result = applyBodySubstitutions(masked, {
      vars,
      templates: ctx.templates,
    });
    // Resolve typed-shape `@shape(slug)` refs to `(id)`, now every shape is
    // emitted. Mirrors the AS resolver; throws on a miss.
    result = resolveShapeRefs(result, { templates: ctx.templates });
    return renderTree(result, ctx);
  });
}

/** Render the agent-only Tools section. */
async function emitTools(ctx: BundleContext): Promise<string> {
  const resolved = ctx.tools.map(tool => ({ name: tool.name, body: tool.body.trim() }));
  return emitChapter(ctx, {
    title: FORMULAS.blocks.tool.chapter,
    intro: introOf('tool'),
    entries: resolved,
    renderEntry: t => ({ heading: fill(FORMULAS.blocks.tool.heading, { name: t.name }), body: t.body }),
  });
}

/**
 * Render a definition body. Dispatches to the strategy's `renderBody` hook; a
 * null result (no bespoke shape — e.g. prose templates) falls back to the
 * generic verbatim body, header keyword stripped when the kind declares one.
 */
function renderShapeBody(s: DefinitionStrategy, e: Definition, ctx: BundleContext): string {
  const rendered = s.renderBody?.(e, ctx);
  if (rendered != null) return rendered;
  return s.headerKeyword ? stripHeaderKeyword(e.body, s.headerKeyword, e.name) : e.body;
}

function buildChapterFromStrategy(s: DefinitionStrategy, ctx: BundleContext) {
  const entries = s.getEntries(ctx);
  // A strategy that declares `legendEnum` gets the enum's mode legend appended
  // to its intro — adapter-native renderings when the bundle has an adapter.
  const legend = s.legendEnum ? renderEnumLegend(s.legendEnum, ctx) : '';
  return {
    title: s.sectionTitle,
    intro: [introOf(s.kind), legend].filter(Boolean).join('\n\n'),
    entries,
    renderEntry: (e: Definition) => ({
      heading: s.formatHeading(e.name),
      prelude: e.about,
      body: renderShapeBody(s, e, ctx),
    }),
    afterEmit: s.afterEmit,
  };
}

export function emitCollectedSections(ctx: BundleContext): string {
  let out = '';

  // Strategy-driven sections in declaration order (role → template → procedure → flow).
  for (const s of STRATEGIES) {
    out += emitChapter(ctx, buildChapterFromStrategy(s, ctx));
  }

  return out;
}

interface PlaybookHeader {
  metadata: Map<string, string[]>;
  stripped: string;  // body without ABOUT / WHEN — ready for expandImports
}

/**
 * Single-pass extraction for playbook sources: ABOUT, all WHEN triggers,
 * and a stripped body produced from the same token stream. Replaces the prior
 * `parsePlaybookHeader + stripPrimitives` double-lex.
 *
 * TAGS / APPLIES are file-level metadata like ABOUT — consumed into the map so
 * they never leak into the rendered skill body.
 */
function parsePlaybookHeader(raw: string): PlaybookHeader {
  const HEADER_KEYWORDS = new Set(['ABOUT', 'WHEN', 'TAGS', 'APPLIES']);
  const metadata = new Map<string, string[]>();
  const out: string[] = [];

  for (const t of lex(raw)) {
    if (t.kind === 'comment') continue;
    if (t.kind === 'keyword' && t.indent === 0 && HEADER_KEYWORDS.has(t.keyword)) {
      if (t.rest) {
        const arr = metadata.get(t.keyword) ?? [];
        // WHEN accumulates; the others: first wins.
        if (t.keyword !== 'WHEN' && arr.length > 0) continue;
        arr.push(t.rest);
        metadata.set(t.keyword, arr);
      }
      continue;
    }
    out.push(t.kind === 'blank' ? '' : ('raw' in t ? t.raw : ''));
  }
  return { metadata, stripped: out.join('\n').replace(/^\n+/, '') };
}

/**
 * Bundle a single playbook file as a standalone PlaybookBundle.
 * Uses the same pipeline (makeBundleContext + expandImports + emitCollectedSections)
 * as bundleAgentObject.
 */
export async function buildPlaybookBundle(
  path: string,
  config: Config,
  opts: {
    extraLibraryRoots?: string[];
    extraLibraries?: Record<string, string>;
    adapter?: AdapterPlugin;
  } = {},
): Promise<PlaybookBundle> {
  const absolute = resolve(path);
  const raw = readFileSync(absolute, 'utf-8');
  const fileName = unitNameFromPath(absolute);
  const header = parsePlaybookHeader(raw);
  const name = fileName;
  const whens = header.metadata.get('WHEN') ?? [];

  const ctx = makeBundleContext({
    agentName: name,
    libraryRoot: config.libraryRoot,
    libraryRoots: [...libraryRootsOf(config), ...(opts.extraLibraryRoots ?? [])],
    libraries: { ...librariesAliasMap(config), ...(opts.extraLibraries ?? {}) },
    renderings: opts.adapter?.renderings,
  });

  let body = await resolveInlineBlocks(header.stripped, ctx, absolute);
  // Order: declarations first (Templates / Procedures) so every
  // reference inside the steps is already defined when the LLM reads it,
  // entry-point body last.
  body = `${emitCollectedSections(ctx)}# Steps for ${name}\n\n${tidyBlankLines(body)}\n`;
  body = injectNeutralIfUnclaimed(body, WhenPrimitive, whens, opts.adapter?.name ?? '');

  reportLintIssues(ctx, 'Playbook bundle');

  return Object.assign(new PlaybookBundle(), {
    metadata: header.metadata,
    name,
    body: postProcessBody(body, ctx),
    sourcePath: absolute,
  });
}

/**
 * Pure compilation: resolves all directives and returns the compiled context as a string.
 * No file I/O for output — the caller decides what to do with the result.
 */
export async function bundleAgentToString(opts: BundleOptions): Promise<string> {
  return (await bundleAgentObject(opts)).body;
}

/**
 * Compile a standalone .ap file (no playbook scaffolding, no agent metadata)
 * through the same pipeline used by agents and playbooks: imports, force
 * levels, vars, and the collected primitives (Templates/Procedures).
 * Strips H1 and ABOUT from the source. Used by PROJECT.ap and any other
 * top-level standalone file that compiles to plain markdown.
 */
export async function bundleStandaloneToString(
  path: string,
  config: Config,
  opts: { extraLibraryRoots?: string[]; extraLibraries?: Record<string, string>; adapter?: AdapterPlugin } = {},
): Promise<string> {
  const absolute = resolve(path);
  const raw = readFileSync(absolute, 'utf-8');
  const fileName = unitNameFromPath(absolute);
  const header = parsePlaybookHeader(raw);
  const name = fileName;

  const ctx = makeBundleContext({
    agentName: name,
    libraryRoot: config.libraryRoot,
    libraryRoots: [...libraryRootsOf(config), ...(opts.extraLibraryRoots ?? [])],
    libraries: { ...librariesAliasMap(config), ...(opts.extraLibraries ?? {}) },
    renderings: opts.adapter?.renderings,
  });
  lintSource(absolute, ctx);

  let body = await resolveInlineBlocks(header.stripped, ctx, absolute);
  body = `${emitCollectedSections(ctx)}${tidyBlankLines(body)}\n`;

  reportLintIssues(ctx, `Standalone bundle (${basename(absolute)})`);

  return postProcessBody(body, ctx);
}

/**
 * Same as bundleAgentToString but exposes bundle metadata alongside the body.
 */
export async function bundleAgentObject(opts: BundleOptions): Promise<{
  body: string;
  metadata: Map<string, string[]>;
  structure?: ApDocument;
}> {
  const { agentName, libraryRoot } = opts;
  const libraryRoots = opts.libraryRoots ?? [libraryRoot];

  const agentFilePath = opts.agentFile;
  if (!existsSync(agentFilePath)) {
    throw new Error(`Agent not found: ${agentFilePath}`);
  }

  const ctx = makeBundleContext({
    agentName, libraryRoot, libraryRoots,
    libraries: opts.libraries,
    lintOptions: opts.lintConfig,
    renderings: opts.adapter?.renderings,
  });
  // The document builder — walks the resolved sources directly (no events)
  // and assembles the ApDocument in `finish()` below.
  const builder = new DocumentBuilder();

  // Bootstrap: the per-member team-membership section (who this agent is within
  // its team — foundational context, so first), then the team's shared block
  // (team.ap, when the agent is a team member), then the framework runtime
  // defaults. All are prepended before the agent's own identity and rules.
  // Team root is resolved from the agent's flat file (its sibling flows.ap).
  const bootstrap =
    resolveTeamMembership(agentFilePath) +
    resolveTeamShared(agentFilePath) +
    resolveBundleDefaults(opts.bundleConfig ?? {});

  // The agent file is split into its `EXPORT AGENT` and sibling `EXPORT ROLE`
  // blocks and re-composed as ONE unit — imports prologue, then the inline
  // `ROLE <name>:` block, then the agent body. partitionMetadata does extract +
  // strip in a single lex pass; the adapter later obtains frontmatter via
  // collectFrontmatter(metadata, …).
  // The words of the agent's own file and of its team's flows.ap are checked
  // like every import's.
  lintSource(agentFilePath, ctx);
  const teamRoot = teamRootForAgentFile(agentFilePath);
  const flowsPath = teamRoot ? resolve(teamRoot, TEAM_FLOWS_FILE) : null;
  if (flowsPath && existsSync(flowsPath)) {
    lintSource(flowsPath, ctx);
    // The team's flows travel in every member's document; so do the blocks
    // flows.ap imports (a step's AS template), or their ids would lead nowhere.
    const imports = readFileSync(flowsPath, 'utf-8').split(/\r?\n/).filter(l => /^IMPORT\s/.test(l)).join('\n');
    if (imports) await expandImports(imports, ctx, flowsPath);
  }

  const metadata = new Map<string, string[]>();
  const { metadata: fileMeta, stripped } = partitionMetadata(readAgentFile(agentFilePath).unitSource, AGENT_METADATA_KEYWORDS);
  mergeMetadata(metadata, fileMeta);
  // Symmetric to resolveFile: inline `<KIND> <name>:` blocks (the agent's
  // sibling ROLE) end up in the same ctx collections that imported files
  // target. Downstream rendering is identical.
  const agentBody = `${await resolveInlineBlocks(stripped, ctx, agentFilePath)}\n\n`;
  checkVars(ctx, agentFilePath, opts.vars ?? {});

  // Role binding: `AS <role>` resolves the bound role's display name / ABOUT /
  // EXPERTISE into the identity metadata (the agent itself may not declare them —
  // lint forbids it; they live in the role). MANDATE stays the agent's own. The
  // bound role is also returned so its behaviours fuse into the Identity block
  // and it is excluded from the Roles chapter — the role IS the agent here, not a
  // separate cognitive layer.
  const boundRole = bindRoleIdentity(metadata, ctx);
  if (boundRole) {
    ctx.roles = ctx.roles.filter(r => r !== boundRole);
  }

  // An `AS <role>` naming no role is a broken reference like any other.
  const binding = metadata.get('AS')?.[0]?.trim();
  if (binding && !boundRole) {
    ctx.lintErrors.push({ file: agentFilePath, line: lineOfName(agentFilePath, binding), message: `unknown role \`${binding}\` — define it, or IMPORT it FROM @<lib>.roles` });
  }
  reportLintIssues(ctx, 'Bundle');

  const ownsValues = metadata.get('OWNS') ?? [];
  const ownsInBody = ownsValues.length > 0 &&
    OwnsPrimitive.contributesFrontmatter(opts.adapter?.name ?? '', ownsValues) === null;

  const structure = builder.finish(ctx, {
    metadata,
    boundRole,
    agentBody,
    agentFilePath,
    bootstrap,
    vars: opts.vars ?? {},
    ownsInBody,
  });
  failOnErrors([...unresolvedErrors(builder.unresolved), ...storeErrors(structure, ctx, agentFilePath)], 'Bundle');
  const body = renderMd(structure) + await emitTools(ctx);

  return {
    body,
    metadata,
    structure,
  };
}
