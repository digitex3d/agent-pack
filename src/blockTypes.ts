// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Centralized registry of every NAMED primitive declaration in the DSL.
 *
 * The DSL has ONE block shape:
 *
 *   <KEY> <name>:
 *     <indented body>
 *
 * Every primitive in this registry — AGENT, POLICY, PLAYBOOK, PROCEDURE,
 * TEMPLATE, ROLE, FLOW, TOOL — is a NAMED declaration
 * with an indented body. Adding a new primitive is one entry here: zero
 * changes to lexer, parser, ingest, or resolver.
 *
 * NOT in this registry: control-flow constructs (WHEN, IF, ELSE, STEP).
 * They appear as block-openers in source but they are nameless control
 * structures living *inside* a primitive, not primitive declarations
 * themselves. They are handled by the renderer separately.
 *
 * PR1 scope: the registry only declares the *identity* of each primitive.
 * Render/frontmatter/validate hooks are added by PR3 when the bundle
 * pipeline migrates onto this registry.
 */

export interface BlockType {
  /** The uppercase key as written in source (e.g. `PROCEDURE`). */
  key: string;
  /**
   * A visibility modifier wraps another block type rather than declaring its
   * own primitive: `EXPORT <KIND> <name>:` produces a block of the inner KIND
   * marked exported. Modifiers are registered so the lexer/parser stay
   * whitelist-free, but they are unwrapped by parseBlocks — a modifier key
   * never survives into the AST as a block key.
   */
  modifier?: boolean;
}

export const BLOCK_TYPES: Record<string, BlockType> = {
  AGENT:      { key: 'AGENT'      },
  POLICY:     { key: 'POLICY'     },
  PLAYBOOK:   { key: 'PLAYBOOK'   },
  PROCEDURE:  { key: 'PROCEDURE'  },
  TEMPLATE:   { key: 'TEMPLATE'   },
  ROLE:       { key: 'ROLE'       },
  FLOW:       { key: 'FLOW'       },
  TOOL:       { key: 'TOOL'       },
  STORE:      { key: 'STORE'      },
  EXPORT:     { key: 'EXPORT', modifier: true },
};

/** The block-modifier key marking a top-level block as exported. */
export const EXPORT_MODIFIER = 'EXPORT';

/**
 * Look up a BlockType by key. Returns null when the key is not registered
 * (e.g. WHEN/IF/ELSE/STEP control-flow keys, or a user typo). Callers
 * decide whether absence is an error in their context.
 */
export function blockTypeOf(key: string): BlockType | null {
  return BLOCK_TYPES[key] ?? null;
}
