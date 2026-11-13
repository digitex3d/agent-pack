// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { refSuffix, introOf, FORMULAS, fill } from './formulas.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureMdBlock, type MdBlockResult } from './services/mdBlock.js';
import { partitionMetadata } from './services/text.js';
import {
  makeBundleContext,
  resolveInlineBlocks,
  emitCollectedSections,
  postProcessBody,
  reportLintIssues,
  lintSource,
  strayDimensionErrors,
} from './compiler/index.js';
import { checkedHeadIssues, lineOfName, teamFileErrors, type LintError } from './lint.js';
import { readMainFile, type MainFile } from './services/mainMetadata.js';
import type { UnitSection } from './apx/payload.js';
import type { Config } from './config.js';
import { AGENTS_MD } from './projectContext.js';
import { apxCommand } from './apx/paths.js';
import { resolveReads, constantOf } from './vars.js';
import { importedVariables, type ImportedVariable } from './exportedVars.js';
import { varCommand } from '../adapters/md/phrases.js';
import type { BundleContext } from './dispatch/index.js';
import { parseBlocks } from './parseBlocks.js';
import { buildRoleIndex, resolveRole, roleHolders, ambiguousRoleMessage, type RoleIndex } from './roleIndex.js';
import { DELEGATION_VERBS, ASYNC_MARK } from './delegation.js';
import { escapeRegex } from './lexer.js';
import {
  type AgentInfo,
  readTeamMembers,
  readTeamFile,
  teamRosterIssues,
  type TeamIssue,
  type TeamFile,
  readAgentInfos,
  findAgentFiles,
  agentNameOf,
} from './services/teamMetadata.js';

/** The line-level grammar of an `ABOUT …` declaration — stripped from routing bodies. */
const ABOUT_LINE_RE = /^ABOUT[ \t]+(.+?)[ \t]*$/m;

/**
 * Compose the `Orchestration` block of `AGENTS.md`.
 *
 * Reuses the standard bundle pipeline (`expandImports` + `postProcessBody`
 * + `emitCollectedSections`) so this section follows the same import,
 * substitution, force-level and chapter-rendering rules as every agent
 * bundle. Concretely:
 *
 *   - The `team` kind introduction (formulas.json) goes through the same
 *     pipeline as an agent body.
 *
 *   - Per-team TEAM-block bodies go through the same pipeline so `IF/ELSE`
 *     and `BY` are processed identically.
 *
 *   - The composed result lives in a single `<!-- agent-pack:orchestration -->`
 *     managed block, idempotent via `ensureMdBlock`.
 *
 * Discovery is by filesystem walk (per S8):
 *   - `agents/standalone/<name>.ap`        → standalone agents (EXPORT AGENT)
 *   - `agents/teams/<X>/<X>.ap` (EXPORT TEAM) → team purpose + routing
 *   - `agents/teams/<X>/<name>.ap`         → team members (EXPORT AGENT)
 */

export interface OrchestrationSectionOptions {
  cwd: string;
  /** Directory containing standalone agent files. Defaults to `<cwd>/agents/standalone`. */
  standaloneAgentsDir?: string;
  /** Root directory that contains team sub-directories. Defaults to `<cwd>/agents/teams`. */
  teamsDir?: string;
  /** Output file. Defaults to `<cwd>/AGENTS.md`. */
  filePath?: string;
  /** Extra library roots searched for IMPORTs declared in a team's file (project libraries). */
  libraryRoots?: string[];
  /** Named library aliases (e.g. `@main`) for IMPORTs declared in a team's file. */
  libraries?: Record<string, string>;
  /** Project config. */
  config?: Config;
  /**
   * Harness-native enum renderings for the flow chapter's context-modes legend;
   * absent = neutral prose (AGENTS.md is read by every harness).
   */
  renderings?: Record<string, Record<string, string>>;
  /** One team alone: the text its own apx prints — its flows and its routing, compiled with nothing of the other teams. */
  team?: string;
}

export interface OrchestrationSectionResult extends MdBlockResult {
  standalones: string[];
  teams: string[];
  /** What the orchestration holds — the main's section names it (src/apx/payload.ts UnitSection). */
  held: Pick<UnitSection, 'teams' | 'members'>;
  /** The orchestration block as written. */
  content: string;
}


const H1_LINE_RE = /^#\s+.+$/m;

interface TeamInfo {
  name: string;
  about: string;
  members: AgentInfo[];
  routingBody: string;
}

