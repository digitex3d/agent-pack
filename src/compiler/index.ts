// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { plugins } from '../plugins.js';
import { existsSync, readFileSync } from 'node:fs';
import { FORMULAS, fill, introOf } from '../formulas.js';
import { resolve, dirname, basename, sep } from 'node:path';
import { unitNameFromPath } from '../ingest.js';
import type { MainFile } from '../services/mainMetadata.js';
import { projectAgentFiles } from '../agentDiscovery.js';
import { type Config, type BundleConfig, type LintConfig, libraryRoots as libraryRootsOf, librariesAliasMap } from '../config.js';
import type { BundleContext, RoleEntry } from '../dispatch/index.js';
import { parseAgentSignature } from '../definitionArgs.js';
import { processImports, SKILL_IMPORT_HINT } from '../dispatch/imports.js';
import { unappliedBlocks, unappliedIssue, withScopeLine } from '../withUse.js';
import { readDecorator } from '../decoratorUse.js';
import { resolveBundleDefaults, resolveTeamShared } from '../bundleDefaults.js';
import { resolveTeamMembership } from '../services/teamMembership.js';
import { findAgentFiles, readAgentFile, standaloneDir, agentNameOf, teamRootForAgentFile, readTeamFile, teamRosterIssues, teamNamesUnder, teamFileOf, isTeamFile, outsideBlock } from '../services/teamMetadata.js';
import { isMainFile, readMainFile } from '../services/mainMetadata.js';
import { apxCommand } from '../apx/paths.js';
import { harnessesOf, harnessProblem, agentModels, modelProblem, type HarnessRow } from '../harnesses.js';
import { delegateTargetErrors, executorErrors, usesPrograms, WRITE_PROGRAM, type AgentIndexEntry } from '../executor.js';
import { BUILTIN_AGENTS_DIR, resolveDelegateConfig, type DelegateConfig } from '../config.js';
import { type LintError, checkVocabulary, lineOfName, checkedHeadIssues, dimensionBlockErrors, domainBlockErrors, pluginBlockErrors, teamFileErrors, mainBlockErrors } from '../lint.js';
import { CompileError, reporter } from '../report.js';
import { extractInlineDefinitions } from '../dispatch/inlineBlocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { renderEnumLegend } from '../enumPrimitives.js';
import { partitionMetadata, mergeMetadata, protectVerbatim } from '../services/text.js';
import { lex, opensBlock } from '../lexer.js';
import { applyBodySubstitutions, stripHeaderKeyword, AGENT_METADATA_KEYWORDS, renderGlobs } from '../primitives.js';
import { resolveShapeRefs } from '../shapeCompiler.js';
import type { AdapterPlugin } from '../../adapters/types.js';
import { renderMd } from '../../adapters/md/index.js';
import { emitChapter } from '../bundlers/sections.js';
import { STRATEGIES, type DefinitionStrategy, type Definition } from '../definition.js';
import { DocumentBuilder } from '../apdoc/builder.js';
import type { ApDocument } from '../apdoc/document.js';
import type { StoreBlock, DimensionBlock, DomainBlock } from '../apdoc/blocks.js';
import { hasProjectFile } from '../services/fs.js';
import { matchesAnyGlob } from '../services/glob.js';
import { DECORATOR_MARK, WITHIN_DECORATOR } from '../decorators.js';
import { SourceRegistry } from '../sources.js';
import { AGENT_KEYS } from '../blockTypes.js';
import { splitList } from '../lists.js';
import { judgeDocument, type JudgeRun } from '../judge/phase.js';
import { judgeDomainFormulas } from '../judge/domains.js';
import type { ChecksConfig } from '../judge/types.js';
import { importedVariables, visibleIn } from '../exportedVars.js';
import { readsOf, constantOf, parseVarLine, splitInto, takesInto, eachHeadOf } from '../vars.js';
import { refName } from '../../adapters/md/phrases.js';
import { STORE_FIELD_RE } from '../storeDrivers/filters.js';
import { storeDriverOf } from '../storeDrivers/registry.js';


// --- Public interfaces ---

export interface BundleOptions {
  agentName: string;
  /** The agent's `.ap` file (holding its `EXPORT AGENT` block) — or a team's, or the main's: the unit's document. */
  agentFile: string;
  /** Where an agent of the project is written, by its name — what the main's MEMBER lines name. */
  agentFileOf?: (name: string) => string;
  agentDir: string;
  libraryRoot: string;
  libraryRoots?: string[];
  libraries?: Record<string, string>;
  bundleConfig?: BundleConfig;
  lintConfig?: LintConfig;
  projectRoot?: string;
  /** Constants known before the imports are read (the implicit `name`); an imported one overrides them. */
  vars?: Record<string, string>;
  /** Adapter selected for the bundle. */
  adapter?: AdapterPlugin;
  /** The source registry to read through — a fresh one per compilation when absent. */
  sources?: SourceRegistry;
  /** The command's judge run — the judge phase runs when present. */
  judge?: JudgeRun | null;
  /** The judge of checked conditions (`checks` config key) — absent: none. */
  checks?: ChecksConfig | null;
  /** Every agent of the project and its team — what `DELEGATE … BY` may name. Absent: not checked. */
  agentIndex?: AgentIndexEntry[];
  /** The harnesses installed, enabled and delegable (src/harnesses.ts) — what `BY <harness>:<agent>` depends on (D66). Absent: none. */
  harnesses?: HarnessRow[];
  /** The project's teams, by name — what a flow's `BY <team>` resolves against. Absent: not known. */
  teams?: readonly string[];
  /** The `delegate` config key: the default delegate and the agents' models. */
  delegate?: DelegateConfig;
}

/** The agents shipped inside the package (`templates/agents/`) — found after the project's and the user's. */
function builtinAgentFiles(): string[] {
  return existsSync(BUILTIN_AGENTS_DIR) ? findAgentFiles(BUILTIN_AGENTS_DIR) : [];
}

