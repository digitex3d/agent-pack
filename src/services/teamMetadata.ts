// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { parseAgentSignature } from '../definitionArgs.js';
import { exportedBlockBodies, nonExportedSource, nonExportedLines, extractPrimitive, extractPrimitives, ExportedBlockBody } from './text.js';
import { parseApplies } from './tags.js';
import { SourceRegistry, type SourceSpan } from '../sources.js';
import { AGENT_KEYS, TEAM_KEY } from '../blockTypes.js';
export { TEAM_KEY };
import { apFilesUnder } from './fs.js';
import type { Block } from '../parseBlocks.js';
import { splitList } from '../lists.js';

/**
 * The single reader for team/agent metadata pulled straight from `.ap` source.
 *
 * An agent is a flat `.ap` file holding an `EXPORT AGENT <name> AS <role>:`
 * block (sibling of the team's file / `team.ap`, or under
 * `agents/standalone/`). Everything about the agent — its canonical name, ABOUT,
 * role binding, default input shape, and its own behavioural rules — is read
 * from that block. The optional sibling `EXPORT ROLE` block carries the craft.
 *
 * A team is the `.ap` file of its folder that holds an `EXPORT TEAM <name>:`
 * block — `<team>.ap` by convention: ABOUT, MEMBER lines, its routing (WHEN …
 * RUN) and its FLOW blocks, all inside the block; IMPORTs in the prologue.
 *
 * Built on `parseBlocks` via {@link exportedBlockBodies}: there is exactly ONE
 * parse path and ONE discovery walk. The name is canonical from the block; the
 * filename is convention only.
 */

/** The retired team file: a `flows.ap` is an error naming its replacement. */
export const TEAM_LEGACY_FILE = 'flows.ap';

/** A team's file, read and parsed once: its block, roster and the source its flows are compiled from. */
export interface TeamFile {
  /** The team folder. */
  root: string;
  /** Absolute path of the file holding the `EXPORT TEAM` block. */
  path: string;
  /** The file as written. */
  source: string;
  /** The `EXPORT TEAM` block, from the file's parse tree. */
  block: Block;
  /** The team's name — the block's. */
  name: string;
  /** Its ABOUT, '' when absent. */
  about: string;
  /** Its members, in order, each with the line that lists it: the MEMBER lines. */
  members: { name: string; line: number }[];
  /** The indent of the block's lines — what `unit` de-indents them by. */
  childIndent: number;
  /**
   * The team as the pipeline reads it: the file with the TEAM opener and its
   * MEMBER lines blanked and the block's lines de-indented to column 0 — so a routing WHEN, a FLOW, a LENS-IN
   * stand at the top as they did in `flows.ap`, the prologue IMPORTs stay where
   * they are, and every line keeps its number.
   */
  unit: string;
}

/** The lines a TEAM block holds besides its routing and flows — blanked in its unit. */
const TEAM_HEAD_LINES = new Set(['MEMBER']);

/** The `.ap` file under `dir` holding an `EXPORT TEAM` block, or null — the one discriminator of a team folder. */
export function teamFileOf(dir: string): string | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.ap')) continue;
    const path = resolve(dir, entry);
    if (statSync(path).isFile() && holdsBlock(readFileSync(path, 'utf-8'), TEAM_KEY)) return path;
  }
  return null;
}

/** True when `path` is the team file of its folder. */
export function isTeamFile(path: string): boolean {
  return teamFileOf(dirname(resolve(path))) === resolve(path);
}

/** Read a team folder's file — null when the folder has none. Through `sources` when a compilation gives one. */
export function readTeamFile(root: string, sources: SourceRegistry = new SourceRegistry()): TeamFile | null {
  const path = teamFileOf(root);
  if (!path) return null;
  const source = sources.read(path);
  const block = sources.tree(path).blocks.find(b => b.key === TEAM_KEY && b.exported)!;
  const lines = source.split(/\r?\n/);
  const listed: { name: string; line: number }[] = [];
  let about = '';
  for (const child of block.children) {
    if (child.type !== 'line') continue;
    const rest = child.rest.trim();
    if (child.keyword === 'MEMBER') {
      listed.push(...splitList(rest).map(name => ({ name, line: child.line })));
    } else if (child.keyword === 'ABOUT' && !about) {
      about = rest;
    }
  }
  const childIndent = block.children[0]?.indent ?? 0;
  return { root, path, source, block, name: block.name ?? basename(root), about, members: listed, childIndent, unit: teamUnit(lines, block, childIndent) };
}