/** Build a fresh `BundleContext` for the orchestration section, over the project libraries. */
function makeOrchestrationContext(opts: OrchestrationSectionOptions): BundleContext {
  const libraryRoots = opts.libraryRoots ?? [];
  return makeBundleContext({
    agentName: '__orchestration__',
    libraryRoot: libraryRoots[0] ?? '',
    libraryRoots,
    libraries: opts.libraries ?? {},
    renderings: opts.renderings,
    // A checked condition in a DELEGATE block names its agent's check — only when a judge is configured.
    checks: opts.config?.checks ?? null,
  });
}

/** Pipeline: strip H1+ABOUT → resolve imports + inline blocks → post-process body. */
async function processSource(rawBody: string, ctx: BundleContext, sourcePath = '<orchestration>'): Promise<string> {
  const stripped = rawBody.replace(H1_LINE_RE, '').replace(ABOUT_LINE_RE, '').replace(/^\n+/, '');
  const expanded = await resolveInlineBlocks(stripped, ctx, sourcePath);
  return postProcessBody(expanded, ctx).trim();
}

interface TeamRaw {
  name: string;
  about: string;
  members: AgentInfo[];
  /** Routing body (WHEN/RUN) with FLOW definitions already stripped into the shared ctx. */
  routingRaw: string;
  /** The team's file — where its flows, and the variables they import, come from. */
  teamPath: string;
  /** The variables its file imports — the team's own. */
  variables: ImportedVariable[];
  team: TeamFile;
}

/** A team's file, read and parsed exactly once. */
interface TeamSource {
  teamName: string;
  teamDir: string;
  teamPath: string;
  about: string;
  /** The team as the pipeline reads it (TeamFile.unit): its block's lines at the top, numbers kept. */
  source: string;
  /** The blocks of `source` — fed to the RoleIndex. */
  blocks: ReturnType<typeof parseBlocks>['blocks'];
  /** The team file, read once. */
  team: TeamFile;
}

/**
 * Walk `teamsRoot` once, reading and parsing each team's file a single time.
 * The parsed blocks feed the role→agent RoleIndex; the unit source feeds
 * routing collection. One walk, one read, one parse per file. A roster that
 * does not match its agent files is an issue handed to `fail`.
 */
function readTeamFiles(teamsRoot: string, fail: (issue: TeamIssue) => void): TeamSource[] {
  if (!existsSync(teamsRoot)) return [];
  const out: TeamSource[] = [];
  for (const teamName of readdirSync(teamsRoot).sort()) {
    const teamDir = resolve(teamsRoot, teamName);
    if (!statSync(teamDir).isDirectory()) continue;
    const team = readTeamFile(teamDir);
    if (!team) continue;
    for (const issue of [...teamFileErrors(team.path, team.source), ...teamRosterIssues(team)]) fail(issue);
    const source = team.unit;
    out.push({ teamName, teamDir, teamPath: team.path, about: team.about, source, blocks: parseBlocks(source).blocks, team });
  }
  return out;
}

/**
 * A team's `{{…}}` reads as AGENTS.md renders them — the variables its file
 * imports: a constant's read is its value, a variable's how to read it with
 * the team's apx, which holds the team's document. Any other read stays as written. Applied to the
 * rendered text: a checked head's id is the condition as written.
 */
function teamReads(team: TeamRaw): (text: string) => string {
  const { constants, variables: declared } = importedVariables(team.variables, {});
  const variables = new Set(declared.map(variable => variable.name));
  const varFormulas = FORMULAS.keywords.VAR;
  return text => resolveReads(text, read => {
    if (read.template) return undefined;
    const value = constantOf(constants, read.name);
    if (value !== undefined) return value;
    return variables.has(read.name) ? fill(varFormulas.read, { name: read.name, command: varCommand(apxCommand(team.name), 'get', read.name) }) : undefined;
  });
}

/** The rendered Flows chapter, each flow's section with the reads of the team that declares it. */
function renderFlowReads(chapters: string, ctx: BundleContext, readsOf: Map<string, (text: string) => string>): string {
  return chapters.split(/^(?=## )/m).map(section => {
    const name = /^## `([^`]+)`/.exec(section)?.[1];
    const path = name ? ctx.flows.find(flow => flow.name === name)?.path : undefined;
    const reads = path ? readsOf.get(path) : undefined;
    return reads ? reads(section) : section;
  }).join('');
}

