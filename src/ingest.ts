// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, existsSync } from 'fs';
import { basename, dirname, relative, resolve, sep } from 'path';
import { extractAbout, partitionMetadata, exportedBlocksOf, type ExportedBlockBody } from './services/text.js';
import { parseBlocks } from './parseBlocks.js';
import { AGENT_METADATA_KEYWORDS } from './primitives.js';
import { buildNamespace } from './namespace.js';
import { parseTagsPayload } from './services/tags.js';

export type IngestKind =
  | 'policy'
  | 'playbook'
  | 'procedure'
  | 'template'
  | 'role'
  | 'agent'
  | 'tool'
  | 'flow'
  | 'store'
  | 'generic';

/**
 * One segment of the breadcrumb chain. `slug` is the value declared by the
 * `SCOPE` keyword in that folder's `index.ap`; `about` is the ABOUT of the
 * same index.ap (null when absent). Empty when no index.ap on the walked
 * path declares a SCOPE.
 */
export interface BreadcrumbSegment {
  slug: string;
  about: string | null;
}

export interface IngestedFile {
  path: string;
  kind: IngestKind;
  name: string;
  about: string | null;
  /**
   * Alias-qualified dotted namespace derived from the file's directory path
   * relative to its library root. Matches the FROM target syntax used by
   * resolveTargetWith — e.g. `@main.procedures.coding.scripting`.
   * Empty string when the file does not belong to any known library root.
   */
  namespace: string;
  /**
   * Hierarchical breadcrumb (one segment per index.ap walked from the library
   * root down to the leaf folder). Each segment is the `SCOPE` value declared
   * in that folder's `index.ap`. Empty when no index.ap declares a SCOPE on
   * the path.
   */
  breadcrumb: string[];
  /**
   * `ABOUT` of the deepest `index.ap` encountered when walking from the
   * library root to the leaf folder. Used to compose a human-readable chapter
   * title alongside `breadcrumb`.
   */
  breadcrumbAbout: string | null;
  /**
   * Per-segment scope metadata — same order and length as `breadcrumb`. Each
   * entry carries the segment's slug plus the ABOUT of the index.ap that
   * declared its SCOPE (null when that index.ap has no ABOUT). Drives the
   * nested chapter rendering in the bundle output.
   */
  breadcrumbSegments: BreadcrumbSegment[];
  body: string;
  /** TAGS declared by the source file (empty when none). */
  tags: string[];
}

export interface IngestOptions {
  libraryRoot: string | string[];
  /**
   * Named library aliases for namespace derivation (e.g. `{ '@main': '/path/to/agents/library' }`).
   * When provided, a file under a named alias root gets the alias prefix in its namespace
   * (e.g. `@main.procedures.coding`). Files in un-aliased roots fall back to `library.<segments>`.
   */
  libraries?: Record<string, string>;
}

/**
 * THE single kind registry. Every other kind-shaped derivation (the dir⇒kind
 * inverse, the set of block keys that name a kind, the set of namespace
 * kind-folders) is computed from this map — never re-typed by hand. To add or
 * rename a kind that lives under its own folder, edit only this object.
 *
 * Maps each folder-backed kind to the plural folder name it lives under. `agent`
 * is deliberately absent: agents are flat files scattered across `agents/teams/…`
 * and `agents/standalone/…`, recognised by their `EXPORT AGENT` block — never by
 * a dedicated leaf kind-folder. Treating `agents/` as a kind-folder would
 * mis-classify every agent and team file beneath it, so `agent` is a block-kind
 * only (see {@link BLOCK_KINDS}), with no dir-fallback entry.
 */
export const KIND_DIRS: Record<Exclude<IngestKind, 'generic' | 'agent'>, string> = {
  policy: 'policies',
  playbook: 'playbooks',
  procedure: 'procedures',
  template: 'templates',
  role: 'roles',
  tool: 'tools',
  flow: 'flows',
  store: 'stores',
};

/**
 * Inverse of {@link KIND_DIRS}: kind-folder name ⇒ kind. The fallback rule for
 * files with no recognisable top-level block — a kind-folder on the path names
 * the kind. Built once from KIND_DIRS; suffixes play no role.
 */
const DIR_TO_KIND: Record<string, IngestKind> = Object.fromEntries(
  (Object.entries(KIND_DIRS) as [IngestKind, string][]).map(([kind, dir]) => [dir, kind]),
);

/**
 * Block keys whose presence as a top-level block names the file's kind: every
 * folder-backed kind plus `agent` (which is block-only — see {@link KIND_DIRS}).
 */
export const BLOCK_KINDS = new Set<string>([...Object.keys(KIND_DIRS), 'agent']);