/** See {@link TeamFile.unit}: the opener and the head lines blanked, the block's lines de-indented, numbers kept. */
function teamUnit(lines: string[], block: Block, childIndent: number): string {
  const end = blockEnd(block, lines.length);
  const out = lines.slice();
  out[block.startLine - 1] = '';
  for (let i = block.startLine; i < end; i++) {
    out[i] = out[i].slice(Math.min(childIndent, out[i].length - out[i].trimStart().length));
  }
  for (const child of block.children) {
    if (child.type === 'line' && TEAM_HEAD_LINES.has(child.keyword)) out[child.line - 1] = '';
  }
  return out.join('\n');
}

/** The 1-based number of the last line a block owns: the line before its last descendant's successor, or EOF. */
function blockEnd(block: Block, eof: number): number {
  let last = block.startLine;
  const walk = (b: Block): void => {
    for (const c of b.children) {
      if (c.type === 'line') last = Math.max(last, c.line);
      else { last = Math.max(last, c.startLine); walk(c); }
    }
  };
  walk(block);
  return last < eof ? last : eof;
}

/** A line of a lint error, at a file. */
export interface TeamIssue { file: string; line: number; message: string }

/**
 * What a team's roster gets wrong: a MEMBER with no agent file in the folder, an
 * agent file the MEMBER lines leave out, a block named unlike its folder. The
 * one check of the roster, run by the compiler and by the orchestration.
 */
export function teamRosterIssues(team: TeamFile): TeamIssue[] {
  const issues: TeamIssue[] = [];
  const files = findAgentFiles(team.root).map(path => ({ path, name: agentNameOf(path) }));
  const folder = basename(team.root);
  if (team.name !== folder) {
    issues.push({ file: team.path, line: team.block.startLine, message: `TEAM ${team.name}: a team is named like its folder — \`${folder}\`` });
  }
  const seen = new Set<string>();
  for (const m of team.members) {
    if (seen.has(m.name)) issues.push({ file: team.path, line: m.line, message: `MEMBER ${m.name}: listed twice` });
    seen.add(m.name);
    if (!files.some(f => f.name === m.name)) {
      issues.push({ file: team.path, line: m.line, message: `MEMBER ${m.name}: no agent file in \`${folder}/\` declares \`EXPORT AGENT ${m.name}\`` });
    }
  }
  for (const f of files) {
    if (!seen.has(f.name)) {
      issues.push({ file: team.path, line: team.block.startLine, message: `TEAM ${team.name}: the agent \`${f.name}\` (${basename(f.path)}) is in the folder but not among its MEMBER lines` });
    }
  }
  return issues;
}

/** A `flows.ap` still in a team folder: the error that names its replacement, or null. */
export function legacyTeamIssue(dir: string): TeamIssue | null {
  const legacy = resolve(dir, TEAM_LEGACY_FILE);
  if (!existsSync(legacy)) return null;
  return { file: legacy, line: 1, message: `flows.ap was replaced by \`EXPORT TEAM ${basename(dir)}:\` in \`${basename(dir)}.ap\` — move its ABOUT, routing and FLOW blocks inside that block, list the members with MEMBER, and delete this file` };
}

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
   * override in the TEAM block is layered on top by the orchestration reader and wins.
   */
  lensIn?: string;
  /** Its `BUDGET` tier — what another harness picks its model by (D66); absent when it declares none. */
  budget?: string;
  /** The roles this agent binds via the `AS <role>, …` header signature, in order — empty when none. */
  roles: string[];
  /** True when the block is a `SKILL` — an agent the adapter writes as a skill. */
  skill: boolean;
  /** A skill's APPLIES line: its tags and its perimeter, read by whoever imports it (src/withUse.ts). */
  applies: { tags: string[]; scopes: string[] };
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