/**
 * Collect every team's file into the SHARED orchestration context. Each
 * file's top-level FLOW blocks are extracted into `ctx.flows` (so they render
 * once, numbered, in the single shared Flows chapter — like procedures and
 * templates), and the remaining routing body (WHEN/RUN) is returned raw. It is
 * post-processed later, after the chapter has assigned each flow its `(id)`, so
 * `RUN <flow>` resolves to a numbered cross-reference instead of being inlined.
 *
 * Builds the role→agent RoleIndex from the already-parsed blocks of the same
 * files, so `BY <role>` resolves with one walk/read/parse per file. The
 * variables a team's file imports are that team's alone: each team's
 * imports register in a list of its own.
 */
async function collectTeams(teamsRoot: string, ctx: BundleContext, wanted: (team: string) => boolean): Promise<{ teams: TeamRaw[]; roster: { name: string; members: AgentInfo[] }[] }> {
  const files = readTeamFiles(teamsRoot, issue => ctx.lintErrors.push(issue));

  // Walk every team's members up front so their directory-anchored `AS <role>`
  // bindings feed the RoleIndex — that is what lets `BY <role>` resolve to a
  // directory-anchored agent, not only to an inline `AGENT … AS …` block.
  const membersByTeam = new Map<string, AgentInfo[]>(
    files.map(teamFile => [teamFile.teamName, readTeamMembers(teamFile.teamDir)]),
  );
  const bindings = [...membersByTeam.values()].flat()
    .filter(agent => agent.roles.length > 0)
    .map(agent => ({ name: agent.name, roles: agent.roles }));

  const roleIndex = buildRoleIndex(
    ...files.map(teamFile => ({ blocks: teamFile.blocks, anchor: 'directory' as const })),
    { bindings, anchor: 'directory' as const },
  );
  const agentNames = new Set([...membersByTeam.values()].flat().map(agent => agent.name));
  // A step may also name a team: it carries the step out by its own routing.
  const byNames = new Set([...agentNames, ...files.map(teamFile => teamFile.teamName)]);

  const index: TeamIndex = { roleIndex, byNames, agentNames, membersByTeam };
  const out: TeamRaw[] = [];
  for (const file of files.filter(teamFile => wanted(teamFile.team.name))) out.push(await collectTeam(file, index, ctx));
  ctx.variables = [];
  return { teams: out, roster: files.map(teamFile => ({ name: teamFile.team.name, members: membersByTeam.get(teamFile.teamName) ?? [] })) };
}

/** What every team's compilation reads of all the teams: who plays which role, the names a `BY` may give, each team's members. */
interface TeamIndex {
  roleIndex: RoleIndex;
  byNames: Set<string>;
  agentNames: ReadonlySet<string>;
  membersByTeam: ReadonlyMap<string, AgentInfo[]>;
}

/** Compile one team's file into the shared ctx: its routing kept raw, its flows, templates and imports collected. */
async function collectTeam(file: TeamSource, index: TeamIndex, ctx: BundleContext): Promise<TeamRaw> {
  const { teamName, teamDir, teamPath, about, source, team } = file;
  const { roleIndex, byNames, agentNames, membersByTeam } = index;
  lintSource(teamPath, ctx);
  const raw = resolveByLines(
    source,
    roleIndex,
    byNames,
    (msg, line) => ctx.lintErrors.push({ file: teamPath, line, message: msg }),
  );
  // Its checked heads as AGENTS.md renders them: a DELEGATE block's are its agent's, the routing's no one's.
  ctx.lintErrors.push(...checkedHeadIssues(teamPath, raw, ctx.checks, by => (agentNames.has(by) ? by : null)));
  // `LENS-IN <agent> <template>` — the member's default input shape, declared
  // team-side and rendered into the members list for orchestrator discovery.
  const { metadata: lensMeta, stripped: noLensIn } = partitionMetadata(raw, ['LENS-IN']);
  const lensIn = new Map<string, string>();
  for (const decl of lensMeta.get('LENS-IN') ?? []) {
    const match = decl.trim().match(/^(\S+)\s+(\S+)$/);
    if (!match) throw new Error(`${teamPath}: malformed LENS-IN "${decl}" — expected \`LENS-IN <agent> <template>\``);
    lensIn.set(match[1], match[2]);
  }
  const stripped = noLensIn.replace(H1_LINE_RE, '').replace(ABOUT_LINE_RE, '').replace(/^\n+/, '');
  const members = (membersByTeam.get(teamName) ?? [])
    .map(agent => ({ ...agent, lensIn: lensIn.get(agent.name) ?? agent.lensIn }));
  for (const name of lensIn.keys()) {
    if (!members.some(agent => agent.name === name)) {
      throw new Error(`${teamPath}: LENS-IN names unknown member "${name}"`);
    }
  }
  await hoistLensInTemplates(teamDir, members, ctx);
  ctx.variables = [];
  const dimensions = ctx.dimensions.length;
  const routingRaw = await resolveInlineBlocks(stripped, ctx, teamPath);
  ctx.lintErrors.push(...strayDimensionErrors(ctx, teamPath, dimensions));
  // What the team file imports itself — imports never pass on. A team shares constants
  // and SESSION variables: a private one would be each member's own.
  const variables = ctx.variables.filter(variable => variable.importers.includes(teamPath));
  for (const variable of variables) {
    if (variable.decl.form === 'variable' && variable.decl.scope === 'private') {
      ctx.lintErrors.push({ file: teamPath, line: lineOfName(teamPath, variable.name, 'import'), message: `IMPORT ${variable.name}: \`${variable.name}\` is a private variable — each member would have its own; a team's file imports constants and SESSION variables` });
    }
  }
  return { name: teamName, about, members, routingRaw, teamPath, variables, team };
}

