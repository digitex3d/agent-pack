// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Single source of truth for the alias-qualified dotted namespace format.
 *
 * Namespace forms:
 *   @<alias>.<kind>[.<scope...>]   — file inside a named alias root
 *   library.<kind>[.<scope...>]    — file inside an un-aliased root
 *   library                        — file at the root level itself
 *
 * `buildNamespace` is the canonical builder (moved from ingest.ts's
 * `deriveNamespace`). `parseNamespace` is the canonical parser used by
 * dispatch/imports.ts and libraryIndex.ts to recover alias, kind, and scope
 * without ad-hoc string slicing.
 */

import { dirname, resolve, relative, sep } from 'path';

/**
 * Build the alias-qualified dotted namespace for a file from its path.
 *
 * Mirrors `deriveNamespace` in ingest.ts — that function now delegates here.
 *
 * @param filePath   Absolute (or resolvable) path to the `.ap` file.
 * @param libraryRoot  One or more library root directories to search.
 * @param libraries    Optional alias→path map (e.g. `{ '@main': '/path/to/library' }`).
 */
export function buildNamespace(
  filePath: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): string {
  const leafDir = dirname(resolve(filePath));
  const roots = Array.isArray(libraryRoot) ? libraryRoot : [libraryRoot];
  const resolvedRoots = roots.map(r => resolve(r));

  const rootAlias = new Map<string, string>();
  if (libraries) {
    for (const [alias, libPath] of Object.entries(libraries)) {
      rootAlias.set(resolve(libPath), alias);
    }
  }

  const root = resolvedRoots.find(r => !relative(r, leafDir).startsWith('..'));
  if (!root) return '';

  const rel = relative(root, leafDir);
  const segments = rel === '' ? [] : rel.split(sep);
  const prefix = rootAlias.get(root) ?? 'library';
  return segments.length === 0 ? prefix : `${prefix}.${segments.join('.')}`;
}

export interface ParsedNamespace {
  /** The `@alias` prefix (with `@`) or null for the `library` prefix. */
  alias: string | null;
  /**
   * The first path segment after the prefix — corresponds to the kind folder
   * (e.g. `policies`, `playbooks`, `procedures`).
   */
  kind: string;
  /**
   * All path segments after kind — the sub-scope (may be empty).
   */
  scope: string[];
}

/**
 * Parse an alias-qualified dotted namespace back into its structural parts.
 *
 * Inverse of `buildNamespace`.
 *
 * Examples:
 *   `@main.procedures.coding.scripting` → { alias: '@main', kind: 'procedures', scope: ['coding', 'scripting'] }
 *   `library.policies`                  → { alias: null,    kind: 'policies',   scope: [] }
 *   `library`                           → { alias: null,    kind: '',           scope: [] }
 *   `@shared`                           → { alias: '@shared', kind: '',         scope: [] }
 */
export function parseNamespace(ns: string): ParsedNamespace {
  const dotIdx = ns.indexOf('.');
  if (dotIdx === -1) {
    // Bare prefix — no kind segment at all.
    const alias = ns.startsWith('@') ? ns : null;
    return { alias, kind: '', scope: [] };
  }

  const prefix = ns.slice(0, dotIdx);
  const alias = prefix.startsWith('@') ? prefix : null;
  const rest = ns.slice(dotIdx + 1); // everything after the prefix dot

  const segments = rest.split('.').filter(Boolean);
  const kind = segments[0] ?? '';
  const scope = segments.slice(1);

  return { alias, kind, scope };
}
