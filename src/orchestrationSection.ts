// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { refSuffix, introOf } from './formulas.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { ensureMdBlock, MdBlockResult } from './services/mdBlock.js';
import { partitionMetadata } from './services/text.js';
import {
  makeBundleContext,
  resolveInlineBlocks,
  emitCollectedSections,
  postProcessBody,
  reportLintIssues,
  lintSource,
} from './compiler/index.js';
import { checkedHeadIssues } from './lint.js';
import { Config } from './config.js';
import { AGENTS_MD } from './projectContext.js';
import { apxCommand } from './apx/paths.js';
import { BundleContext } from './dispatch/index.js';
import { parseBlocks } from './parseBlocks.js';
import { buildRoleIndex, resolveRole, RoleIndex } from './roleIndex.js';
import {
  AgentInfo,
  readTeamMembers,
  readTeamPurpose,
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
 *   - Per-team `flows.ap` bodies go through the same pipeline so `IF/ELSE`
 *     and `BY` are processed identically.
 *
 *   - The composed result lives in a single `<!-- agent-pack:orchestration -->`
 *     managed block, idempotent via `ensureMdBlock`.
 *
 * Discovery is by filesystem walk (per S8):
 *   - `agents/standalone/<name>.ap`        → standalone agents (EXPORT AGENT)
 *   - `agents/teams/<X>/flows.ap`          → team purpose + routing
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
  /** Extra library roots searched for IMPORTs declared in flows.ap (project libraries). */
  libraryRoots?: string[];
  /** Named library aliases (e.g. `@main`) for IMPORTs declared in flows.ap. */
  libraries?: Record<string, string>;
  /** Project config. */
  config?: Config;
  /**
   * Harness-native enum renderings for the flow chapter's context-modes legend;
   * absent = neutral prose (AGENTS.md is read by every harness).
   */
  renderings?: Record<string, Record<string, string>>;
}

export interface OrchestrationSectionResult extends MdBlockResult {
  standalones: string[];
  teams: string[];
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
    // A checked condition in a step names its BY agent's check — only when a judge is configured.
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
}

/** A team's `flows.ap`, read and parsed exactly once. */
interface TeamFile {
  teamName: string;
  teamDir: string;
  flowsAp: string;
  source: string;
  /** Top-level blocks parsed from `source` — fed to the RoleIndex. */
  blocks: ReturnType<typeof parseBlocks>['blocks'];
}

/**
 * Walk `teamsRoot` once, reading and parsing each team's `flows.ap` a single
 * time. The parsed blocks feed the role→agent RoleIndex; the raw source
 * feeds routing collection. One walk, one read, one parse per file.
 */
function readTeamFiles(teamsRoot: string): TeamFile[] {
  if (!existsSync(teamsRoot)) return [];
  const out: TeamFile[] = [];
  for (const teamName of readdirSync(teamsRoot).sort()) {
    const teamDir = resolve(teamsRoot, teamName);
    if (!statSync(teamDir).isDirectory()) continue;
    const flowsAp = resolve(teamDir, 'flows.ap');
    if (!existsSync(flowsAp)) continue;
    const source = readFileSync(flowsAp, 'utf-8');
    out.push({ teamName, teamDir, flowsAp, source, blocks: parseBlocks(source).blocks });
  }
  return out;
}

/**
 * Collect every team's `flows.ap` into the SHARED orchestration context. Each
 * file's top-level FLOW blocks are extracted into `ctx.flows` (so they render
 * once, numbered, in the single shared Flows chapter — like procedures and
 * templates), and the remaining routing body (WHEN/RUN) is returned raw. It is
 * post-processed later, after the chapter has assigned each flow its `(id)`, so
 * `RUN <flow>` resolves to a numbered cross-reference instead of being inlined.
 *
 * Builds the role→agent RoleIndex from the already-parsed blocks of the same
 * files, so `BY <role>` resolves with one walk/read/parse per file.
 */