/** The flat agent file under `teamDir` whose `EXPORT AGENT` block name matches `name`. */
function memberFile(teamDir: string, name: string): string | null {
  return findAgentFiles(teamDir).find(file => agentNameOf(file) === name) ?? null;
}

/**
 * Bring each LENS-IN template into the orchestration context so the members
 * list can cite it. The template usually lives inline in the member's own agent
 * file (where it also renders as the agent's input contract) — hoist it from
 * there, or from the library when the member file imports it, together with
 * the closure of templates it references via `<tpl>` / `LIST <tpl>` slots, and
 * nothing else. Templates already present in the context (e.g. defined in
 * the team file) win. The member's own lint errors are its bundle's to report.
 */
async function hoistLensInTemplates(teamDir: string, members: AgentInfo[], ctx: BundleContext): Promise<void> {
  for (const member of members) {
    if (!member.lensIn || ctx.templates.some(template => template.name === member.lensIn)) continue;
    const agentAp = memberFile(teamDir, member.name);
    if (!agentAp || !existsSync(agentAp)) continue;
    const scratch = makeBundleContext({
      agentName: member.name, libraryRoot: ctx.libraryRoot, libraryRoots: ctx.libraryRoots, libraries: ctx.libraries,
    });
    await resolveInlineBlocks(readFileSync(agentAp, 'utf-8'), scratch, agentAp);
    const byName = new Map(scratch.templates.map(template => [template.name, template]));
    const wanted = new Set<string>();
    const queue = [member.lensIn];
    while (queue.length) {
      const name = queue.pop()!;
      if (wanted.has(name) || !byName.has(name)) continue;
      wanted.add(name);
      for (const ref of byName.get(name)!.body.matchAll(/<([a-z][a-z0-9_-]*)>/g)) {
        if (byName.has(ref[1])) queue.push(ref[1]);
      }
    }
    for (const name of wanted) {
      if (!ctx.templates.some(template => template.name === name)) ctx.templates.push(byName.get(name)!);
    }
  }
}

// ---------------------------------------------------------------------------
// Role→agent binding (RoleIndex) — resolve `BY <role>` at bundle time
// ---------------------------------------------------------------------------

// A `BY <name>` line (a CONTRACT's), and the `BY <name>` a DELEGATE or FORK line ends with — before its AS, its colon.
const BY_LINE_RE = /^([ \t]*BY[ \t]+)(\S+)([ \t]*)$/gm;
const DELEGATION_BY_RE = new RegExp(`^([ \\t]*(?:${DELEGATION_VERBS.join('|')})${escapeRegex(ASYNC_MARK)}?[ \\t].*?[ \\t]BY[ \\t]+)([A-Za-z_][\\w-]*)((?:[ \\t]+AS!{0,2}[ \\t]+\\S+)?[ \\t]*:?[ \\t]*)$`, 'gm');

/**
 * Rewrite `BY <role>` to `BY <agent>` using the RoleIndex — on a BY line and
 * at the end of a delegation. A name that resolves to a bound agent (it is a
 * role) is substituted with that agent. A name that is already a known agent
 * or a team is left verbatim. A name that is neither is a dangling routing
 * target — a compile error at its line.
 */
