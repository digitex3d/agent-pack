// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, readFileSync } from 'fs';
import { FORMULAS, fill, introOf } from '../formulas.js';
import { resolve, join, dirname, basename, sep } from 'path';
import { unitNameFromPath } from '../ingest.js';
import { projectAgentFiles } from '../agentDiscovery.js';
import { Config, BundleConfig, LintConfig, libraryRoots as libraryRootsOf, librariesAliasMap } from '../config.js';
import { BundleContext, RoleEntry } from '../dispatch/index.js';
import { processImports, resolveTargetWith, SKILL_IMPORT_HINT } from '../dispatch/imports.js';
import { unknownWithMessage, scanWith, unappliedBlocks, unappliedIssue, withScopeLine, type WithProblem } from '../withUse.js';
import { resolveBundleDefaults, resolveTeamShared } from '../bundleDefaults.js';
import { resolveTeamMembership } from '../services/teamMembership.js';
import { findAgentFiles, readAgentFile, standaloneDir, agentNameOf, teamRootForAgentFile, readTeamFile, teamRosterIssues, legacyTeamIssue, buildContractIndex, readContractBlocks, projectContractIssues, withoutBlocks, CONTRACTS_STRATEGY, type ContractIndex, type TeamFile } from '../services/teamMetadata.js';
import { askTargetErrors, executorErrors, usesPrograms, WRITE_PROGRAM, type AgentIndexEntry } from '../executor.js';
import { BUILTIN_AGENTS_DIR, resolveDelegateConfig, PROJECT_SOURCE, type DelegateConfig } from '../config.js';
import { LintError, checkVocabulary, lineOfName, checkedHeadIssues, dimensionBlockErrors, domainBlockErrors, teamBlockErrors, contractBlockErrors } from '../lint.js';
import { CompileError, reporter } from '../report.js';
import { extractInlineDefinitions } from '../dispatch/inlineBlocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { renderEnumLegend } from '../enumPrimitives.js';
import { partitionMetadata, mergeMetadata, protectVerbatim } from '../services/text.js';
import { lex, opensBlock } from '../lexer.js';
import { applyBodySubstitutions, stripHeaderKeyword, AGENT_METADATA_KEYWORDS } from '../primitives.js';
import { resolveShapeRefs } from '../shapeCompiler.js';
import { AdapterPlugin } from '../../adapters/types.js';
import { renderMd } from '../../adapters/md/index.js';
import { emitChapter } from '../bundlers/sections.js';
import { STRATEGIES, strategyFor, type DefinitionStrategy, type Definition } from '../definition.js';
import { parseNamespace } from '../namespace.js';
import { DocumentBuilder } from '../apdoc/builder.js';
import type { ApDocument } from '../apdoc/document.js';
import type { AgentBlock, StoreBlock, DimensionBlock, TemplateBlock, TeamBlock } from '../apdoc/blocks.js';
import { SourceRegistry } from '../sources.js';
import { judgeDocument, type JudgeRun } from '../judge/phase.js';
import type { ChecksConfig } from '../judge/types.js';
import { importedVariables, visibleIn } from '../exportedVars.js';
import { readsOf, constantOf, parseVarLine, splitInto, takesInto } from '../vars.js';
import { refName } from '../../adapters/md/phrases.js';


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
  /** Every agent of the project and its team — what `ASK … BY` may name. Absent: not checked. */
  agentIndex?: AgentIndexEntry[];
  /** The project's contracts and teams — what a `BY <team>` resolves against, and whether some contract hands work to the agent's team. Absent: not checked. */
  contractIndex?: ContractIndex | null;
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

