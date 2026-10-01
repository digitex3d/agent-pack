// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { parseAgentSignature } from '../definitionArgs.js';
import { exportedBlockBodies, nonExportedSource, nonExportedLines, extractAbout, extractPrimitive, ExportedBlockBody } from './text.js';
import { SourceRegistry, type SourceSpan } from '../sources.js';

/**
 * The single reader for team/agent metadata pulled straight from `.ap` source.
 *
 * An agent is a flat `.ap` file holding an `EXPORT AGENT <name> AS <role>:`
 * block (sibling of the team's `flows.ap` / `team.ap`, or under
 * `agents/standalone/`). Everything about the agent — its canonical name, ABOUT,
 * role binding, default input shape, and its own behavioural rules — is read
 * from that block. The optional sibling `EXPORT ROLE` block carries the craft.
 *
 * Built on `parseBlocks` via {@link exportedBlockBodies}: there is exactly ONE
 * parse path and ONE discovery walk. The name is canonical from the block; the
 * filename is convention only.
 */

/** Filename of a team's routing/purpose source, sibling of its member files. */
export const TEAM_FLOWS_FILE = 'flows.ap';

/** The standalone agents folder under the agents root: `<agentsDir>/standalone`. */
export function standaloneDir(agentsDir: string): string {
  return resolve(agentsDir, 'standalone');
}

export interface AgentInfo {
  /** Canonical name, from the `EXPORT AGENT <name>` block header. */
  name: string;
  about: string;
  /**
   * Default input shape (template name). The agent may declare its own via
   * `LENS-IN <template>` in its block; the team-side `LENS-IN <agent> <template>`
   * override in flows.ap is layered on top by the orchestration reader and wins.
   */
  lensIn?: string;
  /** Role this agent binds via the `AS <role>` header signature. */
  role?: string;
}

/** A flat agent file, read once into its orchestration metadata and bundle source. */
export interface AgentFile {
  /** Absolute path of the agent `.ap` file. */
  path: string;
  /** Orchestration-facing metadata (canonical name, about, role, lensIn). */
  info: AgentInfo;
  /**
   * The file rewritten into the legacy-equivalent shape the bundle pipeline
   * expects, without flattening the two exported blocks together:
   *   - the `EXPORT AGENT <name> AS <role>:` block becomes file-top metadata
   *     (`AS <role>` synthesized from the header) + the agent's own
   *     ALWAYS/NEVER/MUST/WHEN body, de-indented to column 0;
   *   - the sibling `EXPORT ROLE <name>:` block becomes a bare inline
   *     `ROLE <name>:` block (EXPORT dropped) so `extractInlineDefinitions`
   *     collects it into `ctx.roles`;
   *   - the import prologue and any non-exported top-level workflow blocks
   *     (TEMPLATE/PROCEDURE/WHEN) pass through verbatim.
   * One unit, processed by the same metadata/inline pipeline a built-in agent
   * directory's files take.
   */
  unitSource: string;
  /**
   * Where the agent block's text was written: the lines kept by
   * {@link nonExportedSource}, in order, then the AGENT block's lines — the
   * order the agent's body is composed in. Null when the block is not found.
   */
  span: SourceSpan | null;
}

/** Re-indent a de-indented role body one step so it reads as a `ROLE <name>:` block. */
function asInlineRole(role: ExportedBlockBody): string {
  const body = role.body
    .split(/\r?\n/)
    .map(line => (line.trim() === '' ? '' : `    ${line}`))
    .join('\n');
  return `ROLE ${role.name}:\n${body}`;
}

/**
 * Re-indent any OTHER exported block of an agent file so it reads as an inline
 * declaration — `PROCEDURE <name>:` and its body, one step in.
 *
 * An agent file may declare more than its AGENT and ROLE: a procedure the agent
 * owns is naturally written next to it. Those blocks used to be dropped here in
 * silence — the unit was composed from three pieces and everything else fell on
 * the floor, so the procedure existed in source, appeared in no bundle, and the
 * only hint was an unrelated warning about an unresolved RUN target.
 *
 * They cannot be *imported* from an agent file (it is not a library), and that
 * stays true. But they must be visible in the agent's own scope, which is what
 * declaring them there means.
 */
function asInlineDeclaration(block: ExportedBlockBody): string {
  const body = block.body
    .split(/\r?\n/)
    .map(line => (line.trim() === '' ? '' : `    ${line}`))
    .join('\n');
  const head = block.rest ? `${block.key} ${block.name} ${block.rest}` : `${block.key} ${block.name}`;
  return `${head}:\n${body}`;
}

/** The AGENT block body prefixed with its header `AS <role>` binding as a top-level line. */
function asAgentBody(agent: ExportedBlockBody): string {
  const role = parseAgentSignature(agent.rest).role;
  return role ? `AS ${role}\n${agent.body}` : agent.body;
}

/**
 * Read a flat agent file into its orchestration metadata and bundle unit. Throws
 * when the file holds no `EXPORT AGENT` block — that block's presence is what
 * defines a flat agent file.
 *
 * Block de-indenting is delegated entirely to {@link exportedBlockBodies} and
 * {@link nonExportedSource} (text.ts owns "how far to de-indent an exported
 * block"); this composes the unit the bundle pipeline consumes:
 *   - the AGENT block → file-top metadata + own rules, with a synthesized
 *     `AS <role>` line;
 *   - the sibling ROLE block → a bare `ROLE <name>:` block so
 *     `extractInlineDefinitions` collects it into `ctx.roles`;
 *   - the prologue (imports) and any non-exported workflow blocks → verbatim.
 * Given a compilation's source registry, the file is read through it.
 */