const STRUCTURAL_KEYWORD: Partial<Record<IngestKind, RegExp>> = {
  policy: /^POLICY\s+(.+)$/m,
  playbook: /^PLAYBOOK\s+(.+)$/m,
  procedure: /^PROCEDURE\s+(.+)$/m,
  // Name only — stop at whitespace or a `:` so the scalar/block-opener form
  // `TEMPLATE name: TYPE …` yields `name`, not the whole line.
  template: /^TEMPLATE\s+([^\s:]+)/m,
  // `AGENT <name> AS <role>:` — capture the name only, stopping before the
  // `AS <role>` signature clause or the block-opener colon.
  agent: /^AGENT\s+([^\s:]+)/m,
  // `STORE <name>:` — capture the name only, stopping at whitespace or the
  // block-opener colon.
  store: /^STORE\s+([^\s:]+)/m,
};

const H1_RE = /^#\s+(.+)$/m;
const SCOPE_RE = /^SCOPE\s+(.+)$/m;

/**
 * Walk from the matching library root down to the leaf folder, reading each
 * `index.ap` along the way. For every index.ap that declares `SCOPE`, append
 * a segment carrying that SCOPE's slug and the index.ap's ABOUT. Returns empty
 * when no library root contains the file.
 */
function findBreadcrumb(
  filePath: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): BreadcrumbSegment[] {
  const leafDir = dirname(resolve(filePath));
  const roots = Array.isArray(libraryRoot) ? libraryRoot : [libraryRoot];
  const allRoots = [...roots, ...Object.values(libraries ?? {})].map(r => resolve(r));
  const root = allRoots.find(r => !relative(r, leafDir).startsWith('..'));
  if (!root) return [];

  const rel = relative(root, leafDir);
  const segments = rel === '' ? [] : rel.split(sep);
  const out: BreadcrumbSegment[] = [];
  let cursor = root;
  for (let i = 0; i <= segments.length; i++) {
    const idx = resolve(cursor, 'index.ap');
    if (existsSync(idx)) {
      const body = readFileSync(idx, 'utf-8');
      const m = body.match(SCOPE_RE);
      if (m) {
        out.push({ slug: m[1].trim(), about: extractAbout(body) });
      }
    }
    if (i < segments.length) cursor = resolve(cursor, segments[i]);
  }
  return out;
}

/**
 * Resolve a file's kind from its directory alone: the kind-folder closest to the
 * file (the deepest matching path segment) names the kind. Scanning from the
 * leaf outward matters because a build-output ancestor may itself be named like
 * a kind-folder (e.g. `templates/library/policies/x.ap` is a policy, not a
 * template). Returns `'generic'` when no segment matches. The suffix plays no
 * role — this is the dir-fallback shared by {@link unitKindOf} and external
 * callers (e.g. the library index).
 */
export function kindFromDir(filePath: string): IngestKind {
  const segments = resolve(filePath).split(sep);
  for (let i = segments.length - 1; i >= 0; i--) {
    const kind = DIR_TO_KIND[segments[i]];
    if (kind) return kind;
  }
  return 'generic';
}

/**
 * THE single kind decider for a `.ap` unit, from its path AND body. One scale,
 * top-down; the suffix is never consulted:
 *
 *   1. AGENT-wins — an `AGENT` block anywhere makes the file an agent. A flat
 *      agent file carries its own `EXPORT AGENT … AS <role>:` block next to the
 *      inline `ROLE` it binds; that ROLE is the agent's bound identity, not the
 *      file's kind, so AGENT takes precedence over any co-located block.
 *   2. block-key — the first top-level block (scanning ALL blocks, not just the
 *      first) whose key names a kind decides.
 *   3. dir-fallback — `kindFromDir`, the kind-folder closest to the file. Now
 *      that `flow` is a kind with a `flows/` folder, this covers flows too.
 *
 * Every kind-routing site (lint dispatch, import collection, playbook/agent
 * bundle detection, skill listing) funnels through this one function.
 */
export function unitKindOf(filePath: string, body: string): IngestKind {
  const blocks = parseBlocks(body).blocks;
  if (blocks.some(b => b.key.toLowerCase() === 'agent')) return 'agent';
  for (const b of blocks) {
    const key = b.key.toLowerCase();
    if (BLOCK_KINDS.has(key)) return key as IngestKind;
  }
  return kindFromDir(filePath);
}

/**
 * The unit name carried by a file path: its basename with the `.ap` (or `.md`)
 * extension stripped. The single owner of extension-stripping — every site that
 * derives a name from a flat `<name>.ap` path funnels through here.
 */
export function unitNameFromPath(filePath: string): string {
  return basename(filePath).replace(/\.(ap|md)$/i, '');
}

function defaultName(filePath: string, kind: IngestKind): string {
  let base = unitNameFromPath(filePath);
  if (kind !== 'generic') {
    const suffix = `.${kind}`;
    if (base.toLowerCase().endsWith(suffix)) base = base.slice(0, -suffix.length);
  }
  return base;
}

