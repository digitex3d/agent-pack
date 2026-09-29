// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, existsSync } from 'fs';
import { resolve, basename, isAbsolute } from 'path';
import { BundleContext } from './types.js';
import { lintFile } from '../lint.js';
import { ingestRaw, IngestedFile } from '../ingest.js';

/**
 * Minimal load request shape — replaces the legacy `ImportDirective` once the
 * `<!-- @ -->` directive subsystem is gone. The IMPORT keyword engine builds
 * one of these per resolved target.
 */
export interface LoadRequest {
  path: string;
  props: Record<string, string>;
  /**
   * Name of the specific `EXPORT <KIND> <name>:` block to register from a
   * multi-export module. Set by the import resolver when a name resolves to one
   * block of a file holding several exports. Absent for legacy whole-file units.
   */
  exportBlockName?: string;
}

/**
 * The full set of roots an importer searches and derives namespaces from: the
 * ordered project/shared library roots PLUS every aliased library root. The
 * single owner of this composition — every importer (whole-file, per-block, role,
 * manifest key) calls this rather than re-splatting `libraryRoots` + `libraries`.
 */
export function allLibraryRoots(ctx: BundleContext): string[] {
  return [...ctx.libraryRoots, ...Object.values(ctx.libraries ?? {})];
}

/**
 * Read a module and lint it, accumulating diagnostics into `ctx`. The single
 * read+lint seam shared by the whole-file ({@link loadImport}) and per-block
 * import paths, so neither can drift on lint options.
 */
export function readAndLint(path: string, ctx: BundleContext): string {
  const raw = readFileSync(path, 'utf-8');
  ctx.lintErrors.push(...lintFile(path, raw, ctx.lintOptions));
  return raw;
}

/**
 * Search a relative path across the ordered library roots.
 * Returns the first existing absolute path, or undefined if none match.
 */
export function findInRoots(roots: string[], relPath: string): string | undefined {
  for (const root of roots) {
    const candidate = resolve(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a LoadRequest to an existing absolute path WITHOUT registering it.
 * Absolute paths are pre-resolved (typically by `IMPORT FROM` against a
 * sharedLibrary alias): skip libraryRoots lookup and trust the caller. Relative
 * paths fall back to libraryRoots. Returns a `<!-- MISSING -->` marker string
 * when no candidate exists. The per-block import path reuses this to resolve a
 * module's path while applying its own (path, block-name) dedup.
 */
export function resolveImportPath(
  imp: LoadRequest,
  ctx: BundleContext,
  missingLabel?: string,
): { path: string } | string {
  const targetPath = isAbsolute(imp.path)
    ? (existsSync(imp.path) ? imp.path : undefined)
    : findInRoots(ctx.libraryRoots, imp.path);
  if (!targetPath) {
    const label = missingLabel ?? basename(imp.path).replace(/\.ap$/, '');
    return `<!-- MISSING: ${label} -->`;
  }
  return { path: targetPath };
}

export function checkAndRegister(
  imp: LoadRequest,
  ctx: BundleContext,
  missingLabel?: string,
): { path: string } | string {
  const r = resolveImportPath(imp, ctx, missingLabel);
  if (typeof r === 'string') return r;
  if (ctx.importedPaths.has(r.path)) return '';
  ctx.importedPaths.add(r.path);
  return r;
}

export function loadImport(
  imp: LoadRequest,
  ctx: BundleContext,
  missingLabel?: string,
): IngestedFile | string {
  const r = checkAndRegister(imp, ctx, missingLabel);
  if (typeof r === 'string') return r;
  return ingestRaw(readAndLint(r.path, ctx), r.path, allLibraryRoots(ctx), ctx.libraries);
}