/** Every agent file: the project's (its agents, the global ones, its skills), then the built-ins. */
function agentFiles(config: Config): string[] {
  return [...projectAgentFiles(config), ...builtinAgentFiles()];
}

/** Every agent of the project (the global ones after it), the team it belongs to and its `BUDGET` tier. */
function agentIndexOf(config: Config): AgentIndexEntry[] {
  return agentFiles(config).map(file => {
    const teamRoot = teamRootForAgentFile(file);
    const team = teamRoot ? basename(teamRoot) : null;
    try {
      const { info } = readAgentFile(file);
      return { name: info.name, team, ...(info.budget ? { budget: info.budget } : {}) };
    } catch {
      return { name: agentNameOf(file), team };
    }
  });
}

/**
 * Resolve an agent name to its `.ap` file: the file whose `EXPORT AGENT <name>`
 * block matches — or `EXPORT SKILL <name>`, a skill being an agent the library
 * holds. Precedence mirrors the config cascade: project shadows global
 * (user home).
 */
export function resolveAgentFile(agentName: string, config: Config): string {
  // Flat agent: the file whose `EXPORT AGENT <name>` block name matches, over the
  // shared discovery dir set (standalone + team roots). Precedence mirrors the
  // config cascade: project shadows global (user home).
  for (const file of agentFiles(config)) {
    if (agentNameOf(file) === agentName) return file;
  }
  // A team: its file — the same compiler makes its document, rooted at its TEAM block; the main, at its MAIN block.
  const team = teamFileOf(resolve(config.teamsDir, agentName));
  if (team && readTeamFile(dirname(team))?.name === agentName) return team;
  const main = readMainFile(process.cwd());
  if (main?.name === agentName) return main.path;
  // Fallback: a conventional standalone path so the bundler reports a precise
  // "Agent not found" against the expected flat location.
  return resolve(standaloneDir(config.agentsDir), `${agentName}.ap`);
}



/** Subset of BundleOptions that callers typically vary; the rest is derived from Config. */
export interface BundleFromConfigOverrides {
  bundleConfig?: BundleConfig;
  lintConfig?: LintConfig;
  projectRoot?: string;
  vars?: Record<string, string>;
  adapter?: AdapterPlugin;
  judge?: JudgeRun | null;
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
): Promise<{ body: string; metadata: Map<string, string[]>; structure?: ApDocument; skill: boolean; agentFile: string }> {
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
    judge: overrides.judge,
    checks: config.checks ?? null,
    agentIndex: agentIndexOf(config),
    harnesses: harnessesOf(config.adapters),
    teams: teamNamesUnder(config.teamsDir),
    agentFileOf: name => resolveAgentFile(name, config),
    ...(config.delegate ? { delegate: config.delegate } : {}),
  };
}

/** A name that resolves to no block fails the compilation (D30): what is missing, and how to bring it in. */
function unresolvedErrors(unresolved: { path: string; name: string; kind: string }[]): LintError[] {
  return unresolved.map(u => ({ file: u.path, line: lineOfName(u.path, u.name), message: unresolvedMessage(u.kind, u.name) }));
}

/**
 * The policies and skills the compilation imports — and an agent's dimensions —
 * that hold nowhere: no perimeter on their APPLIES line and no positive WITH
 * naming them. An error for a policy or a skill, so a rule never sits silently
 * unused; a warning for a dimension, served by the apx all the same
 * (src/withUse.ts). A dimension of a compilation that is no agent's is
 * strayDimensionErrors's: never reported twice.
 */
function unappliedErrors(ctx: BundleContext, named: ReadonlySet<string>, dimensions = false): LintError[] {
  const blocks = [...ctx.policies, ...ctx.skills, ...(dimensions ? ctx.dimensions : [])];
  return unappliedBlocks(blocks, named).map(b => ({ file: b.path, line: lineOfName(b.path, b.name), ...unappliedIssue(b) }));
}

/**
 * The decorators of a standalone file, which has no document builder: every
 * one of the file and of the blocks it brings in, read once (src/decoratorUse.ts)
 * — what does not hold, where it is written, and the blocks they name.
 */
function standaloneDecoratorErrors(ctx: BundleContext, file: string, body: string): LintError[] {
  const blocks = [ctx.roles, ctx.procedures, ctx.flows, ctx.policies, ctx.skills].flat();
  const named = new Set<string>();
  const errors: LintError[] = [];
  // A definition's decorators stand above its body: read with it.
  const above = (d: Definition) => (ctx.sources.span(d.path, d.kind, d.name)?.decorators ?? []).map(x => `${DECORATOR_MARK}${x.key} ${x.rest}`);
  for (const { path, text } of [{ path: file, text: body }, ...blocks.map(d => ({ path: d.path, text: [...above(d), d.body].join('\n') }))]) {
    for (const t of lex(text)) {
      const read = readDecorator(t, ctx);
      if (!read) continue;
      for (const d of read.uses) named.add(d.name);
      const line = path === file && 'line' in t ? t.line : lineOfText(path, 'raw' in t ? t.raw : '');
      errors.push(...read.problems.map(message => ({ file: path, line, message })));
    }
  }
  return [...errors, ...unappliedErrors(ctx, named)];
}

/** The 1-based line of `path` that holds `text`, trimmed — 1 when none does. */
function lineOfText(path: string, text: string): number {
  if (!existsSync(path)) return 1;
  const i = readFileSync(path, 'utf-8').split(/\r?\n/).findIndex(l => l.trim() === text.trim());
  return i + 1 || 1;
}

/** What a name that resolves to no block of its kind is told. */
function unresolvedMessage(kind: string, name: string): string {
  if (kind === 'agent') return `unknown agent \`${name}\` — BY names a member of this team, or a team`;
  if (kind === 'skill') return `unknown skill \`${name}\` — ${SKILL_IMPORT_HINT}`;
  return `unknown ${kind} \`${name}\` — define it, or IMPORT it FROM @<lib>.${kind}s`;
}

// Shared bundle pipeline helpers used by the agent bundle and the standalone one.

