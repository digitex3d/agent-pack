// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { Config, libraryRoots } from './config.js';
import { DiscoveredAgent } from './agentTypes.js';
import { allAgentFiles, allUserAgentFiles, findSkillFiles, agentNameOf } from './services/teamMetadata.js';

/**
 * Every agent file the project builds, in precedence order: its own agents
 * (standalone and team members), the user's global ones, then its library's
 * skills. The one list discovery, name resolution and the agent index read.
 */
export function projectAgentFiles(config: Config): string[] {
  return [
    ...allAgentFiles(config.agentsDir, config.teamsDir),
    ...allUserAgentFiles(config.userRoot),
    ...findSkillFiles(libraryRoots(config)),
  ];
}

/**
 * Per S8: agents are discoverable from the filesystem alone. An agent is a flat
 * `.ap` file holding an `EXPORT AGENT` block. Discovery is the ONE walk shared
 * with name resolution ({@link allAgentFiles} over the same search dirs — a
 * standalone agent under `agents/standalone/` and a team member sibling of a
 * team's `flows.ap` are found identically). The discovered name is the canonical
 * block name, not the filename. Global agents (the user home) are walked after
 * the project's, and built-ins after both, so precedence mirrors the config
 * cascade: project shadows global shadows built-in.
 *
 * The project library's skills (`EXPORT SKILL` blocks) come last: a skill is
 * an agent the adapter writes as a skill, built by the same walk.
 *
 * This is the sole mechanism `bundleAllOnce` uses to enumerate agents.
 */
export function discoverAgentsByWalk(config: Config): DiscoveredAgent[] {
  const names = new Set<string>();
  const agents: DiscoveredAgent[] = [];
  for (const path of projectAgentFiles(config)) {
    const name = agentNameOf(path);
    if (names.has(name)) continue;
    names.add(name);
    agents.push({ name });
  }
  return agents;
}
