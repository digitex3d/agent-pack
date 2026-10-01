// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { BundleContext, RoleEntry } from './types.js';
import { lintFile } from '../lint.js';
import { checkAndRegister, findInRoots, allLibraryRoots, LoadRequest } from './shared.js';
import { parseTagsPayload } from '../services/tags.js';
import { extractPrimitive, unwrapExportFile, liftRoleIdentity } from '../services/text.js';
import { deslugifyRole } from '../services/role.js';
import { ingestRaw, unitNameFromPath } from '../ingest.js';

const EXTENDS_RE = /^EXTENDS\s+(.+)$/m;
const ABOUT_RE = /^ABOUT\s+(.+)$/m;
const TAGS_RE = /^TAGS\s+(.+)$/m;
const H1_RE = /^#\s+(.+)$/m;

function extractRoleName(body: string, filePath: string): string {
  const m = body.match(H1_RE);
  if (m) return m[1].trim();
  return unitNameFromPath(filePath);
}

function extractAbout(body: string): string | null {
  const m = body.match(ABOUT_RE);
  return m ? m[1].trim() : null;
}

function extractExtends(body: string): string | null {
  const m = body.match(EXTENDS_RE);
  return m ? m[1].trim() : null;
}

function stripMetadata(body: string): string {
  return body
    .replace(H1_RE, '')
    .replace(ABOUT_RE, '')
    .replace(EXTENDS_RE, '')
    .replace(TAGS_RE, '')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * Resolve an EXTENDS parent by bare name: the child's own directory first, then
 * `roles/<name>.ap` across every library root — project and shared roots plus
 * the aliased ones (`@user` = the global home, `@builtin`) — so a project role
 * can extend a global role. The fallback (first root, for the MISSING report)
 * stays the project library.
 */
function resolveParentPath(parentName: string, childPath: string, libraryRoots: string[]): string {
  const sameDir = resolve(dirname(childPath), `${parentName}.ap`);
  if (existsSync(sameDir)) return sameDir;
  const inRoots = findInRoots(libraryRoots, `roles/${parentName}.ap`);
  if (inRoots) return inRoots;
  return resolve(libraryRoots[0], 'roles', `${parentName}.ap`);
}

function resolveRoleFile(
  absPath: string,
  ctx: BundleContext,
  seen: Set<string>,
): { name: string; about: string | null; rules: string; tags: string[] } {
  seen.add(absPath);

  const raw = ctx.sources.read(absPath);
  ctx.lintErrors.push(...lintFile(absPath, raw, ctx.lintOptions));
  // TRANSITIONAL: route the column-0 metadata regexes through the shared EXPORT
  // seam (services/text.ts). unwrapExportFile lifts an `EXPORT ROLE <name>:`
  // block's children back to indent 0 so ABOUT/TAGS/EXTENDS/H1 land where the
  // existing regexes read them; a legacy file (no EXPORT block) is returned
  // verbatim, so behaviour is byte-identical. Lint keeps the original `raw`
  // (it has its own block-scoped EXPORT handling).
  const unwrapped = unwrapExportFile(raw);
  const ownTags = parseTagsPayload(extractPrimitive(unwrapped, 'TAGS') ?? '');
  const merged = mergeParent(extractExtends(unwrapped), stripMetadata(unwrapped), absPath, ctx, seen);
  return {
    name: extractRoleName(unwrapped, absPath),
    about: extractAbout(unwrapped),
    rules: merged.rules,
    tags: [...new Set([...merged.tags, ...ownTags])],
  };
}

/** A broken EXTENDS fails the compilation, pointing at the child's EXTENDS line. */
function extendsError(ctx: BundleContext, childPath: string, message: string): { rules: string; tags: string[] } {
  const line = ctx.sources.read(childPath).split('\n').findIndex(l => /^\s*EXTENDS\s/.test(l)) + 1;
  ctx.lintErrors.push({ file: childPath, line: line || 1, message });
  return { rules: '', tags: [] };
}

/**
 * The one EXTENDS rule: the parent's rules — its own chain resolved — come
 * before the role's own; the parent's tags are inherited. A missing parent or
 * a cycle is a compile error.
 */
function mergeParent(
  parent: string | null,
  ownRules: string,
  childPath: string,
  ctx: BundleContext,
  seen: Set<string>,
): { rules: string; tags: string[] } {
  if (!parent) return { rules: ownRules, tags: [] };
  const parentPath = resolveParentPath(parent, childPath, allLibraryRoots(ctx));
  if (!existsSync(parentPath)) return extendsError(ctx, childPath, `EXTENDS ${parent}: no role \`${parent}\` next to this file or in roles/ of any library`);
  if (seen.has(parentPath)) return extendsError(ctx, childPath, `EXTENDS ${parent}: circular — \`${parent}\` already extends this role`);
  const resolved = resolveRoleFile(parentPath, ctx, seen);
  return { rules: ownRules ? `${resolved.rules}\n\n${ownRules}` : resolved.rules, tags: resolved.tags };
}

/**
 * An inline `ROLE <name>:` body (written in an agent file) with its EXTENDS
 * resolved exactly as a library role's: the line removed, the parent's rules
 * first, the parent's tags returned for the entry.
 */
export function extendInlineRole(body: string, sourcePath: string, ctx: BundleContext): { body: string; tags: string[] } {
  const merged = mergeParent(extractExtends(body), body.replace(EXTENDS_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd(), sourcePath, ctx, new Set());
  return { body: merged.rules, tags: merged.tags };
}

export async function resolveRole(imp: LoadRequest, ctx: BundleContext): Promise<string> {
  const r = checkAndRegister(imp, ctx, `role ${basename(imp.path)}`);
  if (typeof r === 'string') return r;

  const resolved = resolveRoleFile(r.path, ctx, new Set());

  // Breadcrumb is taken from the leaf file (the role that was imported).
  // ingestRaw is the single source of truth for breadcrumb walking and shares
  // the same library-root + alias resolution as every other importer.
  const raw = ctx.sources.read(r.path);
  const ingested = ingestRaw(raw, r.path, allLibraryRoots(ctx), ctx.libraries);

  const breadcrumbTags = ingested.breadcrumb.map(s => `#${s}`);
  const mergedTags = [...new Set([...breadcrumbTags, ...resolved.tags])];

  // Lift EXPERTISE out of the resolved rules: it is part of the role's identity,
  // rendered in the binding agent's `# Identity` block, never in the Roles
  // chapter. The role display name is the de-slugified block name. `rules` keeps
  // only the behaviours.
  const identity = liftRoleIdentity(resolved.rules);

  const entry: RoleEntry = {
    kind: 'role',
    name: resolved.name,
    about: resolved.about,
    body: identity.rules,
    path: imp.path,
    tags: mergedTags,
    breadcrumb: ingested.breadcrumb,
    breadcrumbSegments: ingested.breadcrumbSegments,
    role: deslugifyRole(resolved.name),
    expertise: identity.expertise ?? undefined,
  };
  ctx.roles.push(entry);
  return '';
}
