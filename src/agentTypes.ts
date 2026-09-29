// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Minimal agent types for post-S7 (manifest-eliminated) world.
 *
 * - `DiscoveredAgent`: the result of a filesystem walk (just the agent name).
 *   Per-agent metadata is no longer carried by the discovery layer; it lives
 *   in each agent's `agent.ap` source and flows through the bundle pipeline.
 */

export interface DiscoveredAgent {
  name: string;
}
