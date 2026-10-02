// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { BundleContext } from '../dispatch/index.js';
import { FORMULAS, fill, headingLine } from '../formulas.js';
import type { Definition } from '../definition.js';
import { buildHierarchy, type TagNode } from '../services/tags.js';
import { definitionId } from '../apdoc/blocks.js';

export interface SectionEntry {
  heading: string;
  prelude?: string | null;
  body: string;
  /** Set during emit — the block id references to this entry print. */
  refId?: string;
}

/**
 * Declarative description of a collected section. Two emission modes:
 *  - `renderFlat`  : single block under the chapter header
 *  - `renderEntry` : numbered H2 (or deeper, when entries carry a breadcrumb)
 *                    per entry with prelude + body (Roles, Templates,
 *                    Procedures, Tools, Policies, Flows)
 *
 * `afterEmit` runs after each entry is emitted; used by Templates to copy
 * the `refId` back to `ctx.templates[i]` for AS resolution.
 */
export interface SectionSpec<E = unknown> {
  title: string;
  intro: string | null;
  entries: E[];
  renderFlat?(entries: E[]): string;
  renderEntry?(source: E): SectionEntry;
  afterEmit?(source: E, entry: SectionEntry): void;
}

/** Open a top-level chapter: H1 header + optional intro paragraph. */
export function beginChapter(ctx: BundleContext, title: string): string {
  return `${headingLine(1, title)}\n\n`;
}

/** Emit chapter header + optional intro paragraph. */
export function openSection(ctx: BundleContext, title: string, intro: string | null): string {
  let out = beginChapter(ctx, title);
  if (intro) out += `${intro}\n\n`;
  return out;
}

/**
 * Pretty-print a breadcrumb slug as a chapter heading.
 *
 * The slug is converted from kebab/snake to Title Case so the bundle output
 * reads naturally. We intentionally keep the rule trivial — the slug itself is
 * authored by the library maintainer; no extra disambiguation logic is needed.
 */