async function collectTeams(teamsRoot: string, ctx: BundleContext): Promise<TeamRaw[]> {
  const files = readTeamFiles(teamsRoot);

  // Walk every team's members up front so their directory-anchored `AS <role>`
  // bindings feed the RoleIndex — that is what lets `BY <role>` resolve to a
  // directory-anchored agent, not only to an inline `AGENT … AS …` block.
  const membersByTeam = new Map<string, AgentInfo[]>(
    files.map(f => [f.teamName, readTeamMembers(f.teamDir)]),
  );
  const bindings = [...membersByTeam.values()].flat()
    .filter((a): a is AgentInfo & { role: string } => Boolean(a.role))
    .map(a => ({ name: a.name, role: a.role }));

  const roleIndex = buildRoleIndex(
    ...files.map(f => ({ blocks: f.blocks, anchor: 'directory' as const })),
    { bindings, anchor: 'directory' as const },
  );
  const agentNames = new Set([...membersByTeam.values()].flat().map(a => a.name));

  const out: TeamRaw[] = [];
  for (const { teamName, teamDir, flowsAp, source } of files) {
    lintSource(flowsAp, ctx);
    const raw = resolveByLines(
      source,
      roleIndex,
      agentNames,
      (msg, line) => ctx.lintErrors.push({ file: flowsAp, line, message: msg }),
    );
    // Its checked heads as AGENTS.md renders them: a step's is its BY agent's, the routing's no one's.
    ctx.lintErrors.push(...checkedHeadIssues(flowsAp, raw, ctx.checks, by => (agentNames.has(by) ? by : null)));
    // `LENS-IN <agent> <template>` — the member's default input shape, declared
    // team-side and rendered into the members list for orchestrator discovery.
    const { metadata: lensMeta, stripped: noLensIn } = partitionMetadata(raw, ['LENS-IN']);
    const lensIn = new Map<string, string>();
    for (const decl of lensMeta.get('LENS-IN') ?? []) {
      const m = decl.trim().match(/^(\S+)\s+(\S+)$/);
      if (!m) throw new Error(`${flowsAp}: malformed LENS-IN "${decl}" — expected \`LENS-IN <agent> <template>\``);
      lensIn.set(m[1], m[2]);
    }
    const stripped = noLensIn.replace(H1_LINE_RE, '').replace(ABOUT_LINE_RE, '').replace(/^\n+/, '');
    const members = (membersByTeam.get(teamName) ?? [])
      .map(a => ({ ...a, lensIn: lensIn.get(a.name) ?? a.lensIn }));
    for (const name of lensIn.keys()) {
      if (!members.some(a => a.name === name)) {
        throw new Error(`${flowsAp}: LENS-IN names unknown member "${name}"`);
      }
    }
    await hoistLensInTemplates(teamDir, members, ctx);
    out.push({
      name: teamName,
      about: readTeamPurpose(teamDir),
      members,
      routingRaw: await resolveInlineBlocks(stripped, ctx, flowsAp),
    });
  }
  return out;
}

/** The flat agent file under `teamDir` whose `EXPORT AGENT` block name matches `name`. */
function memberFile(teamDir: string, name: string): string | null {
  return findAgentFiles(teamDir).find(f => agentNameOf(f) === name) ?? null;
}

/**
 * Bring each LENS-IN template into the orchestration context so the members
 * list can cite it. The template usually lives inline in the member's own agent
 * file (where it also renders as the agent's input contract) — hoist it from
 * there, or from the library when the member file imports it, together with
 * the closure of templates it references via `<tpl>` / `LIST <tpl>` slots, and
 * nothing else. Templates already present in the context (e.g. defined in
 * flows.ap) win. The member's own lint errors are its bundle's to report.
 */
async function hoistLensInTemplates(teamDir: string, members: AgentInfo[], ctx: BundleContext): Promise<void> {
  for (const m of members) {
    if (!m.lensIn || ctx.templates.some(t => t.name === m.lensIn)) continue;
    const agentAp = memberFile(teamDir, m.name);
    if (!agentAp || !existsSync(agentAp)) continue;
    const scratch = makeBundleContext({
      agentName: m.name, libraryRoot: ctx.libraryRoot, libraryRoots: ctx.libraryRoots, libraries: ctx.libraries,
    });
    await resolveInlineBlocks(readFileSync(agentAp, 'utf-8'), scratch, agentAp);
    const byName = new Map(scratch.templates.map(t => [t.name, t]));
    const wanted = new Set<string>();
    const queue = [m.lensIn];
    while (queue.length) {
      const name = queue.pop()!;
      if (wanted.has(name) || !byName.has(name)) continue;
      wanted.add(name);
      for (const ref of byName.get(name)!.body.matchAll(/<([a-z][a-z0-9_-]*)>/g)) {
        if (byName.has(ref[1])) queue.push(ref[1]);
      }
    }
    for (const name of wanted) {
      if (!ctx.templates.some(t => t.name === name)) ctx.templates.push(byName.get(name)!);
    }
  }
}

// ---------------------------------------------------------------------------
// Role→agent binding (RoleIndex) — resolve `BY <role>` at bundle time
// ---------------------------------------------------------------------------

const BY_LINE_RE = /^([ \t]*)BY[ \t]+(\S+)([ \t]*)$/gm;

/**
 * Rewrite `BY <role>` lines to `BY <agent>` using the RoleIndex. A name that
 * resolves to a bound agent (it is a role) is substituted with that agent. A
 * name that is already a known agent is left verbatim. A name that is neither is
 * a dangling routing target — a compile error at its line.
 */