export interface MakeContextOpts {
  agentName: string;
  libraryRoot: string;
  libraryRoots: string[];
  libraries?: Record<string, string>;
  lintOptions?: LintConfig;
  renderings?: Record<string, Record<string, string>>;
  /** The environment variable the adapter's harness puts its session id in. */
  sessionEnv?: string;
  /** The compilation's source registry — a fresh one when absent. */
  sources?: SourceRegistry;
  /** The judge of checked conditions — absent: none. */
  checks?: ChecksConfig | null;
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
    dimensions: [],
    domains: [],
    // Each plugin's blocks, under its folder's name — read back by its kind strategy.
    ...Object.fromEntries(plugins().map(p => [p.folder, []])),
    skills: [],
    variables: [],
    lintErrors: [],
    lintOptions: opts.lintOptions,
    renderings: opts.renderings,
    sessionEnv: opts.sessionEnv,
    checks: opts.checks ?? null,
    importedPaths: new Set<string>(),
    sources: opts.sources ?? new SourceRegistry(),
  };
}

export async function expandImports(content: string, ctx: BundleContext, sourcePath?: string): Promise<string> {
  return processImports(content, ctx, sourcePath);
}

/**
 * Canonical source-body resolution: expand `IMPORT`s, then hoist inline
 * `<KIND> <name>:` blocks into `ctx` so `emitCollectedSections` renders them.
 * Single source of truth shared by every bundle path (agent, skill,
 * standalone, orchestration) so a FLOW/PROCEDURE/TEMPLATE resolves identically
 * regardless of which file declares it.
 */
export async function resolveInlineBlocks(
  stripped: string,
  ctx: BundleContext,
  sourcePath: string,
): Promise<string> {
  const known = ctx.roles.length;
  const body = extractInlineDefinitions(await expandImports(stripped, ctx, sourcePath), ctx, sourcePath);
  // An inline role's rules carry the IMPORTs of the library roles it EXTENDS:
  // resolve them like the agent's own, so no IMPORT line is left as text.
  for (const role of ctx.roles.slice(known)) role.body = await processImports(role.body, ctx, sourcePath);
  return body;
}

/**
 * The roles the agent binds with `AS <role>, …`, in the order written: each
 * one found among the roles collected into `ctx.roles` (inline or imported).
 * They are the agent's identity — their names, ABOUT, EXPERTISE and
 * behaviours fuse into its `# Identity` block (AgentBlock.asMdIdentity) — so
 * the caller leaves them out of the Roles chapter. One role is a list of one.
 * A name no collected role answers is returned in `missing`.
 */
function bindRoles(metadata: Map<string, string[]>, ctx: BundleContext): { roles: RoleEntry[]; missing: string[] } {
  const names = parseAgentSignature(`AS ${metadata.get('AS')?.[0] ?? ''}`).roles;
  const roles: RoleEntry[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const role = ctx.roles.find(r => r.name === name);
    if (!role) missing.push(name);
    else if (!roles.includes(role)) roles.push(role);
  }
  return { roles, missing };
}

/**
 * Two bound roles that disagree on one rule — the same text under two
 * different keywords (`ALWAYS x` in one, `NEVER x` in another): the agent
 * could keep neither, so the compilation fails and says which.
 */
function roleConflicts(roles: readonly RoleEntry[], file: string): LintError[] {
  const seen = new Map<string, { keyword: string; role: string }>();
  const errors: LintError[] = [];
  for (const role of roles) {
    for (const line of role.body.split('\n')) {
      const m = line.trim().match(/^([A-Z][A-Z-]*!{0,2})[ \t]+(.+)$/);
      if (!m) continue;
      const [, keyword, text] = m;
      const prior = seen.get(text);
      if (prior && prior.keyword !== keyword && prior.role !== role.name) {
        errors.push({ file, line: lineOfName(file, role.name), message: `roles \`${prior.role}\` and \`${role.name}\` disagree: \`${prior.keyword} ${text}\` and \`${keyword} ${text}\` — bind one of them, or make them agree` });
      } else if (!prior) seen.set(text, { keyword, role: role.name });
    }
  }
  return errors;
}


/**
 * Every `{{name}}` a compilation reads — its source file and every block it
 * imports, comment lines aside — names a constant or a variable that file sees
 * (`seen`: imports never pass on), or the compilation fails where it is written.
 * `sessionRead` says why a file may not read a variable, or null when it may.
 * A write — `… INTO x`, `VAR x:` — of a variable another file imports fails
 * alike: the file that writes it imports it too.
 */
/**
 * The elements of a file's `EACH <item> IN {{<list>}} MAX <n>:` blocks: for a
 * line, the items of the EACH blocks it stands beneath — the element is read
 * only there.
 */
function eachElements(source: string): (line: number) => ReadonlySet<string> {
  const tokens = lex(source).filter(t => t.kind !== 'blank' && t.kind !== 'comment');
  const scopes: { item: string; from: number; to: number }[] = [];
  tokens.forEach((t, k) => {
    const head = t.kind === 'keyword' && t.keyword === 'EACH' ? eachHeadOf(t.rest) : null;
    if (!head) return;
    const end = tokens.slice(k + 1).find(n => n.indent <= t.indent);
    scopes.push({ item: head.item, from: t.line + 1, to: end ? end.line - 1 : Number.MAX_SAFE_INTEGER });
  });
  return line => new Set(scopes.filter(s => line >= s.from && line <= s.to).map(s => s.item));
}

