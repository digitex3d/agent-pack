// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Library index generator (manifest schema v2).
 *
 * Scans every `.ap` module under all configured library roots and produces a
 * tag-keyed metadata index whose ingestion unit is the EXPORT block: each
 * `EXPORT <KIND> <name>:` block in a file becomes one entry, keyed by
 * `@namespace/block-name`. Legacy files (no EXPORT block) still produce one
 * entry per file — a transitional path that disappears once every module is
 * migrated.
 *
 * No parser logic lives here — block discovery delegates to `parseBlocks`,
 * metadata extraction to `extractPrimitives` / `extractAbout` (via the EXPORT
 * unwrap seam), and namespace derivation to `buildNamespace`.
 */

import { readdirSync, statSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { ingestRaw, IngestKind, kindFromDir, BLOCK_KINDS } from './ingest.js';
import { extractPrimitives, extractAbout, exportedBlocksOf } from './services/text.js';
import { parseBlocks, Block } from './parseBlocks.js';
import { buildNamespace } from './namespace.js';
import { librariesAliasMap } from './config.js';
import type { Config } from './config.js';
import { parseTagsPayload, useTagRegistry } from './services/tags.js';
import type { LibraryIndexError } from './services/tags.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExportEntry {
  kind: IngestKind;
  name: string;
  namespace: string;
  /** `path:line` of the export block (legacy files: `path:1`). */
  source: string;
  about: string | null;
  tags: string[];
  /** Raw text after the APPLIES keyword, verbatim. Null when absent. */
  applies: string | null;
  /** WHEN payload verbatim, or `"always"` when absent. */
  when: string;
  sizeBytes: number;
}

export type { LibraryIndexError } from './services/tags.js';

export interface LibraryIndex {
  /** Export-keyed metadata. */
  exports: Record<string, ExportEntry>;
  /** Inverse tag → export-key list. */
  byTag: Record<string, string[]>;
  /** Lint errors collected during indexing (untagged modules, similar-tag conflicts). */
  errors: LibraryIndexError[];
}

// ---------------------------------------------------------------------------
// Internal helpers — file/block traversal
// ---------------------------------------------------------------------------

/** Recursively collect all `.ap` file paths under `dir`. */
function collectApFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...collectApFiles(full));
    } else if (entry.endsWith('.ap')) {
      out.push(full);
    }
  }
  return out;
}

/** Stable composite key for the exports map: `<namespace>/<name>`. */
function exportKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/** Highest source line number owned by `block` (its opener or any descendant). */
function lastLineOf(block: Block): number {
  let max = block.startLine;
  for (const child of block.children) {
    const line = child.type === 'line' ? child.line : lastLineOf(child);
    if (line > max) max = line;
  }
  return max;
}

/**
 * Verbatim source of a single block — the opener line through its last
 * descendant. Feeding this slice (one EXPORT block) back through the metadata
 * extractors yields that block's scoped ABOUT / TAGS / WHEN / APPLIES.
 */
function blockSource(lines: string[], block: Block): string {
  return lines.slice(block.startLine - 1, lastLineOf(block)).join('\n');
}

// ---------------------------------------------------------------------------
// Internal — metadata extraction for one ingestion unit
// ---------------------------------------------------------------------------

/**
 * One ingestion unit: an entry plus its registry key. `metaKey` is the registry key; `tags` drive both the lint
 * and the inverse index.
 */
interface RawUnit {
  key: string;
  filePath: string;
  tags: string[];
  /**
   * True for an EXPORT-block unit, false for a legacy whole-file unit. EXPORT
   * blocks are indexed unconditionally, so absent TAGS is not a drop. Legacy units keep the
   * TAGS-required contract until they migrate.
   */
  isExport: boolean;
  entry: ExportEntry;
}

/** Extract scoped metadata (TAGS/WHEN/APPLIES) from a unit's source text. */
function extractMetadata(source: string): { tags: string[]; when: string; applies: string | null } {
  const tagTokens = extractPrimitives(source, 'TAGS');
  const whenTokens = extractPrimitives(source, 'WHEN');
  const appliesTokens = extractPrimitives(source, 'APPLIES');
  const tags = tagTokens.length > 0 ? tagTokens.flatMap(t => parseTagsPayload(t)) : [];
  const when = whenTokens.length > 0 ? whenTokens[0] : 'always';
  const applies = appliesTokens.length > 0 ? appliesTokens[0] : null;
  return { tags, when, applies };
}

/**
 * Build the ingestion units for one file: one per EXPORT block, or a single
 * legacy unit when the file has no exported block.
 */