function resolveByLines(
  raw: string,
  index: RoleIndex,
  knownNames: Set<string>,
  fail: (msg: string, line: number) => void,
): string {
  const resolveBy = (text: string, re: RegExp) => text.replace(re, (whole, head: string, name: string, trail: string, offset: number) => {
    const bound = resolveRole(index, name);
    if (bound) return `${head}${bound.name}${trail}`;
    const holders = roleHolders(index, name);
    if (holders.length > 1 && !knownNames.has(name)) {
      fail(`BY ${name}: ${ambiguousRoleMessage(name, holders)}`, text.slice(0, offset).split('\n').length);
      return whole;
    }
    if (knownNames.has(name)) return whole;
    fail(`BY ${name}: no team member, no role bound to one and no team is called \`${name}\``, text.slice(0, offset).split('\n').length);
    return whole;
  });
  return resolveBy(resolveBy(raw, BY_LINE_RE), DELEGATION_BY_RE);
}

/** One agent in the orchestration: name, purpose, and the shape to talk to it in (its LENS-IN). */
function agentLine(member: AgentInfo, ctx: BundleContext): string {
  let line = `- \`${member.name}\` — ${member.about || '(no description)'}`;
  if (member.lensIn) {
    const shape = ctx.templates.find(template => template.name === member.lensIn);
    if (!shape) {
      throw new Error(`LENS-IN: unknown template "${member.lensIn}" for agent "${member.name}" — define it in the agent's file or IMPORT it there`);
    }
    line += ` — talk to it as \`${member.lensIn}\`${refSuffix(shape.refId)}`;
  }
  return line;
}

function renderStandalones(standalones: AgentInfo[], ctx: BundleContext): string {
  if (standalones.length === 0) return '';
  return `## Standalone agents\n\n${standalones.map(agent => agentLine(agent, ctx)).join('\n')}`;
}

function renderTeam(team: TeamInfo, ctx: BundleContext): string {
  const purpose = team.about || '(no description)';
  const members = team.members.length > 0
    ? team.members.map(member => agentLine(member, ctx)).join('\n')
    : '(no members)';
  const routing = team.routingBody || '(no routing declared)';
  return [
    `## Team — ${team.name}`,
    '',
    `\`purpose\`: ${purpose}`,
    '',
    `\`members\`:`,
    members,
    '',
    `\`routing\`:`,
    '',
    routing,
  ].join('\n');
}

/**
 * What the main's TEAMS and MEMBER lines get wrong against the project: a team
 * under MEMBER or an agent under TEAMS, a member of a team under either — it is
 * reached through its team's routing — and a name that is neither; then, as
 * warnings, the teams and standalone agents it lists nowhere: they stay out of it.
 */
function mainRosterIssues(main: MainFile, teams: readonly { name: string; members: readonly AgentInfo[] }[], standalones: readonly AgentInfo[]): LintError[] {
  const issues: LintError[] = [];
  const teamOf = (name: string) => teams.find(team => team.members.some(member => member.name === name))?.name;
  const isTeam = (name: string) => teams.some(team => team.name === name);
  const isStandalone = (name: string) => standalones.some(agent => agent.name === name);
  const check = (listed: readonly { name: string; line: number }[], kind: 'TEAMS' | 'MEMBER') => {
    for (const { name, line } of listed) {
      const team = teamOf(name);
      const message = kind === 'MEMBER' && isTeam(name) ? `\`${name}\` is a team — list it under TEAMS: \`TEAMS ${name}\``
        : kind === 'TEAMS' && isStandalone(name) ? `\`${name}\` is a standalone agent — list it under MEMBER: \`MEMBER ${name}\``
        : team ? `\`${name}\` is a member of the team \`${team}\` — it is reached through its team's routing: list \`${team}\` under TEAMS`
        : (kind === 'TEAMS' ? isTeam(name) : isStandalone(name)) ? null
        : `${kind} names \`${name}\`, which is neither a team nor a standalone agent of the project`;
      if (message) issues.push({ file: main.path, line, message });
    }
  };
  check(main.teams, 'TEAMS');
  check(main.members, 'MEMBER');
  const listed = (name: string) => [...main.teams, ...main.members].some(entry => entry.name === name);
  const line = main.block.startLine;
  for (const team of teams) if (!listed(team.name)) issues.push({ file: main.path, line, severity: 'warning', message: `the team \`${team.name}\` is listed in no TEAMS line of the main — it is left out of it` });
  for (const agent of standalones) if (!listed(agent.name)) issues.push({ file: main.path, line, severity: 'warning', message: `the standalone agent \`${agent.name}\` is listed in no MEMBER line of the main — it is left out of it` });
  return issues;
}