/** Every agent of the project (the global ones after it) and the team it belongs to. */
function agentIndexOf(config: Config): AgentIndexEntry[] {
  return agentFiles(config).map(file => {
    const teamRoot = teamRootForAgentFile(file);
    return { name: agentNameOf(file), team: teamRoot ? basename(teamRoot) : null };
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
    contractIndex: contractIndexOf(config, overrides.projectRoot),
    ...(config.delegate ? { delegate: config.delegate } : {}),
  };
}

/** The project's contracts: the teams under the config's teams folder and the CONTRACT blocks of its PROJECT.ap. */
function contractIndexOf(config: Config, projectRoot = process.cwd()): ContractIndex {
  return buildContractIndex(config.teamsDir, resolve(projectRoot, PROJECT_SOURCE));
}

/** A name that resolves to no block fails the compilation (D30): what is missing, and how to bring it in. */
function unresolvedErrors(unresolved: { path: string; name: string; kind: string }[]): LintError[] {
  return unresolved.map(u => ({ file: u.path, line: lineOfName(u.path, u.name), message: unresolvedMessage(u.kind, u.name) }));
}

/** What does not hold in a WITH head (src/withUse.ts), as an error at the file — and the line, when known — it was written in. */
function withProblemErrors(problems: (WithProblem & { path: string; line?: number | null })[]): LintError[] {
  return problems.map(p => ({ file: p.path, line: p.line ?? lineOfName(p.path, p.name), message: p.message ?? unresolvedMessage(p.kind, p.name) }));
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
 * The WITH checks of a standalone file, which has no document builder: every
 * head of the file and of the blocks it brings in, read once (scanWith).
 */
function standaloneWithErrors(ctx: BundleContext, file: string, body: string): LintError[] {
  const blocks = [ctx.roles, ctx.procedures, ctx.flows, ctx.policies, ctx.skills].flat();
  const { named, problems } = scanWith([{ path: file, tokens: lex(body) }, ...blocks.map(d => ({ path: d.path, tokens: lex(d.body) }))], ctx);
  return [...withProblemErrors(problems), ...unappliedErrors(ctx, named)];
}

/** What a name that resolves to no block of its kind is told. */
function unresolvedMessage(kind: string, name: string): string {
  if (kind === 'agent') return `unknown agent \`${name}\` — BY names a member of this team, or a team`;
  if (kind === 'skill') return `unknown skill \`${name}\` — ${SKILL_IMPORT_HINT}`;
  if (kind === 'with') return unknownWithMessage(name);
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
 * Every `{{name}}` a compilation reads — its source file and every block it
 * imports, comment lines aside — names a constant or a variable that file sees
 * (`seen`: imports never pass on), or the compilation fails where it is written.
 * `sessionRead` says why a file may not read a variable, or null when it may.
 * A write — `… INTO x`, `VAR x:` — of a variable another file imports fails
 * alike: the file that writes it imports it too.
 */
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


/** A domain keeps its contract wherever it is written — a library file or the agent's own (domainBlockErrors, the lint's own check). */
function domainFileErrors(ctx: BundleContext): LintError[] {
  const files = [...new Set(ctx.domains.map(d => d.path))].filter(file => existsSync(file));
  return files.flatMap(file => domainBlockErrors(file, ctx.sources.tree(file).blocks));
}

/**
 * An agent's perimeter names domains (D44): every name of its WRITES and READS
 * is a DOMAIN it declares or imports, listed once; a domain it writes is not
 * also one it reads — writing a domain reads it.
 */
function perimeterErrors(doc: ApDocument, file: string): LintError[] {
  const root = doc.root() as AgentBlock | null;
  if (!root) return [];
  const domains = new Set(doc.byKind('domain').map(d => d.name));
  const lines = existsSync(file) ? readFileSync(file, 'utf-8').split(/\r?\n/) : [];
  const at = (keyword: string) => Math.max(1, lines.findIndex(l => new RegExp(`^\\s*${keyword}\\b`).test(l)) + 1);
  const errors: LintError[] = [];
  for (const [keyword, names] of [['WRITES', root.writes], ['READS', root.reads ?? []]] as const) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) errors.push({ file, line: at(keyword), message: `${keyword}: \`${name}\` is listed twice` });
      seen.add(name);
      if (!domains.has(name)) errors.push({ file, line: at(keyword), message: `${keyword} ${name}: no DOMAIN is called \`${name}\` — declare it (\`EXPORT DOMAIN ${name}:\` with \`FOR <glob>, …\`) or IMPORT it FROM @main.domains` });
    }
  }
  for (const name of root.reads ?? []) {
    if (root.writes.includes(name)) errors.push({ file, line: at('READS'), message: `READS ${name}: \`${name}\` is in WRITES already — writing a domain reads it` });
  }
  return errors;
}

/**
 * A dimension keeps its contract wherever it is written — in a library file, in
 * the agent's own file, exported or not: ABOUT, FOR, EACH and AS once each, its
 * rules, nothing else; FOR globs from the project root (dimensionBlockErrors,
 * the lint's own check). Its AS names a template with SLOTS — its value is a
 * list of instances — at no level.
 */
function dimensionErrors(doc: ApDocument, ctx: BundleContext): LintError[] {
  const files = [...new Set(ctx.dimensions.map(d => d.path))].filter(file => existsSync(file));
  return [...files.flatMap(file => dimensionBlockErrors(file, ctx.sources.tree(file).blocks)), ...(doc.byKind('dimension') as DimensionBlock[]).flatMap(dim => {
    const file = ctx.dimensions.find(d => d.name === dim.name)?.path;
    if (!file || !existsSync(file)) return [];
    const at = (name: string) => lineOfName(file, name);
    const errors: LintError[] = [];
    const shape = dim.shape;
    if (shape && shape.force !== 0) {
      errors.push({ file, line: at(refName(shape.ref)), message: `DIMENSION ${dim.name}: AS takes no level — its value is a list of \`${refName(shape.ref)}\`: write \`AS ${refName(shape.ref)}\`` });
    }
    const template = shape ? doc.resolve(shape.ref) as TemplateBlock | null : null;
    if (template && !template.slots) {
      errors.push({ file, line: at(template.name), message: `DIMENSION ${dim.name}: AS \`${template.name}\` is a template without SLOTS — a dimension's value is a list of its instances, so its template declares their fields` });
    }
    return errors;
  })];
}