/** The AGENT block body prefixed with its header `AS <role>, …` binding as a top-level line. */
function asAgentBody(agent: ExportedBlockBody): string {
  const roles = parseAgentSignature(agent.rest).roles;
  return roles.length ? `AS ${roles.join(', ')}\n${agent.body}` : agent.body;
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
  const agent = blocks.find(b => AGENT_KEYS.has(b.key));
  if (!agent) {
    throw new Error(`${path}: no EXPORT AGENT or EXPORT SKILL block — a flat agent file must declare one`);
  }
  const role = blocks.find(b => b.key === 'ROLE');

  const info: AgentInfo = {
    name: agent.name,
    about: extractPrimitive(agent.body, 'ABOUT') ?? '',
    roles: parseAgentSignature(agent.rest).roles,
    lensIn: extractPrimitive(agent.body, 'LENS-IN') ?? undefined,
    budget: extractPrimitive(agent.body, 'BUDGET') ?? undefined,
    skill: agent.key === 'SKILL',
    applies: parseApplies(extractPrimitives(agent.body, 'APPLIES')),
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
  const agentSpan = sources.span(path, agent.key, agent.name);
  const span = agentSpan && {
    ...agentSpan,
    lines: [...nonExportedLines(source).map(line => ({ line, text: lines[line - 1] })), ...agentSpan.lines],
  };

  return { path, info, unitSource, span };
}

/** True when a `.ap` source holds at least one exported block of `key`. */
function holdsBlock(source: string, key: string): boolean {
  return exportedBlockBodies(source).some(b => b.key === key);
}

/**
 * Every skill file under `roots`, recursively: a `.ap` file holding an
 * `EXPORT SKILL` block. Skills live in a library — where an agent IMPORTs them
 * FROM — never beside a team's file, so they stay out of the orchestration.
 */
export function findSkillFiles(roots: string[]): string[] {
  return roots.flatMap(apFilesUnder).filter(path => holdsBlock(readFileSync(path, 'utf-8'), 'SKILL'));
}

/**
 * Every flat agent file directly under `dir`: a `*.ap` file holding an
 * `EXPORT AGENT` block. The ONE discovery walk — a standalone agent and a team
 * member are found the same way (a file sibling of the team file / `team.ap`).
 */
export function findAgentFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.ap')) continue;
    const path = resolve(dir, entry);
    if (!statSync(path).isFile()) continue;
    if (holdsBlock(readFileSync(path, 'utf-8'), 'AGENT')) out.push(path);
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

/** The names of the teams under `teamsDir` — what a flow's `BY <team>` resolves against. */
export function teamNamesUnder(teamsDir: string): string[] {
  return teamRootsUnder(teamsDir).map(root => readTeamFile(root)?.name).filter((n): n is string => !!n);
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

/**
 * A team's members: the agents its MEMBER lines name, in that order, each read
 * from its file in the folder. A name with no file is left out here — the
 * roster check ({@link teamRosterIssues}) reports it.
 */
export function readTeamMembers(teamRoot: string): AgentInfo[] {
  const team = readTeamFile(teamRoot);
  if (!team) return [];
  const infos = readAgentInfos(teamRoot);
  return team.members.flatMap(m => infos.filter(a => a.name === m.name));
}

/** A team's purpose — the ABOUT of its TEAM block; '' when absent. */
export function readTeamPurpose(teamRoot: string): string {
  return readTeamFile(teamRoot)?.about ?? '';
}

/**
 * The team root that owns an agent file, or null when the agent is standalone.
 * A directory is a team root only when it holds a team file (an `EXPORT TEAM`
 * block) — the single discriminator. With agent files and the team file as
 * siblings there is no pseudo-root ambiguity: the file's own directory either
 * has a team file (team member) or does not (standalone).
 */
export function teamRootForAgentFile(agentFilePath: string): string | null {
  const dir = dirname(resolve(agentFilePath));
  return teamFileOf(dir) ? dir : null;
}

/** The agent name a flat file declares (its `EXPORT AGENT <name>` block), or the basename. */
export function agentNameOf(agentFilePath: string): string {
  try {
    return readAgentFile(agentFilePath).info.name;
  } catch {
    return basename(agentFilePath).replace(/\.ap$/, '');
  }
}