export async function buildOrchestrationContent(opts: OrchestrationSectionOptions): Promise<{
  content: string;
  standalones: string[];
  teams: string[];
  held: Pick<UnitSection, 'teams' | 'members'>;
}> {
  const standaloneAgentsDir = opts.standaloneAgentsDir ?? resolve(opts.cwd, 'agents/standalone');
  const teamsDir = opts.teamsDir ?? resolve(opts.cwd, 'agents/teams');
  const ctx = makeOrchestrationContext(opts);

  // Process the framework intro through the shared pipeline.
  const introBody = await processSource(introOf('team'), ctx);

  // A team's own text holds that team alone; the orchestration, what the main lists — every team and agent with no main.
  const main = opts.team ? null : readMainFile(opts.cwd);
  const found = opts.team ? [] : readAgentInfos(standaloneAgentsDir);
  const wanted = (team: string): boolean => (opts.team ? team === opts.team : !main || main.teams.some(entry => entry.name === team));

  // Phase 1: collect the wanted teams' FLOWs into the shared ctx (routing kept
  // raw, with `BY <role>` resolved against the RoleIndex built from the same
  // single walk/read/parse of every team's file).
  const { teams: teamRaws, roster } = await collectTeams(teamsDir, ctx, wanted);
  // With a main, what it lists is what the project holds: its TEAMS and its MEMBER lines.
  if (main) ctx.lintErrors.push(...mainRosterIssues(main, roster, found));
  const standalones = main ? found.filter(agent => main.members.some(member => member.name === agent.name)) : found;
  await hoistLensInTemplates(standaloneAgentsDir, standalones, ctx);
  const readsOf = new Map(teamRaws.map(teamRaw => [teamRaw.teamPath, teamReads(teamRaw)]));

  reportLintIssues(ctx, 'Orchestration section');

  // Phase 2: emit the shared chapters (Flows),
  // stamping each flow id so RUN references can resolve to `(id)`. Post-process
  // the emitted chapters (as the agent pipeline does) so STEP/DO/DELEGATE in
  // flow bodies and force-levels in the chapter intros render to prose.
  // A checked condition of a flow is the team's, whose apx holds the flow.
  const teamOfAgent = new Map(teamRaws.flatMap(teamRaw => teamRaw.members.map(member => [member.name, teamRaw.name] as const)));
  ctx.unitOf = agent => teamOfAgent.get(agent);
  const chapters = renderFlowReads(postProcessBody(emitCollectedSections(ctx), ctx).trim(), ctx, readsOf);
  ctx.unitOf = undefined;

  // Phase 3: post-process each team's routing against the now-stamped ctx, so
  // `RUN <flow>` renders as `Run the flow \`<name>\` (id)` — with the command
  // that says how to run it: `apx flow <id>` of the team, whose apx carries
  // its flows (and knows whether this harness runs them as scripts).
  const teams: TeamInfo[] = teamRaws.map(teamRaw => {
    ctx.flowCommand = id => apxCommand(teamRaw.name, 'flow', id);
    const routingBody = readsOf.get(teamRaw.teamPath)!(postProcessBody(teamRaw.routingRaw, ctx)).trim().replace(/\n{3,}/g, '\n\n');
    ctx.flowCommand = undefined;
    return { name: teamRaw.name, about: teamRaw.about, members: teamRaw.members, routingBody };
  });

  // A team's own text — what its apx prints — is its flows and its routing; the main's adds the orchestration.
  const parts: string[] = opts.team ? [chapters, ...teams.map(team => renderTeam(team, ctx))] : [
    chapters,
    `# Orchestration\n\n${introBody}`,
    renderStandalones(standalones, ctx),
    ...teams.map(team => renderTeam(team, ctx)),
  ];

  return {
    content: parts.filter(Boolean).map(part => part.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    standalones: standalones.map(agent => agent.name),
    teams: teams.map(team => team.name),
    held: {
      teams: teams.map(team => ({ name: team.name, about: team.about, members: team.members.map(member => member.name) })),
      members: standalones.map(agent => ({ name: agent.name, about: agent.about })),
    },
  };
}

export async function ensureOrchestrationSection(opts: OrchestrationSectionOptions): Promise<OrchestrationSectionResult> {
  const { content, standalones, teams, held } = await buildOrchestrationContent(opts);
  const filePath = opts.filePath ?? resolve(opts.cwd, AGENTS_MD);
  const result = ensureMdBlock({ filePath, key: 'orchestration', content });
  return { ...result, standalones, teams, held, content };
}