function unitsForFile(
  filePath: string,
  raw: string,
  roots: string[],
  libraries: Record<string, string>,
): RawUnit[] {
  const namespace = buildNamespace(filePath, roots, libraries);
  const exported = exportedBlocksOf(parseBlocks(raw).blocks);

  if (exported.length === 0) {
    // Legacy file: one entry per file, metadata read at file-top (source line 1).
    const ingested = ingestRaw(raw, filePath, roots, libraries);
    const { tags, when, applies } = extractMetadata(raw);
    return [{
      key: exportKey(ingested.namespace, ingested.name),
      filePath,
      tags,
      isExport: false,
      entry: {
        kind: ingested.kind,
        name: ingested.name,
        namespace: ingested.namespace,
        source: `${filePath}:1`,
        about: ingested.about,
        tags,
        applies,
        when,
        sizeBytes: Buffer.byteLength(raw, 'utf-8'),
      },
    }];
  }

  const lines = raw.split(/\r?\n/);
  return exported.map(block => {
    const source = blockSource(lines, block);
    const name = block.name as string;
    const kind = blockKind(block, filePath);
    const { tags, when, applies } = extractMetadata(source);
    return {
      key: exportKey(namespace, name),
      filePath,
      tags,
      isExport: true,
      entry: {
        kind,
        name,
        namespace,
        source: `${filePath}:${block.startLine}`,
        about: extractAbout(source),
        tags,
        applies,
        when,
        sizeBytes: Buffer.byteLength(source, 'utf-8'),
      },
    };
  });
}

/**
 * Resolve a block's IngestKind from its declared KIND key, falling back to the
 * kind-folder on the path. `EXPORT POLICY x` → `policy`; an unrecognised key
 * defers to the directory so the dir-fallback stays the single rule.
 */
function blockKind(block: Block, filePath: string): IngestKind {
  const fromKey = block.key.toLowerCase();
  return BLOCK_KINDS.has(fromKey) ? (fromKey as IngestKind) : kindFromDir(filePath);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Result of scanning every root: accepted units + the tag registry snapshot. */
interface ScanResult {
  accepted: RawUnit[];
  byTag: Record<string, string[]>;
  errors: LibraryIndexError[];
}

/**
 * Scan every `.ap` file in all configured library roots into ingestion units,
 * running the tag lint. Pure and synchronous. The single source of file
 * discovery, block extraction, and tag registration.
 */
function scanUnits(config: Config): ScanResult {
  const libraries = librariesAliasMap(config);

  // Collect all library roots to scan: @main + any sharedLibraries. After
  // loadConfig() remote libraries are already materialised as local entries;
  // any still-remote entry (unmaterialised) is skipped here exactly as before.
  const roots: string[] = [
    resolve(config.libraryRoot),
    ...(config.sharedLibraries ?? []).map(l => resolve(l.path)),
  ];

  // Collect and sort all files across all roots for deterministic first-wins ordering.
  const allFiles: string[] = [];
  for (const root of roots) {
    allFiles.push(...collectApFiles(root));
  }
  allFiles.sort();

  const tags = useTagRegistry();
  const accepted: RawUnit[] = [];
  for (const filePath of allFiles) {
    const raw = readFileSync(filePath, 'utf-8');
    for (const unit of unitsForFile(filePath, raw, roots, libraries)) {
      // An untagged EXPORT block is indexed unconditionally. It contributes
      // nothing to byTag and raises no error — there is nothing to register,
      // so we accept it without touching the registry.
      if (unit.isExport && unit.tags.length === 0) {
        accepted.push(unit);
        continue;
      }
      // Everything else (tagged EXPORT block, any legacy unit) goes through the
      // registry. register() is transactional and drops the unit on failure:
      // a similar-tag conflict for either, or absent TAGS for a legacy unit.
      if (!tags.register(unit.key, unit.filePath, unit.tags).ok) continue;
      accepted.push(unit);
    }
  }

  const snap = tags.snapshot();
  return { accepted, byTag: snap.byTag, errors: snap.errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan every `.ap` file in all configured library roots and build the
 * tag-keyed metadata index. Synchronous and pure.
 */
export function buildMetadataIndex(config: Config): LibraryIndex {
  const { accepted, byTag, errors } = scanUnits(config);
  const exports: Record<string, ExportEntry> = {};
  for (const unit of accepted) exports[unit.key] = unit.entry;
  return { exports, byTag, errors };
}

/**
 * Resolve the directory holding `library.map.json`: the parent of
 * `config.outputDir` (i.e. `.agent-pack/`).
 */
export function resolveLibraryOutputDir(config: Config): string {
  return dirname(resolve(config.outputDir));
}