/**
 * Under `STRATEGY contracts`: a CONTRACT's DOMAIN is one the agent its BY names
 * writes (`WRITES <domain>` — a DOMAIN block, D44); a member some BY names
 * declares `WHEN handed <contract>:` for each such contract, and no LENS-IN —
 * its input is the contract it is handed.
 */
function contractErrors(doc: ApDocument, team: TeamFile, agentName: string, lensInFile: string | null): LintError[] {
  if (team.strategy?.name !== CONTRACTS_STRATEGY) return [];
  const errors: LintError[] = [];
  const at = (line: number | null, message: string) => errors.push({ file: team.path, line: line ?? team.block.startLine, message });
  const writes = (doc.root() as AgentBlock | null)?.writes ?? [];
  for (const c of team.contracts.filter(c => c.domain !== null && c.by.includes(agentName))) {
    if (!writes.includes(c.domain!)) at(c.domainLine, `CONTRACT ${c.name}: DOMAIN \`${c.domain}\` — \`${agentName}\`, its BY, does not write it: give it \`WRITES ${c.domain}\`, or hand the contract to an agent that writes it`);
  }
  const handed = team.contracts.filter(c => c.by.includes(agentName));
  if (handed.length > 0) {
    const root = doc.root();
    const inputs = new Set(doc.nodes().filter(n => n.block === root && n.node.type === 'when').map(n => (n.node as { input?: { target: string } }).input?.target.split('/').pop()).filter(Boolean));
    for (const c of handed) {
      if (!inputs.has(c.name)) at(c.byLine, `BY ${agentName}: \`${agentName}\` declares no \`WHEN handed ${c.name}:\` — the trigger a member starts a contract from`);
    }
    if (lensInFile) errors.push({ file: lensInFile, line: lineOfName(lensInFile, 'LENS-IN'), message: `LENS-IN is not written in a team of contracts — the member's input is the contract it is handed (\`WHEN handed <contract>:\`)` });
  }
  return errors;
}

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
 * Strips H1 and ABOUT from the source. Used by PROJECT.ap and any other
 * top-level standalone file that compiles to plain markdown.
 */
