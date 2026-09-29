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
 * Tie-break: two LOCAL agents claiming the same role in the same bundle is an
 * unrecoverable ambiguity — `buildRoleIndex` throws. A local agent shadowing an
 * imported one is NOT an error: the local one wins silently, by design.
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

/** role name → the winning agent that implements it. */
export type RoleIndex = Map<string, AgentEntry>;

/** A role binding read directly from a directory-anchored agent.ap. */
export interface AgentBinding {
  name: string;
  role: string;
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
 * Throws on a genuine ambiguity: two agents at the SAME (winning) priority
 * claiming the same role. A lower-priority agent losing to a higher-priority
 * one is resolved silently.
 */
export function buildRoleIndex(...groups: BuildRoleIndexInput[]): RoleIndex {
  const index: RoleIndex = new Map();

  for (const group of groups) {
    const anchor = group.anchor ?? 'directory';
    const priority = ANCHOR_PRIORITY[anchor];

    for (const block of group.blocks ?? []) {
      if (block.key !== 'AGENT' || block.name === null) continue;
      const sig = parseAgentSignature(block.rest);
      if (sig.role) insertEntry(index, { name: block.name, role: sig.role, anchor, priority });
    }
    for (const b of group.bindings ?? []) {
      insertEntry(index, { name: b.name, role: b.role, anchor, priority });
    }
  }

  return index;
}

/**
 * Insert one agent entry, resolving precedence against any sitting entry for the
 * same role. Higher priority wins silently; equal priority is an irreducible
 * ambiguity and throws.
 */
function insertEntry(index: RoleIndex, entry: AgentEntry): void {
  const existing = index.get(entry.role);
  if (existing === undefined || entry.priority > existing.priority) {
    index.set(entry.role, entry);
    return;
  }
  if (entry.priority < existing.priority) return;

  throw new Error(
    `ambiguous role binding: agents "${existing.name}" and "${entry.name}" ` +
      `both bind role "${entry.role}" at the same precedence (${entry.anchor})`,
  );
}

/**
 * Resolve the agent bound to `roleName`, or null when no agent claims it.
 * Resolution is exact — the role index is pre-resolved for precedence, so this
 * is a direct lookup.
 */
export function resolveRole(index: RoleIndex, roleName: string): AgentEntry | null {
  return index.get(roleName) ?? null;
}
