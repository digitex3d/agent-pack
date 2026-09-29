// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Role display-name helper.
 *
 * The block name IS the role: `ROLE software-architect:` declares the role whose
 * display name is the de-slugified block name ("software architect"). This is the
 * single source of truth for that conversion — used by the import path
 * (dispatch/role.ts), the inline path (dispatch/inlineBlocks.ts), and the bundle
 * identity merge.
 */
export function deslugifyRole(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).join(' ');
}