function variableUseErrors(
  ctx: BundleContext, sourcePath: string, seen: (file: string) => { constants: Record<string, string>; variables: Set<string> },
  sessionRead: (file: string) => string | null,
): LintError[] {
  const kinds = [ctx.policies, ctx.roles, ctx.templates, ctx.procedures, ctx.flows, ctx.stores, ctx.dimensions] as { path: string }[][];
  const files = new Set([sourcePath, ...kinds.flat().map(d => d.path)]);
  const errors: LintError[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const refused = sessionRead(file);
    const { constants, variables } = seen(file);
    const source = ctx.sources.read(file);
    const elementOf = eachElements(source);
    for (const t of lex(source)) {
      if (t.kind !== 'keyword') continue;
      const decl = parseVarLine(t.keyword, t.rest);
      const write = takesInto(t.keyword) ? splitInto(t.rest)?.name : decl && 'form' in decl && decl.form === 'variable' && decl.block ? decl.name : undefined;
      if (write && !variables.has(write) && ctx.variables.some(v => v.name === write)) {
        errors.push({ file, line: t.line, message: unknownVariable(t.raw.trim(), write, ctx) });
      }
    }
    source.split(/\r?\n/).forEach((line, i) => {
      if (line.startsWith('#')) return;
      for (const { read, name, field, template } of readsOf(line)) {
        const err = (message: string) => errors.push({ file, line: i + 1, message });
        if (field) continue;   // a field read is the vocabulary check's
        // A shaped read takes the shape of a template the agent has, from a variable — never a constant.
        if (template && constantOf(constants, name) !== undefined) err(`\`${read}\`: a constant has no shape to take — write the part you need`);
        else if (template && !ctx.templates.some(tpl => tpl.name === template)) err(`\`${read}\`: ${unresolvedMessage('template', template)}`);
        if (constantOf(constants, name) !== undefined) continue;
        // An EACH's element, read in the lines beneath it.
        if (elementOf(i + 1).has(name)) continue;
        if (!variables.has(name)) {
          err(unknownVariable(read, name, ctx));
        } else if (refused) {
          errors.push({ file, line: i + 1, message: `\`${read}\`: ${refused}` });
        }
      }
    });
  }
  return errors;
}

/**
 * Why `{{name}}` reads nothing: the name of a template is not a variable's —
 * say so; any other name is declared in the body, or imported from the module
 * that exports it.
 */
function unknownVariable(read: string, name: string, ctx: BundleContext): string {
  const elsewhere = ctx.variables.find(v => v.name === name);
  if (elsewhere) return `\`${read}\`: \`${name}\` is imported by ${elsewhere.importers.join(', ')}, not here — an import never passes on: IMPORT ${name} FROM ${elsewhere.from} in this file too`;
  return ctx.templates.some(t => t.name === name)
    ? `\`${read}\`: \`${name}\` is a template, not a variable — declare \`VAR <name> AS ${name}\` and read that`
    : `unknown variable \`${read}\` — declare it in the body (\`VAR ${name}\`), or IMPORT it FROM the module that exports it (\`EXPORT VAR ${name}\`)`;
}

/** A name means one thing to an agent: a variable or a constant never shares a template's name. */
function templateNameErrors(ctx: BundleContext, names: Iterable<string>): LintError[] {
  const errors: LintError[] = [];
  for (const name of new Set(names)) {
    const template = ctx.templates.find(t => t.name === name);
    if (template) errors.push({ file: template.path, line: lineOfName(template.path, name), message: `\`${name}\` names both a variable and a template — give one of them another name` });
  }
  return errors;
}

/**
 * A block of a shared or builtin library reads no variable: it takes
 * its input through LENS-IN (P4). The project's own blocks — its library, the
 * agent's own file — may.
 */
function libraryReadRule(ctx: BundleContext, agentFilePath: string): (file: string) => string | null {
  const own = resolve(ctx.libraryRoot) + sep;
  const foreign = Object.entries(ctx.libraries ?? {}).filter(([alias]) => alias !== '@main').map(([, root]) => resolve(root) + sep);
  return file => file !== agentFilePath && !file.startsWith(own) && foreign.some(root => file.startsWith(root))
    ? 'a block of a shared library reads no variable — take the value as its input, through LENS-IN'
    : null;
}

/** Why the store API itself cannot keep a slot, whatever the driver — or null. */
function storeSlotIssue(slot: string): string | null {
  if (!STORE_FIELD_RE.test(slot)) return `slot "${slot}": a store field name uses letters, digits and _ only — write ${slot.replace(/[^A-Za-z0-9_]/g, '_')}`;
  if (slot === 'id') return 'slot "id": id is the record\'s own identifier, given by the driver — name the slot otherwise';
  return null;
}

/** A store its driver cannot keep — an unknown DRIVER, a store or a slot the driver refuses — fails the compilation. */
function storeErrors(doc: ApDocument, ctx: BundleContext, agentFilePath: string): LintError[] {
  return (doc.byKind('store') as StoreBlock[]).flatMap(store => {
    const file = ctx.stores.find(s => s.name === store.name)?.path ?? agentFilePath;
    const p = store.projection();
    if (p.unknownDriver) {
      return [{ file, line: lineOfName(file, store.storeDriver), message: `STORE ${store.name}: unknown DRIVER \`${store.storeDriver}\` (installed: ${p.unknownDriver.available.join(', ')})` }];
    }
    const refused = p.refused ? [{ file, line: lineOfName(file, store.storeDriver), message: `STORE ${store.name}: ${p.refused}` }] : [];
    if (store.shape && store.ownSlots) {
      refused.push({ file, line: lineOfName(file, refName(store.shape.ref)), message: `STORE ${store.name}: its fields come from AS \`${refName(store.shape.ref)}\` or from its SLOTS — not both` });
    }
    const key = store.storeKey && !store.slots.some(sl => sl.name === store.storeKey)
      ? [{ file, line: lineOfName(file, store.storeKey), message: `STORE ${store.name}: KEY \`${store.storeKey}\` is none of its slots (${store.slots.map(sl => sl.name).join(', ')})` }]
      : [];
    const names = store.slots.flatMap(sl => {
      const why = storeSlotIssue(sl.name);
      return why ? [{ file, line: lineOfName(file, sl.name), message: `STORE ${store.name}: ${why}` }] : [];
    });
    return [...refused, ...key, ...names, ...Object.entries(p.rejects).map(([slot, why]) => ({ file, line: lineOfName(file, slot), message: `STORE ${store.name}: ${why}` }))];
  });
}


