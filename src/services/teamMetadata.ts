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
import { parseBlocks, type Block } from '../parseBlocks.js';

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
  /**
   * Its members, in order, each with the line that lists it: the MEMBER lines —
   * or, under `STRATEGY contracts`, the LEAD and the agents the CONTRACT blocks'
   * BY lines name, once each.
   */
  members: { name: string; line: number }[];
  /** `STRATEGY <name>` — the builtin strategy the team runs by, or null (its routing and flows are its own). */
  strategy: { name: string; line: number } | null;
  /** `LEAD <agent>` — the agent that prepares the work under a strategy. */
  lead: { name: string; line: number } | null;
  /** `DOMAINS <dimension>` — the lead's dimension that gives every file its domain. */
  domains: { name: string; line: number } | null;
  /** The CONTRACT blocks of the team. */
  contracts: ContractDecl[];
  /** The indent of the block's lines — what `unit` de-indents them by. */
  childIndent: number;
  /**
   * The team as the pipeline reads it: the file with the TEAM opener, its
   * MEMBER/STRATEGY/LEAD/DOMAINS lines and its CONTRACT blocks blanked and the
   * block's lines de-indented to column 0 — so a routing WHEN, a FLOW, a LENS-IN
   * stand at the top as they did in `flows.ap`, the prologue IMPORTs stay where
   * they are, and every line keeps its number.
   */
  unit: string;
}

/** A `CONTRACT <name>:` block as written: its form (`AS`), who carries it out (`BY`), the domain the lead picks it for. */
export interface ContractDecl {
  name: string;
  /** The header line. */
  line: number;
  about: string;
  domain: string | null;
  domainLine: number | null;
  /** The template `AS` names — the shape of the spec the lead fills. */
  as: string | null;
  asLine: number | null;
  /** True when the AS line carries a level (`AS!`): an error, a contract's shape takes none. */
  asLevelled: boolean;
  /** The names `BY` lists: agents of the team, or one team. */
  by: string[];
  byLine: number | null;
}

/** The lines a TEAM block holds besides its routing and flows — blanked in its unit. */
const TEAM_HEAD_LINES = new Set(['MEMBER', 'STRATEGY', 'LEAD', 'DOMAINS']);

/** The block that declares a contract. */
export const CONTRACT_KEY = 'CONTRACT';

/** The strategy a team of contracts declares. */
export const CONTRACTS_STRATEGY = 'contracts';

/** Read one CONTRACT block. */
function readContract(block: Block): ContractDecl {
  const decl: ContractDecl = { name: block.name ?? '', line: block.startLine, about: '', domain: null, domainLine: null, as: null, asLine: null, asLevelled: false, by: [], byLine: null };
  for (const child of block.children) {
    if (child.type !== 'line') continue;
    const rest = child.rest.trim();
    if (child.keyword === 'ABOUT' && !decl.about) decl.about = rest;
    else if (child.keyword === 'DOMAIN' && decl.domain === null) { decl.domain = rest; decl.domainLine = child.line; }
    else if (/^!?AS!{0,2}$/.test(child.keyword) && decl.as === null) { decl.as = rest; decl.asLine = child.line; decl.asLevelled = child.keyword !== 'AS'; }
    else if (child.keyword === 'BY' && decl.byLine === null) { decl.by = rest.split(',').map(x => x.trim()).filter(Boolean); decl.byLine = child.line; }
  }
  return decl;
}

/** The CONTRACT blocks directly under `blocks` — a file's top (PROJECT.ap) or a TEAM block's children. */
export function readContractBlocks(blocks: readonly (Block | { type: string })[]): ContractDecl[] {
  return blocks.filter((b): b is Block => b.type === 'block' && (b as Block).key === CONTRACT_KEY).map(readContract);
}

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
  let strategy: TeamFile['strategy'] = null;
  let lead: TeamFile['lead'] = null;
  let domains: TeamFile['domains'] = null;
  for (const child of block.children) {
    if (child.type !== 'line') continue;
    const rest = child.rest.trim();
    if (child.keyword === 'MEMBER') {
      listed.push(...rest.split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name, line: child.line })));
    } else if (child.keyword === 'ABOUT' && !about) {
      about = rest;
    } else if (child.keyword === 'STRATEGY' && !strategy) {
      strategy = { name: rest, line: child.line };
    } else if (child.keyword === 'LEAD' && !lead) {
      lead = { name: rest, line: child.line };
    } else if (child.keyword === 'DOMAINS' && !domains) {
      domains = { name: rest, line: child.line };
    }
  }
  const contracts = readContractBlocks(block.children);
  // Under the contracts strategy the roster is derived: the lead, then whoever a BY names, once each.
  const members = strategy?.name === CONTRACTS_STRATEGY
    ? [...(lead ? [lead] : []), ...contracts.flatMap(c => c.by.map(name => ({ name, line: c.byLine ?? c.line })))]
      .filter((m, i, all) => all.findIndex(o => o.name === m.name) === i)
    : listed;
  const childIndent = block.children[0]?.indent ?? 0;
  return { root, path, source, block, name: block.name ?? basename(root), about, members, strategy, lead, domains, contracts, childIndent, unit: teamUnit(lines, block, childIndent) };
}

