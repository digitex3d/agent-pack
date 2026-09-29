// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { Config } from './config.js';
import { DiscoveredAgent } from './agentTypes.js';
import { allAgentFiles, allUserAgentFiles, agentNameOf } from './services/teamMetadata.js';

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
 * This is the sole mechanism `bundleAllOnce` uses to enumerate agents.
 */
export function discoverAgentsByWalk(config: Config): DiscoveredAgent[] {
  const names = new Set<string>();
  const agents: DiscoveredAgent[] = [];
  for (const path of [
    ...allAgentFiles(config.agentsDir, config.teamsDir),
    ...allUserAgentFiles(config.userRoot),
  ]) {
    const name = agentNameOf(path);
    if (names.has(name)) continue;
    names.add(name);
    agents.push({ name });
  }
  return agents;
}