/** A plugin's block keeps its contract and its template wherever it is written — a library file or the agent's own (pluginBlockErrors). */
function pluginFileErrors(ctx: BundleContext): LintError[] {
  const defs = plugins().flatMap(p => (ctx as unknown as Record<string, { path: string }[]>)[p.folder] ?? []);
  const files = [...new Set(defs.map(d => d.path))].filter(file => existsSync(file));
  return files.flatMap(file => pluginBlockErrors(file, ctx.sources.tree(file).blocks));
}

/**
 * A domain keeps its contract wherever it is written — a library file or the
 * agent's own (domainBlockErrors, the lint's own check) — and puts work
 * somewhere: its plain globs match a file of the project, or a judged formula
 * places one within, or leaves one to the agent. A domain a formula of which
 * is not judged (no judge, a file not answered) is said elsewhere.
 */
function domainFileErrors(ctx: BundleContext, doc: ApDocument, projectRoot: string, unjudged: ReadonlySet<string>): LintError[] {
  const files = [...new Set(ctx.domains.map(d => d.path))].filter(file => existsSync(file));
  const empty = (doc.byKind('domain') as DomainBlock[]).flatMap(d => {
    const file = ctx.domains.find(e => e.name === d.name)?.path;
    if (!file || unjudged.has(d.name)) return [];
    const globs = [...d.writes, ...d.reads];
    const sides = [d.side('WRITES'), d.side('READS')];
    if (sides.some(s => s.within.length > 0 || Object.keys(s.uncertain).length > 0)) return [];
    if (globs.length > 0 && hasProjectFile(projectRoot, rel => matchesAnyGlob(rel, globs))) return [];
    if (globs.length === 0 && d.formulas.length === 0) return [];
    const what = [...(globs.length ? [`no file of the project matches ${renderGlobs(globs)}`] : []), ...d.formulas.map(f => `a judge placed no file in \u201c${f.formula}\u201d`)].join(', and ');
    return [{ file, line: lineOfName(file, d.name), message: `DOMAIN ${d.name}: ${what} — a domain says where work is done: name files that are there` }];
  });
  return [...files.flatMap(file => domainBlockErrors(file, ctx.sources.tree(file).blocks)), ...empty];
}

/**
 * A delegation's perimeter stays within its agent's (D44): a `DELEGATE … BY`
 * this agent, under a step's `@WITHIN`, names only domains the agent works
 * within — when a `@WITHIN` decorates the agent. A delegation is checked by its
 * own agent's compilation, so once.
 */
/**
 * A step's `@WITHIN` names only domains of the agent it delegates to, when a
 * `@WITHIN` decorates that agent. `domainsOf` says an agent's domains by name —
 * null when no `@WITHIN` decorates it: in a unit's document every agent a flow
 * delegates to, read from its own file.
 */
function delegationPerimeterErrors(delegations: DocumentBuilder['delegationScopes'], domainsOf: (agent: string) => string[] | null): LintError[] {
  return delegations.flatMap(s => {
    const domains = domainsOf(s.by);
    if (!domains) return [];
    const names = new Set(domains);
    const outside = (s.scope.get(WITHIN_DECORATOR.key) ?? []).filter(u => !names.has(u.name));
    if (outside.length === 0) return [];
    return [{ file: s.path, line: s.line ?? 1, message: `${DECORATOR_MARK}${WITHIN_DECORATOR.key} ${outside.map(u => u.name).join(', ')}: \`${s.by}\`, whom this line delegates to, works within ${[...names].map(n => `\`${n}\``).join(', ')} — a step's ${DECORATOR_MARK}${WITHIN_DECORATOR.key} names only domains of the agents it delegates to` }];
  });
}

/** The domains an agent of a unit works within — its `@WITHIN` line above its block, by name — or null when none decorates it. */
function memberDomains(files: string[], sources: SourceRegistry): (agent: string) => string[] | null {
  return agent => {
    const file = files.find(f => agentNameOf(f) === agent);
    const block = file ? sources.tree(file).blocks.find(b => AGENT_KEYS.has(b.key) && b.name === agent) : undefined;
    const within = (block?.decorators ?? []).filter(d => d.key === WITHIN_DECORATOR.key);
    return within.length ? within.flatMap(d => splitList(d.rest)) : null;
  };
}

/**
 * A dimension keeps its contract wherever it is written — in a library file, in
 * the agent's own file, exported or not: ABOUT, FOR, EACH and STORE once each,
 * its rules, nothing else; FOR globs from the project root (dimensionBlockErrors,
 * the lint's own check). Its store gives its records' fields and its driver,
 * and the cache gives the rest — so the store says no LASTS session and no KEY,
 * and its driver takes and guards records.
 */
function dimensionErrors(doc: ApDocument, ctx: BundleContext): LintError[] {
  const files = [...new Set(ctx.dimensions.map(d => d.path))].filter(file => existsSync(file));
  return [...files.flatMap(file => dimensionBlockErrors(file, ctx.sources.tree(file).blocks)), ...(doc.byKind('dimension') as DimensionBlock[]).flatMap(dim => {
    const file = ctx.dimensions.find(d => d.name === dim.name)?.path;
    if (!file || !existsSync(file)) return [];
    const err = (name: string, message: string): LintError => ({ file, line: lineOfName(file, name), message: `DIMENSION ${dim.name}: ${message}` });
    const store = dim.store ? doc.resolve(dim.store) as StoreBlock | null : null;
    return store ? dimensionStoreErrors(store, err) : [];
  })];
}

/** What a dimension's store may not be: fieldless, a session's, keyed, or kept by a driver that cannot take and guard records. */
function dimensionStoreErrors(store: StoreBlock, err: (name: string, message: string) => LintError): LintError[] {
  const errors: LintError[] = [];
  if (store.slots.length === 0) errors.push(err(store.name, `its store \`${store.name}\` has no fields — give it SLOTS, or AS <template>`));
  if (store.declaredLasts === 'session') errors.push(err(store.name, `its store \`${store.name}\` says LASTS session — a dimension's answers are kept for the project: drop the line`));
  if (store.storeKey) errors.push(err(store.name, `its store \`${store.name}\` says KEY ${store.storeKey} — a dimension keeps its records by file itself: drop the line`));
  const driver = storeDriverOf(store.storeDriver);
  const lacks = driver ? DIMENSION_CAPABILITIES.filter(c => !driver.capabilities.includes(c)) : [];
  if (lacks.length > 0) errors.push(err(store.name, `its store's driver \`${store.storeDriver}\` has no ${lacks.join(' and ')} — a dimension takes and guards its records: keep it with files or tabeli`));
  return errors;
}

