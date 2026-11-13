// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Role index — the declarative role→agent binding layer.
 *
 * A first-class `AGENT <name> AS <role>:` block binds an agent to the NAME of
 * a ROLE. In a FLOW, `BY <role>` names the role; the role index maps that
 * role name to the agent that implements it. This is the single source of
 * truth for that resolution.
 *
 * The binding is purely declarative — no runtime embedding, no similarity. An
 * entry is built from the `definitionArgs.role` of each AGENT block.
 *
 * Precedence (highest wins):
 *   1. a directory-anchored local agent (`anchor: 'directory'`) beats
 *   2. an `EXPORT AGENT` imported from a library (`anchor: 'imported'`).
 *
 * A role is a craft many agents share (reviewer, implementer, explorer): any
 * number of agents may bind it, and an agent may bind several (`AS r1, r2`).
 * Only a `BY <role>` has to pick one, so the ambiguity is told there, never
 * here: `resolveRole` answers only when one agent holds the role at the
 * winning precedence, `roleHolders` says who holds it otherwise. A local agent
 * shadowing an imported one is NOT an ambiguity: the local one wins silently.
 */

import type { Block } from './parseBlocks.js';
import { parseAgentSignature } from './definitionArgs.js';

/** Where an agent entry comes from — drives precedence. */
export type AgentAnchor = 'directory' | 'imported';

/**
 * Numeric precedence of each anchor — higher wins. A directory-anchored local
 * agent beats an imported `EXPORT AGENT`.
 */
export const ANCHOR_PRIORITY: Record<AgentAnchor, number> = {
  directory: 2,
  imported: 1,
};

/** One agent that implements a role. */
export interface AgentEntry {
  /** The agent's declared name (`AGENT <name>`). */
  name: string;
  /** The role this agent binds to (`AS <role>`). */
  role: string;
  /** Provenance of the agent definition — directory-anchored or imported. */
  anchor: AgentAnchor;
  /** Resolved precedence (`ANCHOR_PRIORITY[anchor]`); higher wins. */
  priority: number;
}

/** role name → the agents that hold it at the winning precedence, in the order they came. */
export type RoleIndex = Map<string, AgentEntry[]>;

/** The roles an agent binds, read directly from a directory-anchored agent.ap. */
export interface AgentBinding {
  name: string;
  roles: string[];
}

export interface BuildRoleIndexInput {
  /** Top-level AGENT blocks parsed from a bundle's sources. */
  blocks?: Block[];
  /**
   * Pre-parsed `(name, role)` bindings — e.g. a directory-anchored agent.ap
   * whose `# <name>` heading and top-level `AS <role>` are read outside this
   * module. Folded into the same index as `blocks`, at the same anchor.
   */
  bindings?: AgentBinding[];
  /** Provenance of these blocks. Defaults to `'directory'`. */
  anchor?: AgentAnchor;
}

/**
 * Build a role index from one or more groups of AGENT blocks.
 *
 * Each group carries its own anchor so a caller can fold directory-anchored
 * local agents and imported `EXPORT AGENT` blocks into a single index with the
 * right precedence. Pass groups in any order — precedence is resolved by
 * `priority`, not call order.
 *
 * Several agents at the same (winning) priority holding one role are kept
 * together; a lower-priority agent losing to a higher-priority one is dropped.
 */
export function buildRoleIndex(...groups: BuildRoleIndexInput[]): RoleIndex {
  const index: RoleIndex = new Map();

  for (const group of groups) {
    const anchor = group.anchor ?? 'directory';
    const priority = ANCHOR_PRIORITY[anchor];

    for (const block of group.blocks ?? []) {
      if (block.key !== 'AGENT' || block.name === null) continue;
      for (const role of parseAgentSignature(block.rest).roles) insertEntry(index, { name: block.name, role, anchor, priority });
    }
    for (const binding of group.bindings ?? []) {
      for (const role of binding.roles) insertEntry(index, { name: binding.name, role, anchor, priority });
    }
  }

  return index;
}

/**
 * Insert one agent entry against the agents already holding the same role:
 * a higher priority replaces them, an equal one joins them, a lower one is
 * dropped. The same agent met twice counts once.
 */
function insertEntry(index: RoleIndex, entry: AgentEntry): void {
  const holders = index.get(entry.role);
  if (!holders || entry.priority > holders[0].priority) {
    index.set(entry.role, [entry]);
    return;
  }
  if (entry.priority === holders[0].priority && !holders.some(holder => holder.name === entry.name)) holders.push(entry);
}

/**
 * Resolve the agent bound to `roleName`: the one agent holding it, or null
 * when none does — or when several do, which `roleHolders` tells.
 */
export function resolveRole(index: RoleIndex, roleName: string): AgentEntry | null {
  const holders = index.get(roleName);
  return holders?.length === 1 ? holders[0] : null;
}

/** The agents holding `roleName` at the winning precedence — more than one, and a `BY <role>` cannot pick. */
export function roleHolders(index: RoleIndex, roleName: string): string[] {
  return (index.get(roleName) ?? []).map(holder => holder.name);
}

/** What a `BY <role>` says when several agents hold the role. */
export function ambiguousRoleMessage(roleName: string, holders: readonly string[]): string {
  return `\`${roleName}\` is the role of ${holders.join(', ')} — name the agent`;
}