/** See {@link TeamFile.unit}: the opener, the head lines and the CONTRACT blocks blanked, the block's lines de-indented, numbers kept. */
function teamUnit(lines: string[], block: Block, childIndent: number): string {
  const end = blockEnd(block, lines.length);
  const out = lines.slice();
  out[block.startLine - 1] = '';
  for (let i = block.startLine; i < end; i++) {
    out[i] = out[i].slice(Math.min(childIndent, out[i].length - out[i].trimStart().length));
  }
  for (const child of block.children) {
    if (child.type === 'line' && TEAM_HEAD_LINES.has(child.keyword)) out[child.line - 1] = '';
    if (child.type === 'block' && child.key === CONTRACT_KEY) {
      for (let i = child.startLine - 1; i < blockEnd(child, lines.length); i++) out[i] = '';
    }
  }
  return out.join('\n');
}

/** `source` with the lines of `blocks` blanked — numbers kept: how the project file sheds its CONTRACT blocks before it renders. */
export function withoutBlocks(source: string, blocks: readonly Block[]): string {
  const out = source.split(/\r?\n/);
  for (const b of blocks) for (let i = b.startLine - 1; i < blockEnd(b, out.length); i++) out[i] = '';
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
export function teamRosterIssues(team: TeamFile, index: ContractIndex | null = null): TeamIssue[] {
  const issues: TeamIssue[] = [];
  const files = findAgentFiles(team.root).map(path => ({ path, name: agentNameOf(path) }));
  const folder = basename(team.root);
  if (team.name !== folder) {
    issues.push({ file: team.path, line: team.block.startLine, message: `TEAM ${team.name}: a team is named like its folder — \`${folder}\`` });
  }
  if (team.strategy?.name === CONTRACTS_STRATEGY) return [...issues, ...contractIssues(team, files, index)];
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

/**
 * The contracts of a project, read once for every compilation of the run: the
 * teams (with their strategy and lead) and every CONTRACT block — in a team or
 * at the top of the project file — with who it names. What a `BY <team>`
 * resolves against, and what says whether some contract hands work to a team.
 */
export interface ContractIndex {
  teams: { name: string; strategy: string | null; lead: string | null }[];
  /** Every contract, with its file, the team it is written in (null: the project file) and the IMPORT line that brings in its AS template there, when one does. */
  contracts: (ContractDecl & { file: string; team: string | null; asImport: string | null })[];
}

/** The `IMPORT <name> FROM <module>` a file would need to see `name` — from the IMPORT line of `source` that lists it, or null. */
function importLineFor(source: string, name: string | null): string | null {
  if (!name) return null;
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^IMPORT\s+(.+?)\s+FROM\s+(\S+)\s*$/);
    if (m && m[1].split(',').map(s => s.trim()).includes(name)) return `IMPORT ${name} FROM ${m[2]}`;
  }
  return null;
}

/** Build the index: the teams under `teamsDir` and the CONTRACT blocks of `projectFile` (null, or absent: none). */
export function buildContractIndex(teamsDir: string, projectFile: string | null): ContractIndex {
  const index: ContractIndex = { teams: [], contracts: [] };
  for (const root of teamRootsUnder(teamsDir)) {
    const team = readTeamFile(root);
    if (!team) continue;
    index.teams.push({ name: team.name, strategy: team.strategy?.name ?? null, lead: team.lead?.name ?? null });
    index.contracts.push(...team.contracts.map(c => ({ ...c, file: team.path, team: team.name, asImport: importLineFor(team.source, c.as) })));
  }
  if (projectFile && existsSync(projectFile)) {
    const source = readFileSync(projectFile, 'utf-8');
    index.contracts.push(...readContractBlocks(parseBlocks(source).blocks).map(c => ({ ...c, file: projectFile, team: null, asImport: importLineFor(source, c.as) })));
  }
  return index;
}