/** What a dimension asks of its store's driver: `next` takes a file, a write is guarded. */
const DIMENSION_CAPABILITIES = ['take', 'guard'] as const;

/**
 * A dimension is an agent's — read and written through that agent's apx. One a
 * compilation that is no agent's reaches (PROJECT.ap, a standalone skill, a
 * team's file), from `from` on in `ctx.dimensions`, fails it at `file`.
 */
export function strayDimensionErrors(ctx: BundleContext, file: string, from = 0): LintError[] {
  return ctx.dimensions.slice(from).map(d => ({
    file,
    line: d.path === file ? lineOfName(file, d.name) : lineOfName(file, d.name, 'import'),
    message: `DIMENSION ${d.name}: a dimension belongs to an agent — it is read and written through that agent's apx, so only an agent's file declares or imports it`,
  }));
}

/** Check the words of a source the pipeline reads itself (not through an IMPORT), into `ctx`. */
export function lintSource(path: string, ctx: BundleContext): void {
  if (existsSync(path)) ctx.lintErrors.push(...checkVocabulary(path, ctx.sources.read(path)));
}

/**
 * A compilation with no executable — a standalone file — checks
 * no condition: the checked heads of its source and of the procedures it runs
 * are reported where they stand (an `IF!` warns, an `IF!!` fails).
 */
function noExecutableChecks(sourcePath: string, ctx: BundleContext): void {
  for (const file of new Set([sourcePath, ...ctx.procedures.map(p => p.path)])) {
    if (existsSync(file)) ctx.lintErrors.push(...checkedHeadIssues(file, ctx.sources.read(file), ctx.checks));
  }
}

/** Lint check shared by every bundle entry point. Throws on errors, logs warnings. */
export function reportLintIssues(ctx: BundleContext, label: string): void {
  reportIssues(ctx.lintErrors, label);
}

/** Report the warnings among `issues`, then throw on its errors. */
function reportIssues(issues: LintError[], label: string): void {
  const warnings = issues.filter(e => e.severity === 'warning');
  if (warnings.length > 0) reporter().diagnostics(warnings);
  failOnErrors(issues.filter(e => e.severity !== 'warning'), label);
}