function scopeHeadingTitle(slug: string): string {
  return slug
    .split(/[-_]+/)
    .map(part => (part.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Tags shown on a rendered entry: only the explicitly-declared tags that are
 * NOT already implied by the heading path the entry is nested under (`auto`).
 * Returns null when the explicit set (after subtracting `auto`) is empty —
 * callers can then skip the "Tags:" line entirely.
 */
function renderEntryTagsInline(def: Definition, auto: ReadonlySet<string>): string | null {
  const extra = def.tags.filter(t => !auto.has(t)).sort();
  if (extra.length === 0) return null;
  return `Tags: ${extra.join(' ')}`;
}

/**
 * Fold the entry's prelude (its ABOUT) into the heading title itself — "Policy
 * "composability" — build small, composable units" — instead of repeating it
 * as its own paragraph in the body below. ABOUT lives on every block kind, so
 * this applies uniformly wherever a Definition is rendered as an entry.
 */
function headingWithAbout(heading: string, prelude?: string | null): string {
  const about = prelude?.trim();
  return about ? heading + fill(FORMULAS.document.about, { about }) : heading;
}

/** Emit a single entry: heading (with ABOUT folded in) + optional Tags line + body. */
function emitDefinitionEntry<E extends Definition>(
  ctx: BundleContext,
  source: E,
  spec: SectionSpec<E>,
  entryDepth: number,
  autoTags: ReadonlySet<string> = new Set(),
): string {
  const entry = spec.renderEntry!(source);
  let out = `${headingLine(entryDepth, headingWithAbout(entry.heading, entry.prelude))}\n`;
  entry.refId = definitionId(source, ctx);
  const tagsLine = renderEntryTagsInline(source, autoTags);
  if (tagsLine) out += `${tagsLine}\n\n`;
  out += `${entry.body.trim()}\n\n`;
  spec.afterEmit?.(source, entry);
  return out;
}

// ---------------------------------------------------------------------------
// Tag hierarchy grouping.
//
// Each chapter that contains tagged Definitions is rendered by (1) asking the
// single centralized FCA tag hierarchy (`buildHierarchy`, src/services/tags.ts)
// for the tag forest implied by the chapter's own entries, (2) assigning each
// entry to the single deepest node it belongs to (an entry's tags may satisfy
// several nodes — e.g. both `#forms` and `#stores` under `#frontend` — so it
// renders exactly once, at the most specific of its matching nodes, tie-broken
// the same way `buildHierarchy` tie-breaks ambiguous parents: smallest member
// set, then alphabetical), and (3) walking the forest to emit headings +
// entries. Entries with no tags at all render flat, directly under the
// chapter H1 — no synthetic grouping is invented for them.
// ---------------------------------------------------------------------------

/** Unique key for a Definition within a chapter (kind + name — never just name). */
function moduleKeyOf(e: Definition): string {
  return `${e.kind}:${e.name}`;
}

/** Build the `tag -> module keys` map `buildHierarchy` expects, plus the reverse lookup to entries. */
function buildTagIndex<E extends Definition>(entries: E[]): {
  byTag: Map<string, Set<string>>;
  byKey: Map<string, E>;
} {
  const byTag = new Map<string, Set<string>>();
  const byKey = new Map<string, E>();
  for (const e of entries) {
    const key = moduleKeyOf(e);
    byKey.set(key, e);
    for (const t of e.tags) {
      const set = byTag.get(t) ?? new Set<string>();
      set.add(key);
      byTag.set(t, set);
    }
  }
  return { byTag, byKey };
}

/** Pretty-print a tag as a chapter heading — same convention as a breadcrumb slug. */
function tagHeadingTitle(tag: string): string {
  return scopeHeadingTitle(tag.replace(/^#/, ''));
}

/**
 * Assign every module to the single TagNode it renders under: the deepest
 * node whose own members are not already covered by one of its children
 * (a parent's `members` include every descendant's members by construction —
 * see `buildHierarchy`), tie-broken like `pickPrimaryParent` when a module's
 * tags satisfy more than one such node (smallest member set, then alpha).
 */
export function assignLeafNodes(roots: TagNode[]): Map<string, TagNode> {
  const allNodes: TagNode[] = [];
  const collect = (n: TagNode): void => { allNodes.push(n); n.children.forEach(collect); };
  roots.forEach(collect);

  const candidatesByModule = new Map<string, TagNode[]>();
  for (const node of allNodes) {
    const childMembers = new Set(node.children.flatMap(c => c.members));
    for (const m of node.members) {
      if (childMembers.has(m)) continue; // covered by a more specific descendant
      const list = candidatesByModule.get(m) ?? [];
      list.push(node);
      candidatesByModule.set(m, list);
    }
  }

  const assignment = new Map<string, TagNode>();
  for (const [moduleKey, candidates] of candidatesByModule) {
    const winner = candidates.length === 1 ? candidates[0] : [...candidates].sort((a, b) => {
      if (a.members.length !== b.members.length) return a.members.length - b.members.length;
      return a.tag.localeCompare(b.tag);
    })[0];
    assignment.set(moduleKey, winner);
  }
  return assignment;
}

/**
 * A `TagNode` reduced for rendering: `ownMembers` are the module keys that
 * render directly under it (per {@link assignLeafNodes}), `impliedTags` is
 * every tag+alias spent on its heading (across every node fused into it by
 * corridor compression, below) and `title` is Title Case, " > " joined when
 * compressed.
 */
export interface TagRenderNode {
  title: string;
  impliedTags: Set<string>;
  ownMembers: string[];
  children: TagRenderNode[];
}

/**
 * Reduce a `TagNode` (+ its assigned members) into a render tree, collapsing
 * corridors along the way: a node with no entries of its own and exactly one
 * child fuses with that child into one compound heading ("a > b > c") instead
 * of a chain of otherwise-empty headings. Recurses bottom-up so chains of
 * arbitrary length collapse in one pass — mirrors the folder-breadcrumb
 * corridor compression this replaces.
 */
export function buildTagRenderTree(node: TagNode, assignment: ReadonlyMap<string, TagNode>): TagRenderNode {
  const ownMembers = node.members
    .filter(m => assignment.get(m) === node)
    .sort((a, b) => a.localeCompare(b));
  const children = node.children.map(c => buildTagRenderTree(c, assignment));
  const impliedTags = new Set([node.tag, ...node.aliases]);

  if (ownMembers.length === 0 && children.length === 1) {
    const only = children[0];
    return {
      title: `${tagHeadingTitle(node.tag)} > ${only.title}`,
      impliedTags: new Set([...impliedTags, ...only.impliedTags]),
      ownMembers: only.ownMembers,
      children: only.children,
    };
  }
  return { title: tagHeadingTitle(node.tag), impliedTags, ownMembers, children };
}

/**
 * Depth-first walk over the compressed render tree. Each node emits a heading
 * at `depth` (skipped entirely when it carries neither an entry nor a
 * descendant — the tie-break in {@link assignLeafNodes} can, rarely, leave a
 * leaf-only node with zero assigned members), then its own entries, then its
 * children. `ancestorTags` accumulates every tag already spent as a heading on
 * the path down, so `renderEntryTagsInline` doesn't repeat it in the entry's
 * own "Tags:" line.
 */
function emitTagTree<E extends Definition>(
  ctx: BundleContext,
  node: TagRenderNode,
  spec: SectionSpec<E>,
  depth: number,
  byKey: ReadonlyMap<string, E>,
  ancestorTags: ReadonlySet<string>,
): string {
  if (node.ownMembers.length === 0 && node.children.length === 0) return '';
  let out = `${headingLine(depth, node.title)}\n\n`;
  const here = new Set([...ancestorTags, ...node.impliedTags]);
  for (const m of node.ownMembers) {
    out += emitDefinitionEntry(ctx, byKey.get(m)!, spec, depth + 1, here);
  }
  for (const child of node.children) {
    out += emitTagTree(ctx, child, spec, depth + 1, byKey, here);
  }
  return out;
}

/**
 * Emit a chapter (Roles / Templates / Procedures / Tools /
 * Memory / Policies / Flows) from a single declarative `SectionSpec`.
 *
 * When entries are tagged Definitions, the chapter is grouped by the single
 * centralized tag hierarchy (`buildHierarchy`); untagged entries (and every
 * entry when a spec's entries are not Definitions at all — Tools, Memory)
 * render flat, directly under the chapter H1.
 */
export function emitChapter<E>(ctx: BundleContext, spec: SectionSpec<E>): string {
  if (spec.entries.length === 0) return '';
  let out = openSection(ctx, spec.title, spec.intro);
  if (spec.renderFlat) {
    return out + spec.renderFlat(spec.entries) + '\n';
  }
  if (!spec.renderEntry) return out;

  // Detect tagged Definition entries so non-Definition specs (Tools, Memory)
  // keep the legacy flat layout without paying the hierarchy-build cost.
  const hasTags = spec.entries.some(
    e => Array.isArray((e as unknown as Definition).tags) && (e as unknown as Definition).tags.length > 0,
  );

  if (!hasTags) {
    for (const source of spec.entries) {
      const entry = spec.renderEntry(source);
      out += `${headingLine(2, headingWithAbout(entry.heading, entry.prelude))}\n`;
      // Tags line and id are Definition-only concepts; skip when the entry shape is foreign.
      const asDef = source as unknown as Definition;
      if (Array.isArray(asDef.tags)) {
        entry.refId = definitionId(asDef, ctx);
        const tagsLine = renderEntryTagsInline(asDef, new Set());
        if (tagsLine) out += `${tagsLine}\n\n`;
      }
      out += `${entry.body.trim()}\n\n`;
      spec.afterEmit?.(source, entry);
    }
    return out;
  }

  // Tag-hierarchy path: entries with no tags at all render flat first (no
  // synthetic grouping invented for them), then the tag forest.
  const defSpec = spec as unknown as SectionSpec<Definition>;
  const untagged = defSpec.entries.filter(e => e.tags.length === 0);
  for (const source of untagged) {
    out += emitDefinitionEntry(ctx, source, defSpec, 2);
  }

  const { byTag, byKey } = buildTagIndex(defSpec.entries);
  const roots = buildHierarchy(byTag);
  const assignment = assignLeafNodes(roots);
  for (const root of roots) {
    const rendered = buildTagRenderTree(root, assignment);
    out += emitTagTree(ctx, rendered, defSpec, 2, byKey, new Set());
  }
  return out;
}