export async function bundleStandaloneToString(
  path: string,
  config: Config,
  opts: { extraLibraryRoots?: string[]; extraLibraries?: Record<string, string>; adapter?: AdapterPlugin } = {},
): Promise<string> {
  const absolute = resolve(path);
  const name = unitNameFromPath(absolute);

  const ctx = makeBundleContext({
    agentName: name,
    libraryRoot: config.libraryRoot,
    libraryRoots: [...libraryRootsOf(config), ...(opts.extraLibraryRoots ?? [])],
    libraries: { ...librariesAliasMap(config), ...(opts.extraLibraries ?? {}) },
    renderings: opts.adapter?.renderings,
  });
  // The file's CONTRACT blocks hand a request to a team: checked here, held by the apx, never rendered.
  const source = ctx.sources.read(absolute);
  const contractBlocks = ctx.sources.tree(absolute).blocks.filter(b => b.key === 'CONTRACT');
  const header = parseStandaloneHeader(contractBlocks.length ? withoutBlocks(source, contractBlocks) : source);
  lintSource(absolute, ctx);

  let body = await resolveInlineBlocks(header.stripped, ctx, absolute);
  if (contractBlocks.length) {
    const index = contractIndexOf(config, dirname(absolute));
    ctx.lintErrors.push(...contractBlockErrors(absolute, contractBlocks), ...projectContractIssues(absolute, readContractBlocks(contractBlocks), index, new Set(ctx.templates.map(t => t.name))));
  }
  ctx.lintErrors.push(...standaloneWithErrors(ctx, absolute, body), ...strayDimensionErrors(ctx, absolute));
  body = `${emitCollectedSections(ctx)}${tidyBlankLines(body)}\n`;
  noExecutableChecks(absolute, ctx);

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
  const bootstrap =
    resolveTeamMembership(agentFilePath) +
    resolveTeamShared(agentFilePath) +
    resolveBundleDefaults(opts.bundleConfig ?? {});

  // The agent file is split into its `EXPORT AGENT` and sibling `EXPORT ROLE`
  // blocks and re-composed as ONE unit — imports prologue, then the inline
  // `ROLE <name>:` block, then the agent body. partitionMetadata does extract +
  // strip in a single lex pass; the adapter later obtains frontmatter via
  // collectFrontmatter(metadata, …).
  // The words of the agent's own file and of its team's file are checked
  // like every import's. A `flows.ap` beside the agent is the retired team file.
  lintSource(agentFilePath, ctx);
  const legacy = legacyTeamIssue(dirname(agentFilePath));
  if (legacy) ctx.lintErrors.push(legacy);
  const teamRoot = teamRootForAgentFile(agentFilePath);
  const teamFile = teamRoot ? readTeamFile(teamRoot, ctx.sources) : null;
  if (teamFile) {
    lintSource(teamFile.path, ctx);
    // The block's own contract (ABOUT, MEMBER, what a team holds) and its roster against the folder.
    ctx.lintErrors.push(...teamBlockErrors(teamFile.path, ctx.sources.tree(teamFile.path).blocks), ...teamRosterIssues(teamFile, opts.contractIndex ?? null));
    // The team's flows travel in every member's document; so do the blocks
    // the team file imports (a step's AS template), or their ids would lead nowhere.
    const imports = teamFile.source.split(/\r?\n/).filter(l => /^IMPORT\s/.test(l)).join('\n');
    if (imports) await expandImports(imports, ctx, teamFile.path);
    // A contract handed to the team from outside brings its form along: the template its file imports.
    if (teamFile.strategy?.name === CONTRACTS_STRATEGY && opts.contractIndex) {
      for (const c of opts.contractIndex.contracts.filter(c => c.team !== teamFile.name && c.by.includes(teamFile.name))) {
        if (c.asImport && !ctx.templates.some(t => t.name === c.as)) await expandImports(c.asImport, ctx, c.file);
      }
    }
  }

  const metadata = new Map<string, string[]>();
  const agentFile = readAgentFile(agentFilePath, ctx.sources);
  const { metadata: fileMeta, stripped } = partitionMetadata(agentFile.unitSource, AGENT_METADATA_KEYWORDS);
  mergeMetadata(metadata, fileMeta);
  // Symmetric to resolveFile: inline `<KIND> <name>:` blocks (the agent's
  // sibling ROLE) end up in the same ctx collections that imported files
  // target. Downstream rendering is identical.
  const agentBody = `${await resolveInlineBlocks(stripped, ctx, agentFilePath)}\n\n`;
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

  const structure = builder.finish(ctx, {
    metadata,
    boundRole,
    agentBody,
    agentFilePath,
    agentSpan: agentFile.span,
    bootstrap,
    vars: variables.constants,
    declaredVars: variables.variables,
    contractIndex: opts.contractIndex ?? null,
  });
  // An ASK without BY goes to the default delegate; the config may set this agent's model.
  const delegate = opts.delegate ?? resolveDelegateConfig(undefined);
  if (Object.values(structure.meta.executors ?? {}).some(e => e.executor === 1 && !e.by)) structure.meta.delegate = delegate.default;
  if (delegate.models[agentName]) structure.meta.model = delegate.models[agentName];
  const declared = new Set(structure.byKind('var').map(b => b.name));
  // Every file sees the bodies' declarations and the implicit constants; an import, only the file that writes it.
  const imported = new Set(ctx.variables.map(v => v.name));
  const everywhere = { constants: opts.vars ?? {}, variables: [...declared].filter(name => !imported.has(name)) };
  const located = (e: { path: string; name: string; line: number | null; message: string; severity?: 'warning' }): LintError =>
    ({ file: e.path, line: e.line ?? lineOfName(e.path, e.name), message: e.message, ...(e.severity ? { severity: e.severity } : {}) });
  reportIssues([
    ...unresolvedErrors(builder.unresolved),
    ...withProblemErrors(builder.withProblems),
    ...unappliedErrors(ctx, builder.withNamed, true),
    ...storeErrors(structure, ctx, agentFilePath),
    ...dimensionErrors(structure, ctx),
    ...perimeterErrors(structure, agentFilePath),
    ...domainFileErrors(ctx),
    ...(teamFile ? contractErrors(structure, teamFile, agentName, agentFile.info.lensIn ? agentFilePath : null) : []),
    ...builder.varErrors.map(located),
    ...builder.checkIssues.map(located),
    ...(opts.agentIndex ? askTargetErrors(structure, opts.agentIndex, teamRoot ? basename(teamRoot) : null) : []),
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
    skill: agentFile.info.skill,
    agentFile: agentFilePath,
  };
}