/** The errors stop the compilation — they travel as data, for the reporter to show. */
function failOnErrors(errors: LintError[], label: string): void {
  if (errors.length > 0) throw new CompileError(label, errors);
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
  return protectVerbatim(`${body.trimEnd()}\n`, masked => {
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
  const body = s.renderBody?.(e, ctx) ?? (s.headerKeyword ? stripHeaderKeyword(e.body, s.headerKeyword, e.name) : e.body);
  // A policy or a skill opens with the line that says where it applies (src/withUse.ts).
  return withScopeLine(e.kind, e.scopes, body);
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

interface StandaloneHeader {
  metadata: Map<string, string[]>;
  stripped: string;  // body without ABOUT / WHEN — ready for expandImports
}

/**
 * Single-pass extraction for standalone sources: ABOUT, all WHEN triggers,
 * and a stripped body produced from the same token stream.
 *
 * APPLIES is file-level metadata like ABOUT — consumed into the map so it
 * never leaks into the rendered body.
 */
function parseStandaloneHeader(raw: string): StandaloneHeader {
  const HEADER_KEYWORDS = new Set(['ABOUT', 'WHEN', 'APPLIES']);
  const metadata = new Map<string, string[]>();
  const out: string[] = [];

  const tokens = lex(raw);
  // A `WHEN <trigger>:` with lines nested below is the file's own trigger, never header metadata: it stays in the body.
  const opensTrigger = (i: number): boolean => {
    const below = tokens.slice(i + 1).find(n => n.kind !== 'blank' && n.kind !== 'comment');
    return tokens[i].kind === 'keyword' && (tokens[i] as { keyword: string }).keyword === 'WHEN' && opensBlock(tokens[i]) && !!below && below.indent > tokens[i].indent;
  };
  for (const [i, t] of tokens.entries()) {
    if (t.kind === 'comment') continue;
    if (t.kind === 'keyword' && t.indent === 0 && HEADER_KEYWORDS.has(t.keyword) && !opensTrigger(i)) {
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
 * Pure compilation: resolves all directives and returns the compiled context as a string.
 * No file I/O for output — the caller decides what to do with the result.
 */
export async function bundleAgentToString(opts: BundleOptions): Promise<string> {
  return (await bundleAgentObject(opts)).body;
}

/**
 * Compile a standalone .ap file (no agent metadata)
 * through the same pipeline used by agents: imports, force
 * levels, vars, and the collected primitives (Templates/Procedures).
 * Strips H1 and ABOUT from the source. Used by the main's file (`main`: read
 * as its unit) and any other top-level standalone file that compiles to plain markdown.
 */
export async function bundleStandaloneToString(
  path: string,
  config: Config,
  opts: { extraLibraryRoots?: string[]; extraLibraries?: Record<string, string>; adapter?: AdapterPlugin; main?: MainFile } = {},
): Promise<string> {
  return (await compileStandalone(path, config, opts)).text;
}

/**
 * The main's file compiled: its whole text — what its apx prints on `start` —
 * and its universal policies alone, the chapter AGENTS.md still holds.
 */
export async function bundleMainTexts(main: MainFile, config: Config): Promise<{ text: string; universal: string }> {
  const { text, ctx } = await compileStandalone(main.path, config, { main });
  const policies = STRATEGIES.find(s => s.kind === 'policy');
  if (!policies) return { text, universal: '' };
  const chapter = buildChapterFromStrategy(policies, ctx);
  const universal = emitChapter(ctx, { ...chapter, entries: chapter.entries.filter(e => e.scopes.includes(UNIVERSAL_SCOPE)) });
  return { text, universal: universal ? postProcessBody(universal, ctx).trim() : '' };
}

/** The scope token of a policy that holds everywhere — `APPLIES universal`. */
const UNIVERSAL_SCOPE = 'universal';

async function compileStandalone(
  path: string,
  config: Config,
  opts: { extraLibraryRoots?: string[]; extraLibraries?: Record<string, string>; adapter?: AdapterPlugin; main?: MainFile },
): Promise<{ text: string; ctx: BundleContext }> {
  const absolute = resolve(path);
  const name = unitNameFromPath(absolute);

  const ctx = makeBundleContext({
    agentName: name,
    libraryRoot: config.libraryRoot,
    libraryRoots: [...libraryRootsOf(config), ...(opts.extraLibraryRoots ?? [])],
    libraries: { ...librariesAliasMap(config), ...(opts.extraLibraries ?? {}) },
    renderings: opts.adapter?.renderings,
  });
  // The main's file is read as its unit: the MAIN block's routing and flows at the top, its head lines blanked;
  // a flow of the main starts through the main's apx, which holds it.
  const header = parseStandaloneHeader(opts.main?.unit ?? ctx.sources.read(absolute));
  const mainName = opts.main?.name;
  if (mainName) ctx.flowCommand = id => apxCommand(mainName, 'flow', id);
  lintSource(absolute, ctx);
  if (opts.main) ctx.lintErrors.push(...mainBlockErrors(absolute, opts.main.block));

  let body = await resolveInlineBlocks(header.stripped, ctx, absolute);
  ctx.lintErrors.push(...standaloneDecoratorErrors(ctx, absolute, body), ...strayDimensionErrors(ctx, absolute));
  body = `${emitCollectedSections(ctx)}${tidyBlankLines(body)}\n`;
  noExecutableChecks(absolute, ctx);

  reportLintIssues(ctx, `Standalone bundle (${basename(absolute)})`);

  return { text: postProcessBody(body, ctx), ctx };
}

/**
 * Same as bundleAgentToString but exposes bundle metadata alongside the body.
 */
export async function bundleAgentObject(opts: BundleOptions): Promise<{
  body: string;
  metadata: Map<string, string[]>;
  structure?: ApDocument;
  /** The block is a SKILL — an agent the adapter writes as a skill. */
  skill: boolean;
  /** The agent's file, as resolved. */
  agentFile: string;
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
    sessionEnv: opts.adapter?.sessionEnv,
    sources: opts.sources,
    checks: opts.checks,
  });
  // The document builder — walks the resolved sources directly (no events)
  // and assembles the ApDocument in `finish()` below.
  const builder = new DocumentBuilder();

  // Bootstrap: the per-member team-membership section (who this agent is within
  // its team — foundational context, so first), then the team's shared block
  // (team.ap, when the agent is a team member), then the framework runtime
  // defaults. All are prepended before the agent's own identity and rules.
  // Team root is resolved from the agent's flat file (its sibling team file).
  // A unit's file — a team's, the main's — compiles into its own document: its flows and what they use, no agent.
  const main = isMainFile(agentFilePath) ? readMainFile(dirname(resolve(agentFilePath)), ctx.sources) : null;
  const unit = isTeamFile(agentFilePath) ? 'team' as const : main ? 'main' as const : undefined;
  const bootstrap = unit ? '' :
    resolveTeamMembership(agentFilePath) +
    resolveTeamShared(agentFilePath) +
    resolveBundleDefaults(opts.bundleConfig ?? {});

  // The agent file is split into its `EXPORT AGENT` and sibling `EXPORT ROLE`
  // blocks and re-composed as ONE unit — imports prologue, then the inline
  // `ROLE <name>:` block, then the agent body. partitionMetadata does extract +
  // strip in a single lex pass; the adapter later obtains frontmatter via
  // collectFrontmatter(metadata, …).
  // The words of the agent's own file and of its team's file are checked
  // like every import's.
  lintSource(agentFilePath, ctx);
  const teamRoot = teamRootForAgentFile(agentFilePath);
  const teamFile = teamRoot ? readTeamFile(teamRoot, ctx.sources) : null;
  if (teamFile) {
    lintSource(teamFile.path, ctx);
    // The block's own contract (ABOUT, MEMBER, what a team holds) and its roster against the folder.
    ctx.lintErrors.push(...teamFileErrors(teamFile.path, teamFile.source), ...teamRosterIssues(teamFile));
    // The team's flows are the team's own document; so are the blocks the team
    // file imports for them (a step's AS template). A member holds neither.
    const imports = unit ? teamFile.source.split(/\r?\n/).filter(l => /^IMPORT\s/.test(l)).join('\n') : '';
    if (imports) await expandImports(imports, ctx, teamFile.path);
  }

  const metadata = new Map<string, string[]>();
  const agentFile = unit ? null : readAgentFile(agentFilePath, ctx.sources);
  const { metadata: fileMeta, stripped } = agentFile ? partitionMetadata(agentFile.unitSource, AGENT_METADATA_KEYWORDS) : { metadata: new Map<string, string[]>(), stripped: '' };
  mergeMetadata(metadata, fileMeta);
  // Symmetric to resolveFile: inline `<KIND> <name>:` blocks (the agent's
  // sibling ROLE) end up in the same ctx collections that imported files
  // target. Downstream rendering is identical.
  const agentBody = agentFile ? `${await resolveInlineBlocks(stripped, ctx, agentFilePath)}\n\n` : '';
  // The main's file: its MAIN block checked, and what is written around it — its imports and definitions — compiled.
  if (main) {
    ctx.lintErrors.push(...mainBlockErrors(main.path, main.block));
    await resolveInlineBlocks(outsideBlock(main.source.split(/\r?\n/), main.block), ctx, main.path);
  }
  const memberFiles = main ? main.members.map(m => opts.agentFileOf?.(m.name) ?? '').filter(f => f && existsSync(f)) : [];
  // A program carries out some of this agent's work: how to write one comes with it.
  if (usesPrograms(agentBody, ctx.procedures) && opts.libraries?.['@builtin'] && !ctx.procedures.some(p => p.name === WRITE_PROGRAM)) {
    await expandImports(`IMPORT ${WRITE_PROGRAM} FROM @builtin.procedures`, ctx, agentFilePath);
  }
  const variables = importedVariables(ctx.variables, opts.vars ?? {});

  // Role binding: `AS <role>` resolves the bound role's display name / ABOUT /
  // EXPERTISE into the identity metadata (the agent itself may not declare them —
  // lint forbids it; they live in the role). MANDATE stays the agent's own. The
  // bound role is also returned so its behaviours fuse into the Identity block
  // and it is excluded from the Roles chapter — the role IS the agent here, not a
  // separate cognitive layer.
  const bound = bindRoles(metadata, ctx);
  const boundRoles = bound.roles;
  ctx.roles = ctx.roles.filter(r => !boundRoles.includes(r));

  // An `AS <role>` naming no role is a broken reference like any other.
  for (const name of bound.missing) {
    ctx.lintErrors.push({ file: agentFilePath, line: lineOfName(agentFilePath, name), message: `unknown role \`${name}\` — define it, or IMPORT it FROM @<lib>.roles` });
  }
  ctx.lintErrors.push(...roleConflicts(boundRoles, agentFilePath));
  reportLintIssues(ctx, 'Bundle');

  const structure = builder.finish(ctx, {
    metadata,
    boundRoles,
    agentBody,
    agentFilePath,
    agentSpan: agentFile?.span ?? null,
    bootstrap,
    vars: variables.constants,
    declaredVars: variables.variables,
    teams: opts.teams ?? [],
    ...(unit ? { unit } : {}),
    ...(main ? { memberFiles } : {}),
  });
  // A DELEGATE without BY goes to the default delegate; the config may set this agent's model.
  const delegate = opts.delegate ?? resolveDelegateConfig(undefined);
  if (Object.values(structure.meta.executors ?? {}).some(e => e.executor === 1 && !e.by)) structure.meta.delegate = delegate.default;
  if (delegate.models[agentName]) structure.meta.model = delegate.models[agentName];
  // The recipe of each harness a delegation goes to — a piece or a list of contracts — for the apx to fill when it starts (D66),
  // with the model each agent of the project runs on there: its BUDGET tier's.
  const used = new Set([...structure.nodes()].flatMap(({ node }) => (node.type === 'directive' && node.harness ? [node.harness] : [])));
  const recipes = Object.fromEntries([...used].flatMap(h => {
    const row = (opts.harnesses ?? []).find(r => r.name === h);
    if (!row?.invocation) return [];
    const models = agentModels(row, opts.agentIndex ?? []);
    return [[h, { ...row.invocation, ...(Object.keys(models).length ? { models } : {}) }]];
  }));
  if (Object.keys(recipes).length > 0) structure.meta.harnesses = recipes;
  const declared = new Set(structure.byKind('var').map(b => b.name));
  // Every file sees the bodies' declarations and the implicit constants; an import, only the file that writes it.
  const imported = new Set(ctx.variables.map(v => v.name));
  const everywhere = { constants: opts.vars ?? {}, variables: [...declared].filter(name => !imported.has(name)) };
  const located = (e: { path: string; name: string; line: number | null; message: string; severity?: 'warning' }): LintError =>
    ({ file: e.path, line: e.line ?? lineOfName(e.path, e.name), message: e.message, ...(e.severity ? { severity: e.severity } : {}) });
  const projectRoot = opts.projectRoot ?? process.cwd();
  const judgedDomains = await judgeDomainFormulas(structure, ctx, opts.judge, projectRoot);
  reportIssues([
    ...unresolvedErrors(builder.unresolved),
    ...builder.decoratorProblems.map(p => ({ file: p.path, line: p.line ?? 1, message: p.message })),
    ...unappliedErrors(ctx, builder.decoratorNamed, true),
    ...storeErrors(structure, ctx, agentFilePath),
    ...dimensionErrors(structure, ctx),
    // A unit's flows delegate to its members, each within its own domains; an agent's own body, to itself.
    ...delegationPerimeterErrors(builder.delegationScopes, unit === 'team' && teamRoot ? memberDomains(findAgentFiles(teamRoot), ctx.sources)
      : unit === 'main' ? memberDomains(memberFiles, ctx.sources)
      : agent => (agent === agentName ? structure.domains()?.map(d => d.name) ?? null : null)),
    ...judgedDomains.errors,
    ...domainFileErrors(ctx, structure, projectRoot, judgedDomains.unjudged),
    ...pluginFileErrors(ctx),
    ...builder.varErrors.map(located),
    ...builder.checkIssues.map(located),
    ...(opts.agentIndex ? delegateTargetErrors(structure, opts.agentIndex, teamRoot ? basename(teamRoot) : null,
      h => harnessProblem(h, opts.harnesses ?? []), (h, a) => modelProblem(h, a, opts.harnesses ?? [])) : []),
    ...executorErrors(structure),
    ...variableUseErrors(ctx, agentFilePath, file => visibleIn(file, ctx.variables, everywhere), libraryReadRule(ctx, agentFilePath)),
    ...templateNameErrors(ctx, [...declared, ...Object.keys(variables.constants)]),
  ], 'Bundle');
  // The judge phase: a well-formed document's lines checked by the judge.
  if (opts.judge) failOnErrors(await judgeDocument(structure, opts.judge, ctx.sources), 'Bundle');
  const body = renderMd(structure) + await emitTools(ctx);

  return {
    body,
    metadata,
    structure,
    // A SKILL block is an agent the adapter writes as a skill: only the bundle's kind differs.
    skill: agentFile?.info.skill ?? false,
    agentFile: agentFilePath,
  };
}