/** A team of the index that runs by contracts, by name — or null. */
export function contractsTeamOf(index: ContractIndex | null, name: string): { name: string; lead: string | null } | null {
  const team = index?.teams.find(t => t.name === name && t.strategy === CONTRACTS_STRATEGY);
  return team ?? null;
}

/**
 * What a team of contracts gets wrong: a LEAD with no agent file; a BY that names
 * nothing of the folder and no team of contracts, or mixes agents and a team,
 * or names the team itself; an agent file no contract hands work to; and — given
 * the index — no CONTRACT anywhere that names this team in its BY.
 */
function contractIssues(team: TeamFile, files: { path: string; name: string }[], index: ContractIndex | null): TeamIssue[] {
  const issues: TeamIssue[] = [];
  const folder = basename(team.root);
  const at = (line: number | null, message: string) => issues.push({ file: team.path, line: line ?? team.block.startLine, message });
  if (team.lead && !files.some(f => f.name === team.lead!.name)) {
    at(team.lead.line, `LEAD ${team.lead.name}: no agent file in \`${folder}/\` declares \`EXPORT AGENT ${team.lead.name}\``);
  }
  const handed = new Set<string>(team.lead ? [team.lead.name] : []);
  for (const c of team.contracts) {
    const agents = c.by.filter(name => files.some(f => f.name === name));
    const teams = c.by.filter(name => !files.some(f => f.name === name) && (index ? contractsTeamOf(index, name) !== null : false));
    const unknown = c.by.filter(name => !agents.includes(name) && !teams.includes(name));
    for (const name of unknown) {
      at(c.byLine, `BY ${name}: no agent file in \`${folder}/\` declares \`EXPORT AGENT ${name}\`${index ? ', and no team runs by contracts under that name' : ''}`);
    }
    if (teams.includes(team.name)) at(c.byLine, `BY ${team.name}: a contract is not handed to its own team`);
    if (teams.length > 0 && agents.length > 0) at(c.byLine, `BY ${c.by.join(', ')}: a contract is carried out by agents of the team, or handed to one team — not both`);
    if (teams.length > 1) at(c.byLine, `BY ${c.by.join(', ')}: a contract is handed to one team`);
    for (const name of agents) handed.add(name);
  }
  for (const f of files) {
    if (!handed.has(f.name)) at(null, `TEAM ${team.name}: the agent \`${f.name}\` (${basename(f.path)}) is in the folder but no CONTRACT names it in its BY, nor is it the LEAD`);
  }
  if (index && !index.contracts.some(c => c.team !== team.name && c.by.includes(team.name))) {
    at(null, `TEAM ${team.name}: no CONTRACT hands work to this team — write one with \`BY ${team.name}\` in PROJECT.ap, or in a team that delegates to it`);
  }
  return issues;
}

/**
 * What a CONTRACT outside a team (the project file) gets wrong: it hands work to
 * exactly one team of contracts, carries no DOMAIN, and names a template of the
 * compilation as its form.
 */
export function projectContractIssues(file: string, decls: ContractDecl[], index: ContractIndex, templates: ReadonlySet<string>): TeamIssue[] {
  const issues: TeamIssue[] = [];
  for (const c of decls) {
    const at = (line: number | null, message: string) => issues.push({ file, line: line ?? c.line, message });
    if (c.domain !== null) at(c.domainLine, `CONTRACT ${c.name}: DOMAIN is a team contract's — the lead picks it by domain; a project contract hands the whole request to a team`);
    if (c.by.length !== 1) at(c.byLine, `CONTRACT ${c.name}: BY names the one team that takes the request — found ${c.by.length || 'none'}`);
    else if (!contractsTeamOf(index, c.by[0])) at(c.byLine, `BY ${c.by[0]}: no team runs by contracts under that name — a project contract is handed to a team with \`STRATEGY contracts\``);
    if (c.as && !templates.has(c.as)) at(c.asLine, `CONTRACT ${c.name}: AS \`${c.as}\` names no template of this file — declare it here or IMPORT it`);
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
  /** Role this agent binds via the `AS <role>` header signature. */
  role?: string;
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
  const agent = blocks.find(b => AGENT_KEYS.has(b.key));
  if (!agent) {
    throw new Error(`${path}: no EXPORT AGENT or EXPORT SKILL block — a flat agent file must declare one`);
  }
  const role = blocks.find(b => b.key === 'ROLE');

  const info: AgentInfo = {
    name: agent.name,
    about: extractPrimitive(agent.body, 'ABOUT') ?? '',
    role: parseAgentSignature(agent.rest).role ?? undefined,
    lensIn: extractPrimitive(agent.body, 'LENS-IN') ?? undefined,
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
