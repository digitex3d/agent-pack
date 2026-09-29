// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { BundleContext } from './types.js';
import { numberSteps } from '../refactor.js';
import { applyVars } from '../vars.js';
import { headingLine } from '../formulas.js';
import { loadImport, resolveImportPath, readAndLint, allLibraryRoots, LoadRequest } from './shared.js';
import { ingestExportBlock, type IngestedFile, type BreadcrumbSegment } from '../ingest.js';
import { exportedBlockBodies, nonExportedSource, type ExportedBlockBody } from '../services/text.js';

const WHEN_RE = /^WHEN\s+(.+)$/m;

function extractWhen(body: string): string | null {
  const m = body.match(WHEN_RE);
  return m ? m[1].trim() : null;
}

/**
 * Merge tags auto-derived from the breadcrumb chain with tags explicitly
 * declared via the TAGS keyword. Duplicates are collapsed; breadcrumb slugs
 * are converted to `#slug` tags (the same convention used by the wider tag
 * system).
 */
function mergeBreadcrumbTags(breadcrumb: string[], explicit: string[]): string[] {
  const merged = new Set<string>();
  for (const slug of breadcrumb) merged.add(`#${slug}`);
  for (const tag of explicit) merged.add(tag);
  return [...merged];
}

/**
 * Files of certain kinds are not inlined at the import site — they are collected
 * into a dedicated section emitted once at the end of the bundle.
 */
type Collected = {
  kind: string;
  name: string;
  about: string | null;
  body: string;
  path: string;
  tags: string[];
  breadcrumb: string[];
  breadcrumbSegments: BreadcrumbSegment[];
};

/** Resolve the body's own IMPORT directives. Dynamic import breaks the cycle with imports.js. */
async function processImportsOf(body: string, ctx: BundleContext): Promise<string> {
  const { processImports } = await import('./imports.js');
  return processImports(body, ctx);
}

export async function resolveFile(imp: LoadRequest, ctx: BundleContext): Promise<string> {
  return imp.exportBlockName
    ? resolveExportBlock(imp, ctx)
    : resolveWholeFile(imp, ctx);
}

/**
 * Register ONE named `EXPORT <KIND> <name>:` block of a multi-export module under
 * its own name and body. A module may export several independently-importable
 * blocks; the resolver names which one this request wants. Dedup is per
 * (path, block-name), so a 2nd import from the same file — and a redundant
 * same-file IMPORT line — is a no-op, never dropped and never re-registered.
 */
async function resolveExportBlock(imp: LoadRequest, ctx: BundleContext): Promise<string> {
  const blockName = imp.exportBlockName!;
  const resolved = resolveImportPath(imp, ctx, blockName);
  if (typeof resolved === 'string') return resolved; // `<!-- MISSING -->`
  const path = resolved.path;

  const blockKey = `${path}::${blockName}`;
  if (ctx.importedPaths.has(blockKey)) return '';
  ctx.importedPaths.add(blockKey);

  const block = (await exportBlocksOf(path, ctx)).find(b => b.name === blockName);
  if (!block) return ''; // the resolver matched this block; defensive only

  const unit = ingestExportBlock(block, path, allLibraryRoots(ctx), ctx.libraries);
  return collectUnit(unit, imp.props, ctx);
}

/**
 * The exported blocks of a module, parsed exactly once per path (cached on ctx).
 * On the first parse — and only then — the module is linted and its cross-file
 * imports are resolved from `nonExportedSource` (the prologue + any non-exported
 * blocks, where IMPORT lines live; the exported-block bodies are processed
 * per-block by `collectUnit`, so neither pass visits them twice). The cache makes
 * an N-export file imported M times read+parse+lint+side-effect exactly once.
 */
async function exportBlocksOf(path: string, ctx: BundleContext): Promise<ExportedBlockBody[]> {
  const cache = (ctx.parsedExports ??= new Map<string, ExportedBlockBody[]>());
  const cached = cache.get(path);
  if (cached) return cached;
  const raw = readAndLint(path, ctx);
  await processImportsOf(nonExportedSource(raw), ctx);
  const blocks = exportedBlockBodies(raw);
  cache.set(path, blocks);
  return blocks;
}

/** Legacy whole-file unit: a module with no EXPORT block collapses to one unit. */
async function resolveWholeFile(imp: LoadRequest, ctx: BundleContext): Promise<string> {
  const unit = loadImport(imp, ctx);
  if (typeof unit === 'string') return unit;
  return collectUnit(unit, imp.props, ctx);
}

/**
 * Number, substitute, resolve transitive imports of a unit's body, then route it
 * to its kind's collection (or emit a heading for non-collected kinds). Shared by
 * the whole-file and per-block paths so both register identically. Kind drives
 * collection — derived from the unit, never from a filename suffix.
 */
async function collectUnit(
  unit: IngestedFile,
  props: Record<string, string>,
  ctx: BundleContext,
): Promise<string> {
  let body = unit.body;
  if (unit.kind === 'playbook' || unit.kind === 'procedure') body = numberSteps(body);
  const when = extractWhen(body);
  if (Object.keys(props).length > 0) body = applyVars(body, props);
  body = await processImportsOf(body, ctx);

  const mergedTags = mergeBreadcrumbTags(unit.breadcrumb, unit.tags);
  const collect = (kind: string, collection: Collected[]): string => {
    const existing = collection.find(e => e.name === unit.name);
    if (existing) {
      // Same block re-collected (e.g. a redundant same-file IMPORT) is a no-op;
      // a same name from a DIFFERENT file is a genuine collision.
      if (existing.path === unit.path) return '';
      ctx.lintErrors.push({
        file: unit.path, line: 1,
        message: `${kind} name "${unit.name}" collides with already-imported ${kind} at ${existing.path}`,
      });
      return '';
    }
    collection.push({
      kind, name: unit.name, about: unit.about, body: body.trimEnd(), path: unit.path,
      tags: mergedTags,
      breadcrumb: unit.breadcrumb,
      breadcrumbSegments: unit.breadcrumbSegments,
    });
    return '';
  };
  // `flow` is a first-class kind, so it routes like the rest.
  if (unit.kind === 'flow')        return collect('flow',      ctx.flows      as Collected[]);
  if (unit.kind === 'store')       return collect('store',     ctx.stores     as Collected[]);
  if (unit.kind === 'policy')      return collect('policy',    ctx.policies   as Collected[]);
  if (unit.kind === 'procedure')   return collect('procedure', ctx.procedures as Collected[]);
  if (unit.kind === 'template')    return collect('template',  ctx.templates  as Collected[]);

  // Non-collected kinds (rare — e.g. inlined playbook bodies): emit a single
  // chapter heading derived from the unit name; breadcrumb-driven nested
  // rendering is reserved for collected kinds that share a SectionSpec.
  const lines: string[] = [];
  const titleWithWhen = when ? `${unit.name} - when ${when}` : unit.name;
  lines.push('', headingLine(1, titleWithWhen), '');
  if (body) lines.push(body, '');
  return lines.join('\n');
}