export function readAgentFile(path: string, sources: SourceRegistry = new SourceRegistry()): AgentFile {
  const source = sources.read(path);
  const blocks = exportedBlockBodies(source);
  const agent = blocks.find(b => b.key === 'AGENT');
  if (!agent) {
    throw new Error(`${path}: no EXPORT AGENT block — a flat agent file must declare one`);
  }
  const role = blocks.find(b => b.key === 'ROLE');

  const info: AgentInfo = {
    name: agent.name,
    about: extractPrimitive(agent.body, 'ABOUT') ?? '',
    role: parseAgentSignature(agent.rest).role ?? undefined,
    lensIn: extractPrimitive(agent.body, 'LENS-IN') ?? undefined,
  };

  // Every exported block that is neither the AGENT nor its ROLE is one the
  // agent declares for itself — kept, inlined, in source order.
  const own = blocks
    .filter(b => b !== agent && b !== role)
    .map(asInlineDeclaration);

  const unitSource = [nonExportedSource(source), role ? asInlineRole(role) : '', ...own, asAgentBody(agent)]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';

  const lines = source.split(/\r?\n/);
  const agentSpan = sources.span(path, 'agent', agent.name);
  const span = agentSpan && {
    ...agentSpan,
    lines: [...nonExportedLines(source).map(line => ({ line, text: lines[line - 1] })), ...agentSpan.lines],
  };

  return { path, info, unitSource, span };
}

/** True when a `.ap` source holds at least one `EXPORT AGENT` block. */
function holdsAgentBlock(source: string): boolean {
  return exportedBlockBodies(source).some(b => b.key === 'AGENT');
}

/**
 * Every flat agent file directly under `dir`: a `*.ap` file holding an
 * `EXPORT AGENT` block. The ONE discovery walk — a standalone agent and a team
 * member are found the same way (a file sibling of `flows.ap` / `team.ap`).
 */
export function findAgentFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.ap')) continue;
    const path = resolve(dir, entry);
    if (!statSync(path).isFile()) continue;
    if (holdsAgentBlock(readFileSync(path, 'utf-8'))) out.push(path);
  }
  return out;
}

/** Every team root directory under `teamsDir`: its direct sub-directories. */
function teamRootsUnder(teamsDir: string): string[] {
  if (!existsSync(teamsDir) || !statSync(teamsDir).isDirectory()) return [];
  return readdirSync(teamsDir)
    .sort()
    .map(team => resolve(teamsDir, team))
    .filter(teamDir => statSync(teamDir).isDirectory());
}

/**
 * Every directory that may hold flat agent files: the standalone folder plus
 * each team root under `teamsDir`. The single source of the discovery dir set,
 * shared by agent-name resolution and the `bundle all` walk so the two never
 * drift. Every flat agent file lives in exactly one of these dirs.
 */
export function agentSearchDirs(agentsDir: string, teamsDir: string): string[] {
  return [standaloneDir(agentsDir), ...teamRootsUnder(teamsDir)];
}

/** Every flat agent file across all search dirs (standalone + team roots). */
export function allAgentFiles(agentsDir: string, teamsDir: string): string[] {
  return agentSearchDirs(agentsDir, teamsDir).flatMap(findAgentFiles);
}

/**
 * Every flat agent file under the user-level (global) home: agents live flat in
 * `<userRoot>/agents` (no `standalone/` tier) plus team members under
 * `<userRoot>/teams/<team>/` — the same layout the fs-agents index exposes as
 * `@user` / `@user-teams`. Empty when `userRoot` is unset (derived configs).
 */
export function allUserAgentFiles(userRoot: string): string[] {
  if (!userRoot) return [];
  const dirs = [resolve(userRoot, 'agents'), ...teamRootsUnder(resolve(userRoot, 'teams'))];
  return dirs.flatMap(findAgentFiles);
}

/** Every agent file under `dir`, read into {@link AgentInfo}. */
export function readAgentInfos(dir: string): AgentInfo[] {
  return findAgentFiles(dir).map(path => readAgentFile(path).info);
}

/** A team's members: every agent file sibling of its `flows.ap`. */
export function readTeamMembers(teamRoot: string): AgentInfo[] {
  return readAgentInfos(teamRoot);
}

/** A team's purpose — the ABOUT of its `flows.ap`; '' when absent. */
export function readTeamPurpose(teamRoot: string): string {
  const flows = resolve(teamRoot, TEAM_FLOWS_FILE);
  if (!existsSync(flows)) return '';
  return extractAbout(readFileSync(flows, 'utf-8')) ?? '';
}

/**
 * The team root that owns an agent file, or null when the agent is standalone.
 * A directory is a team root only when it holds a `flows.ap` — the single
 * discriminator. With agent files and `flows.ap` as siblings there is no
 * pseudo-root ambiguity: the file's own directory either has a `flows.ap`
 * (team member) or does not (standalone).
 */
export function teamRootForAgentFile(agentFilePath: string): string | null {
  const dir = dirname(resolve(agentFilePath));
  return existsSync(resolve(dir, TEAM_FLOWS_FILE)) ? dir : null;
}

/** The agent name a flat file declares (its `EXPORT AGENT <name>` block), or the basename. */
export function agentNameOf(agentFilePath: string): string {
  try {
    return readAgentFile(agentFilePath).info.name;
  } catch {
    return basename(agentFilePath).replace(/\.ap$/, '');
  }
}
