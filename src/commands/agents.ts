// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { loadConfig } from '../config.js';
import { buildMetadataIndex, resolveLibraryOutputDir } from '../libraryIndex.js';
import type { ExportEntry } from '../libraryIndex.js';
import { resolve } from 'path';
import type { Config } from '../config.js';
import { standaloneDir } from '../services/teamMetadata.js';
import { parseNamespace } from '../namespace.js';

/**
 * CLI command: `agent-pack agents list` — enumerate every discoverable agent,
 * grouped by domain. No new discovery walk lives here: the agent roots come
 * from {@link deriveAgentConfig} (the same derived config the fs-agents source
 * indexes) and the library agents from {@link buildMetadataIndex} over the
 * configured library roots, both filtered to `EXPORT AGENT` entries.
 *
 * Domains:
 *   project — `agents/standalone/` (`@main`) and team members (`@teams.<team>`)
 *   global  — the user home (`~/.agent-pack`): `agents/` (`@user`) and
 *             `teams/<team>/` (`@user-teams.<team>`)
 *   library — `EXPORT AGENT` blocks inside the project library and any
 *             declared shared libraries (`@main`, `@<alias>`)
 */

/**
 * The Config the agent scan runs on: the agent roots mapped to namespaces with an
 * isolated manifest. Standalone agents resolve under `@main`, local team members
 * under `@teams`, global standalone agents under `@user`, global team members
 * under `@user-teams`. `userRoot` is cleared so the reserved `@user` alias maps
 * to the GLOBAL AGENTS ROOT here (not the user home).
 */
function deriveAgentConfig(config: Config): Config {
  const agentManifestDir = resolve(resolveLibraryOutputDir(config), 'agents');
  return {
    ...config,
    libraryRoot: standaloneDir(config.agentsDir),
    sharedLibraries: [
      { alias: 'teams', path: config.teamsDir },
      { alias: 'user', path: resolve(config.userRoot, 'agents') },
      { alias: 'user-teams', path: resolve(config.userRoot, 'teams') },
    ],
    userRoot: '',
    outputDir: resolve(agentManifestDir, 'compiled'),
  };
}

const DOMAINS = ['project', 'global', 'library'] as const;
type Domain = (typeof DOMAINS)[number];

interface AgentRow {
  domain: Domain;
  /** `standalone`, `team:<name>`, or the library alias (`@main`, `@<alias>`). */
  scope: string;
  name: string;
  about: string;
  /** `path:line` of the EXPORT AGENT block. */
  source: string;
}

/** Map an agent-root namespace (`@main`, `@teams.dev`, `@user`, `@user-teams.x`) to its row shape. */
function rowFromAgentRoots(entry: ExportEntry): AgentRow {
  const { alias, kind } = parseNamespace(entry.namespace);
  const team = kind || 'unknown';
  const shapes: Record<string, Pick<AgentRow, 'domain' | 'scope'>> = {
    '@main': { domain: 'project', scope: 'standalone' },
    '@teams': { domain: 'project', scope: `team:${team}` },
    '@user': { domain: 'global', scope: 'standalone' },
    '@user-teams': { domain: 'global', scope: `team:${team}` },
  };
  const shape = shapes[alias ?? ''] ?? { domain: 'project' as Domain, scope: entry.namespace };
  return { ...shape, name: entry.name, about: entry.about ?? '', source: entry.source };
}

function rowFromLibrary(entry: ExportEntry): AgentRow {
  const { alias } = parseNamespace(entry.namespace);
  return {
    domain: 'library',
    scope: alias ?? 'library',
    name: entry.name,
    about: entry.about ?? '',
    source: entry.source,
  };
}

function agentEntries(exports: Record<string, ExportEntry>): ExportEntry[] {
  return Object.values(exports).filter(entry => entry.kind === 'agent');
}

function collectRows(config: Awaited<ReturnType<typeof loadConfig>>): AgentRow[] {
  const fromRoots = agentEntries(buildMetadataIndex(deriveAgentConfig(config)).exports).map(rowFromAgentRoots);
  const fromLibrary = agentEntries(buildMetadataIndex(config).exports).map(rowFromLibrary);
  return [...fromRoots, ...fromLibrary].sort(
    (a, b) =>
      DOMAINS.indexOf(a.domain) - DOMAINS.indexOf(b.domain) ||
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name),
  );
}

function renderTable(rows: AgentRow[]): string {
  const lines: string[] = [];
  let domain: Domain | null = null;
  const scopeWidth = Math.max(...rows.map(r => r.scope.length));
  const nameWidth = Math.max(...rows.map(r => r.name.length));
  for (const row of rows) {
    if (row.domain !== domain) {
      if (domain !== null) lines.push('');
      lines.push(row.domain);
      domain = row.domain;
    }
    lines.push(`  ${row.scope.padEnd(scopeWidth)}  ${row.name.padEnd(nameWidth)}  ${row.about}`.trimEnd());
  }
  return lines.join('\n');
}

function usage(): void {
  console.error('Usage:');
  console.error('  agent-pack agents list [--domain project|global|library] [--json]');
}

export async function agents(args: string[]): Promise<void> {
  const config = await loadConfig(args);

  let sub: string | null = null;
  let domain: Domain | null = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) {
      const value = args[++i];
      if (!(DOMAINS as readonly string[]).includes(value)) {
        console.error(`Unknown domain: ${value}. Expected one of: ${DOMAINS.join(', ')}.`);
        process.exit(1);
      }
      domain = value as Domain;
    } else if (args[i] === '--json') json = true;
    else if (args[i] === '--config') i++;
    else if (!args[i].startsWith('--') && !sub) sub = args[i];
  }

  if (sub !== 'list') {
    usage();
    process.exit(1);
  }

  const rows = collectRows(config).filter(row => !domain || row.domain === domain);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.error(domain ? `No agents found in domain "${domain}".` : 'No agents found.');
    return;
  }
  console.log(renderTable(rows));
}