function resolveByLines(
  raw: string,
  index: RoleIndex,
  agentNames: Set<string>,
  fail: (msg: string, line: number) => void,
): string {
  return raw.replace(BY_LINE_RE, (whole, indent: string, name: string, trail: string, offset: number) => {
    const bound = resolveRole(index, name);
    if (bound) return `${indent}BY ${bound.name}${trail}`;
    if (agentNames.has(name)) return whole;
    fail(`BY ${name}: no team member and no role bound to one is called \`${name}\``, raw.slice(0, offset).split('\n').length);
    return whole;
  });
}

/** One agent in the orchestration: name, purpose, and the shape to talk to it in (its LENS-IN). */
function agentLine(m: AgentInfo, ctx: BundleContext): string {
  let line = `- \`${m.name}\` — ${m.about || '(no description)'}`;
  if (m.lensIn) {
    const shape = ctx.templates.find(t => t.name === m.lensIn);
    if (!shape) {
      throw new Error(`LENS-IN: unknown template "${m.lensIn}" for agent "${m.name}" — define it in the agent's file or IMPORT it there`);
    }
    line += ` — talk to it as \`${m.lensIn}\`${refSuffix(shape.refId)}`;
  }
  return line;
}

function renderStandalones(standalones: AgentInfo[], ctx: BundleContext): string {
  if (standalones.length === 0) return '';
  return `## Standalone agents\n\n${standalones.map(a => agentLine(a, ctx)).join('\n')}`;
}

function renderTeam(team: TeamInfo, ctx: BundleContext): string {
  const purpose = team.about || '(no description)';
  const members = team.members.length > 0
    ? team.members.map(m => agentLine(m, ctx)).join('\n')
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

export async function buildOrchestrationContent(opts: OrchestrationSectionOptions): Promise<{
  content: string;
  standalones: string[];
  teams: string[];
}> {
  const standaloneAgentsDir = opts.standaloneAgentsDir ?? resolve(opts.cwd, 'agents/standalone');
  const teamsDir = opts.teamsDir ?? resolve(opts.cwd, 'agents/teams');
  const ctx = makeOrchestrationContext(opts);

  // Process the framework intro through the shared pipeline.
  const introBody = await processSource(introOf('team'), ctx);

  const standalones = readAgentInfos(standaloneAgentsDir);
  await hoistLensInTemplates(standaloneAgentsDir, standalones, ctx);

  // Phase 1: collect every team's FLOWs into the shared ctx (routing kept raw,
  // with `BY <role>` resolved against the RoleIndex built from the same
  // single walk/read/parse of each team's flows.ap).
  const teamRaws = await collectTeams(teamsDir, ctx);

  reportLintIssues(ctx, 'Orchestration section');

  // Phase 2: emit the shared chapters (Flows),
  // stamping each flow id so RUN references can resolve to `(id)`. Post-process
  // the emitted chapters (as the agent pipeline does) so STEP/BY/DO/CONTEXT in
  // flow bodies and force-levels in the chapter intros render to prose.
  const chapters = postProcessBody(emitCollectedSections(ctx), ctx).trim();

  // Phase 3: post-process each team's routing against the now-stamped ctx, so
  // `RUN <flow>` renders as `Run the flow \`<name>\` (id)` — with the command
  // that says how to run it: `apx flow <id>` of a member, whose apx carries
  // the team's flows (and knows whether this harness runs them as scripts).
  const teams: TeamInfo[] = teamRaws.map(t => {
    const member = t.members[0]?.name;
    ctx.flowCommand = member ? id => apxCommand(member, 'flow', id) : undefined;
    const routingBody = postProcessBody(t.routingRaw, ctx).trim().replace(/\n{3,}/g, '\n\n');
    ctx.flowCommand = undefined;
    return { name: t.name, about: t.about, members: t.members, routingBody };
  });

  const parts: string[] = [
    chapters,
    `# Orchestration\n\n${introBody}`,
    renderStandalones(standalones, ctx),
    ...teams.map(t => renderTeam(t, ctx)),
  ];

  return {
    content: parts.filter(Boolean).map(p => p.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim(),
    standalones: standalones.map(a => a.name),
    teams: teams.map(t => t.name),
  };
}

export async function ensureOrchestrationSection(opts: OrchestrationSectionOptions): Promise<OrchestrationSectionResult> {
  const { content, standalones, teams } = await buildOrchestrationContent(opts);
  const filePath = opts.filePath ?? resolve(opts.cwd, AGENTS_MD);
  const result = ensureMdBlock({ filePath, key: 'orchestration', content });
  return { ...result, standalones, teams };
}