function extractName(body: string, kind: IngestKind, filePath: string): string {
  // TRANSITIONAL: in an EXPORT-block file the unit name is the exported block's
  // name (the file may hold several, but pre-task-3 a module carries one export).
  // The first exported block wins; legacy file-top resolution is unchanged below.
  const exportName = firstExportedBlockName(body);
  if (exportName) return exportName;

  const re = STRUCTURAL_KEYWORD[kind];
  if (re) {
    const m = body.match(re);
    if (m) return m[1].trim();
  }
  const h1 = body.match(H1_RE);
  if (h1) return h1[1].trim();
  return defaultName(filePath, kind);
}

/** Name of the first top-level `EXPORT <KIND> <name>:` block, or null when none. */
function firstExportedBlockName(body: string): string | null {
  return exportedBlocksOf(parseBlocks(body).blocks)[0]?.name ?? null;
}

/**
 * Derive the alias-qualified dotted namespace for a file from its path.
 *
 * Delegates to `buildNamespace` in namespace.ts — the single owner of this
 * logic.  This export is preserved for backward-compatibility with callers
 * that import it directly from ingest.ts.
 */
export function deriveNamespace(
  filePath: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): string {
  return buildNamespace(filePath, libraryRoot, libraries);
}

interface FileFacets {
  namespace: string;
  breadcrumb: string[];
  breadcrumbAbout: string | null;
  breadcrumbSegments: BreadcrumbSegment[];
}

/**
 * Path-derived facets shared by every unit a module exports: namespace and the
 * breadcrumb chain depend on the file's location, not on which block is read.
 * The single source for these so the whole-file and per-block ingest paths agree.
 */
function fileFacets(
  path: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): FileFacets {
  const namespace = deriveNamespace(path, libraryRoot, libraries);
  const breadcrumbSegments = findBreadcrumb(path, libraryRoot, libraries);
  const breadcrumb = breadcrumbSegments.map(s => s.slug);
  // breadcrumbAbout = deepest non-null ABOUT walked (legacy contract preserved).
  const breadcrumbAbout = breadcrumbSegments.reduce<string | null>(
    (acc, s) => s.about ?? acc,
    null,
  );
  return { namespace, breadcrumb, breadcrumbAbout, breadcrumbSegments };
}

/**
 * Metadata keywords stripped from a unit body: the agent-metadata set minus
 * `AS` and `LENS-IN`. In an agent they are header-level metadata, but in a
 * procedure body `AS <template>` is the output contract and `LENS-IN
 * <template>` the input contract — content, never metadata.
 */
const UNIT_METADATA_KEYWORDS = AGENT_METADATA_KEYWORDS.filter(k => k !== 'AS' && k !== 'LENS-IN');

/**
 * Lift a unit's ABOUT/TAGS and strip its metadata keywords (ABOUT, OWNS,
 * APPLIES, TAGS, …), returning the rendered body. The single seam shared by
 * the whole-file path ({@link ingestRaw}) and the per-block path
 * ({@link ingestExportBlock}), so a single-export file and one block of a
 * multi-export file are processed identically (metadata stripped, body cleaned).
 * Inline blocks written inside an agent file go through it too
 * (see `collectInlineDefinition`).
 */
export function liftUnitMetadata(source: string): { about: string | null; tags: string[]; body: string } {
  const { metadata, stripped } = partitionMetadata(source, UNIT_METADATA_KEYWORDS);
  const body = stripped.replace(H1_RE, '').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const about = metadata.get('ABOUT')?.[0] ?? null;
  const tags = parseTagsPayload((metadata.get('TAGS') ?? []).join(' '));
  return { about, tags, body };
}

export function ingestRaw(
  raw: string,
  filePath: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): IngestedFile {
  const path = resolve(filePath);
  const kind = unitKindOf(path, raw);
  const name = extractName(raw, kind, path);
  const { about, tags, body } = liftUnitMetadata(raw);
  return { path, kind, name, about, ...fileFacets(path, libraryRoot, libraries), body, tags };
}

/**
 * Ingest ONE exported block of a multi-export module as its own unit. The unit's
 * kind, name, ABOUT, TAGS and body come from the block itself (its de-indented
 * children), while the namespace/breadcrumb facets are the module's — so sibling
 * `EXPORT <KIND> <name>:` blocks never bleed into each other. The single seam the
 * import resolver uses to register each exported block under its own name.
 */
export function ingestExportBlock(
  block: ExportedBlockBody,
  filePath: string,
  libraryRoot: string | string[],
  libraries?: Record<string, string>,
): IngestedFile {
  const path = resolve(filePath);
  const { about, tags, body } = liftUnitMetadata(block.body);
  return {
    path,
    kind: block.key.toLowerCase() as IngestKind,
    name: block.name,
    about,
    ...fileFacets(path, libraryRoot, libraries),
    body,
    tags,
  };
}

export function ingestFile(filePath: string, opts: IngestOptions): IngestedFile {
  const path = resolve(filePath);
  if (!existsSync(path)) {
    throw new Error(`ingestFile: file not found: ${path}`);
  }
  return ingestRaw(readFileSync(path, 'utf-8'), path, opts.libraryRoot, opts.libraries);
}
