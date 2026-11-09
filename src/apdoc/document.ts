// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * ApDocument — the in-memory ap document. THE domain object of apx.
 *
 * The recorder assembles one from the pipeline's events; every artifact is a
 * REPRESENTATION of it, obtained through an `as*` projection:
 *
 *   asJson()          → the `.ap.json` artifact (canonical, root first)
 *   asMd()            → (future, R7) the prose bundle as a projection
 *   asLibraryMap()    → (future, R7) the library.map.json entry set
 *
 * Construction protocol: `add()` the blocks, then `seal()` exactly once —
 * sealing measures `chars`, stamps the stable `id` and the `contentHash` of
 * every block. Blocks hold plain serializable data (types.ts is the data
 * contract); the class only adds addressing, queries and projections — no
 * consumer ever needs `instanceof` (duck-typing survives module realms).
 */
import { resolve as resolvePath } from 'node:path';
import type { ApDocumentMeta, ApMdMeta, ApOutlineItem, ApOutlinePart, ApRef, ApNode, ApLine } from './types.js';
import { walk, type LineHead } from './nodes.js';
import { DISTILLED_DIR } from '../apx/paths.js';
import type { ApBlock } from './block.js';
import type { AgentBlock, DimensionBlock, DomainBlock, TemplateBlock } from './blocks.js';
import { DECORATOR_MARK, WITHIN_DECORATOR } from '../decorators.js';
import type { PerimeterGlobs } from '../primitives.js';
import { literalGlob } from '../services/glob.js';
import { slotSpecsOf, type SlotSpec, type SlotResolver } from '../shapeSchema.js';
import { KIND_STRATEGIES, strategyOf, installPluginKind } from './blocks.js';
import { registerPlugin } from '../plugins.js';
import { FORMULAS } from '../formulas.js';
import { buildHierarchy } from '../services/tags.js';
import { assignLeafNodes, buildTagRenderTree, type TagRenderNode } from '../bundlers/sections.js';

/**
 * Where a block came from — construction metadata, NEVER serialized (it does
 * not enter toJSON/contentHash). The md layout reads it: only 'definition'
 * blocks form the chapters.
 */
export type BlockProvenance = 'definition' | 'team' | 'agent';

export class ApDocument {
  readonly schemaVersion = 1 as const;
  private blocks = new Map<string, ApBlock>();
  private provenance = new Map<string, BlockProvenance>();

  constructor(private readonly docMeta: ApDocumentMeta) {}

  /** Document metadata (root address, resolved tables, md-projection inputs). */
  get meta(): ApDocumentMeta {
    return this.docMeta;
  }

  /**
   * Rehydrate a document from its canonical JSON — the decompiler's entry
   * point: the string alone suffices (no sources, no filesystem). Blocks are
   * revived as their typed classes via the kind-strategy registry; sealed
   * fields (id/contentHash/chars) are restored as-is, never recomputed;
   * provenance and shape positions come back from meta.md.
   */
  static fromJson(text: string): ApDocument {
    const data = JSON.parse(text) as {
      meta: ApDocumentMeta;
      blocks: Record<string, import('./types.js').ApBlockData>;
    };
    const doc = new ApDocument(data.meta);
    // The plugins its blocks belong to: kinds of this process before any block is revived.
    for (const spec of Object.values(data.meta.plugins ?? {})) { registerPlugin(spec); installPluginKind(spec); }
    const md = data.meta.md;
    for (const [address, blockData] of Object.entries(data.blocks)) {
      const strategy = strategyOf(blockData.kind);
      if (!strategy) continue;
      const block = strategy.revive(blockData);
      const provenance = (md?.provenance[address] ?? 'definition') as BlockProvenance;
      doc.add(block, provenance);
      const pos = md?.shapePos[address];
      if (pos !== undefined) block.shapePos = pos;
    }
    return doc;
  }

  // ------------------------------------------------------------ construction

  /** Register a block under its own address. Last write wins on collision. */
  add(block: ApBlock, provenance: BlockProvenance = 'definition'): void {
    this.blocks.set(block.address, block);
    this.provenance.set(block.address, provenance);
  }

  /** Finalize every block — each block seals itself (measure → id → hash). */
  seal(): void {
    for (const block of this.blocks.values()) block.seal();
  }

  /** Attach the md-projection metadata — SERIALIZED into meta.md. */
  attachMdSource(source: ApMdMeta): void {
    this.docMeta.md = source;
  }

  /** The md-projection metadata — what the decompiler reads. */
  get mdSource(): ApMdMeta | null {
    return this.docMeta.md ?? null;
  }

  // ---------------------------------------------------------------- queries

  /** The agent block the document is rooted at. */
  root(): ApBlock | null {
    return this.blocks.get(this.docMeta.root) ?? null;
  }

  block(address: string): ApBlock | null {
    return this.blocks.get(address) ?? null;
  }

  /** Follow a Ref to its block, when the target lives in this document. */
  resolve(ref: ApRef): ApBlock | null {
    return this.blocks.get(ref.target) ?? null;
  }


  /**
   * Every node of each block's body, at any depth, with its block and the nodes
   * containing it. Body nodes only — a template's slot rules and a team's
   * routing are not body nodes.
   */
  nodes(): { node: ApNode; block: ApBlock; containers: ApNode[] }[] {
    // A COMPUTE block's REQUIRE and ENSURE sections are body nodes too: their lines are judged and listed.
    return this.all().flatMap(block => [...walk([...(block.require ?? []), ...block.body, ...(block.ensure ?? [])])].map(w => ({ ...w, block })));
  }

  /**
   * The stores the agent itself works in: every store but those only a
   * dimension's `STORE` names — their records live in the dimension's cache,
   * so neither its chapter nor its commands may offer a second place for them.
   * A store an `IN` names too is the agent's, and shows as ever.
   */
  agentStores(): ApBlock[] {
    const ofDimensions = new Set((this.byKind('dimension') as DimensionBlock[]).flatMap(d => (d.store ? [d.store.target] : [])));
    if (ofDimensions.size === 0) return this.byKind('store');
    const inUse = new Set(this.nodes().flatMap(({ node }) => (node.type === 'in' ? [node.store.target] : [])));
    return this.byKind('store').filter(s => !ofDimensions.has(s.address) || inUse.has(s.address));
  }

  /**
   * Every keyword line of each block's body — of one primitive (`DO`, `IF`,
   * `STEP`, …) when given — with where it was written. Prose and compiler marks
   * are no lines; neither are a template's slot rules or a team's routing, which
   * are not body nodes.
   */
  lines(primitive?: string): ApLine[] {
    const out: ApLine[] = [];
    for (const { node, block, containers } of this.nodes()) {
      const head = (node as unknown as { asLine(): LineHead | null }).asLine();
      if (!head || (primitive !== undefined && head.primitive !== primitive)) continue;
      out.push({
        ...head,
        force: node.type === 'directive' ? node.force : null,
        file: block.source?.file ?? null,
        line: node.pos?.line ?? null,
        col: node.pos?.col ?? null,
        endCol: node.pos?.endCol ?? null,
        block,
        containers,
      });
    }
    return out;
  }

  /** The line written at `file:line`, or null. */
  lineAt(file: string, line: number): ApLine | null {
    const path = resolvePath(file);
    return this.lines().find(l => l.file === path && l.line === line) ?? null;
  }

  /** The slots of the template a Ref points at — null when it is no template of this document. */
  slotsOf(ref: ApRef): SlotSpec[] | null {
    const target = this.resolve(ref);
    return target?.kind === 'template' ? slotsOfTemplate(target as TemplateBlock) : null;
  }

  /** A template of the document, by name — or null. */
  templateNamed(name: string): TemplateBlock | null {
    return (this.byKind('template').find(b => b.name === name) as TemplateBlock | undefined) ?? null;
  }

  /** The document's templates by name — how nested `<template>` slots resolve. */
  slotResolver(): SlotResolver {
    return name => {
      const template = this.templateNamed(name);
      return template ? slotsOfTemplate(template) : null;
    };
  }

  /**
   * What the decorators of one key above a definition name (`@WITHIN web` over
   * its AGENT): the blocks, in order — null when none of that key decorates it.
   * They wrap its whole body (src/apdoc/builder.ts walk), outermost first.
   */
  definitionUses(block: ApBlock, key: string): ApBlock[] | null {
    let body = block.body;
    let found: ApBlock[] | null = null;
    while (body.length === 1 && body[0].type === 'directive' && body[0].keyword.startsWith(DECORATOR_MARK)) {
      const node = body[0];
      if (node.keyword === `${DECORATOR_MARK}${key}`) found = [...(found ?? []), ...(node.uses ?? []).map(r => this.resolve(r)).filter((b): b is ApBlock => b !== null)];
      body = node.body ?? [];
    }
    return found;
  }

  /** The domains the agent works within — `@WITHIN` above its AGENT; null when it names none. */
  domains(): DomainBlock[] | null {
    const root = this.root();
    return root ? this.definitionUses(root, WITHIN_DECORATOR.key) as DomainBlock[] | null : null;
  }

  /**
   * The agent's perimeter as globs: the WRITES globs of the domains it works
   * within — plus the programs' folder when a program carries out some of its
   * work, writing its programs being always allowed — and their READS globs
   * (null when none of them says READS: whatever it needs). A file a formula
   * puts within, or leaves to the agent (`!`), is a glob of its own. Null when
   * no `@WITHIN` decorates the agent.
   */
  perimeter(): PerimeterGlobs | null {
    const domains = this.domains();
    if (!domains) return null;
    const programs = Object.values(this.meta.executors ?? {}).some(e => e.program) ? [`${DISTILLED_DIR}/**`] : [];
    const side = (keyword: 'WRITES' | 'READS') => {
      const parts = domains.map(d => d.side(keyword));
      const uncertain: Record<string, number> = Object.assign({}, ...parts.map(p => p.uncertain));
      const globs = parts.flatMap(p => p.globs);
      return {
        globs,
        all: [...globs, ...[...parts.flatMap(p => p.within), ...Object.keys(uncertain)].map(literalGlob)],
        judged: { formulas: domains.flatMap(d => d.formulas.filter(f => f.keyword === keyword).map(f => f.formula)), uncertain },
      };
    };
    const writes = side('WRITES');
    const reads = side('READS');
    const perimeter: PerimeterGlobs = { writes: [...writes.all, ...programs], reads: domains.some(d => d.declares('READS')) ? reads.all : null };
    if (domains.some(d => d.formulas.length > 0)) {
      perimeter.judged = { writes: writes.judged, reads: reads.judged };
      perimeter.shown = { writes: [...writes.globs, ...programs], reads: reads.globs };
    }
    return perimeter;
  }

  /** Every block, in insertion (production) order. */
  all(): ApBlock[] {
    return [...this.blocks.values()];
  }

  byKind(kind: string): ApBlock[] {
    return [...this.blocks.values()].filter(b => b.kind === kind);
  }

  /** Blocks of one provenance, in insertion (production) order. */
  byProvenance(p: BlockProvenance): ApBlock[] {
    return [...this.blocks.values()].filter(b => this.provenance.get(b.address) === p);
  }

  // ------------------------------------------------------------ projections

  /**
   * The JSON representation: canonical field order, root block first, then
   * INSERTION order — the block order is semantic (it is the chapter entry
   * order), so serialization must preserve it for the decompiler round trip.
   * `debug` is reserved for the provenance profile (source/line/exported)
   * once those fields are recorded.
   */
  asJson(_opts: { debug?: boolean } = {}): string {
    const ordered: Record<string, ApBlock> = {};
    const rootKey = this.docMeta.root;
    const rootBlock = this.blocks.get(rootKey);
    if (rootBlock) ordered[rootKey] = rootBlock;
    for (const [key, block] of this.blocks) {
      if (key === rootKey) continue;
      ordered[key] = block;
    }
    return `${JSON.stringify({ schemaVersion: this.schemaVersion, meta: this.docMeta, blocks: ordered }, null, 2)}\n`;
  }

  // ----------------------------------------------------------------- layout

  /**
   * Walk one part's chapters, reporting every heading to the visitor. The md
   * outline is built on THIS walk.
   */
  walkChapters(provenance: BlockProvenance, visitor: ChapterVisitor): void {

    // The bound role is IN the document (it is the agent's identity) but the
    // Roles chapter excludes it — identity fused into the Identity block.
    const boundRoles = new Set(((this.root() as AgentBlock | null)?.roles ?? []).map(r => r.target));

    // A store only a dimension names is the dimension's: its chapter shows the dimension, never the store.
    const stores = new Set(this.agentStores().map(s => s.address));
    const partBlocks = this.byProvenance(provenance);
    for (const strategy of KIND_STRATEGIES) {
      if (!strategy.entries) continue; // chapter kinds only
      const entries = partBlocks.filter(
        b => b.kind === strategy.kind && !boundRoles.has(b.address) && (b.kind !== 'store' || stores.has(b.address)),
      );
      if (entries.length === 0) continue;
      visitor.chapter?.(strategy.chapterTitle ?? strategy.kind, strategy.kind);
      walkEntries(entries, visitor);
    }
  }

  /**
   * The md outline — every heading, in order: the ONE structure the md
   * renderer walks, computed from the document on demand.
   *
   * The kind chapters with their tag groups, then the cross-references.
   */
  computeOutline(): ApOutlineItem[] {
    const items: ApOutlineItem[] = [];
    const part: ApOutlinePart = 'definition';
    this.walkChapters(part, {
      chapter: (title, kind) => items.push({ type: 'chapter', part, title, kind, intro: kind }),
      group: (depth, title) => items.push({ type: 'group', part, depth, title }),
      entry: (block, depth) => items.push({ type: 'entry', part, depth, address: block.address }),
    });

    const D = FORMULAS.document;
    const rows = this.crossReferenceRows(items);
    if (rows.length > 0) items.push({ type: 'crossReferences', title: D.crossReferences.chapter, rows });
    return items;
  }

  /**
   * Explicit tags shared by
   * at least two definition entries, alphabetical — each with its
   * entries in COLLECTION order (the legacy walked the strategy collections,
   * not the emission order).
   */
  private crossReferenceRows(items: ApOutlineItem[]): { tag: string; entries: { id: string; name: string }[] }[] {
    const listed = new Set<string>();
    for (const item of items) if (item.type === 'entry' && item.part === 'definition') listed.add(item.address);
    const byTag = new Map<string, { id: string; name: string }[]>();
    for (const block of this.byProvenance('definition')) {
      if (!listed.has(block.address)) continue;
      for (const t of block.tags) {
        const tag = `#${t}`;
        const bucket = byTag.get(tag) ?? [];
        bucket.push({ id: block.id, name: block.name });
        byTag.set(tag, bucket);
      }
    }
    return [...byTag.entries()]
      .filter(([, entries]) => entries.length >= 2)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, entries]) => ({ tag, entries }));
  }

  // asLibraryMap(): R7 — the library.map.json entries as a projection.
}

/** A template block's slots as the validator and the schema compiler read them. */
function slotsOfTemplate(template: TemplateBlock): SlotSpec[] | null {
  return template.slots ? slotSpecsOf(template.slots) : null;
}

// ---------------------------------------------------------------------------
// Layout machinery — the chapter walk the md outline is built on.
// ---------------------------------------------------------------------------

/** What one part's walk reports — headings in emission order. */
export interface ChapterVisitor {
  /** An H1 chapter opens. `kind` is the chapter kind. */
  chapter?(title: string, kind: string): void;
  /** A tag-group heading at `depth` (H2+). */
  group?(depth: number, title: string): void;
  /** An entry heading at `depth`. */
  entry?(block: ApBlock, depth: number): void;
}

/** The chapter-grouping key — mirror of the renderer's moduleKeyOf. */
function keyOf(block: ApBlock): string {
  return `${block.kind}:${block.name}`;
}

function walkEntries(entries: ApBlock[], visitor: ChapterVisitor): void {
  const emitEntry = (block: ApBlock, depth: number): void => visitor.entry?.(block, depth);

  const hasTags = entries.some(b => b.tags.length > 0);
  if (!hasTags) {
    for (const block of entries) emitEntry(block, 2);
    return;
  }

  for (const block of entries.filter(b => b.tags.length === 0)) emitEntry(block, 2);

  const byTag = new Map<string, Set<string>>();
  const byKey = new Map<string, ApBlock>();
  for (const block of entries) {
    byKey.set(keyOf(block), block);
    for (const tag of block.tags) {
      const key = `#${tag}`; // the hierarchy speaks source-form tags
      const set = byTag.get(key) ?? new Set<string>();
      set.add(keyOf(block));
      byTag.set(key, set);
    }
  }
  const roots = buildHierarchy(byTag);
  const assignment = assignLeafNodes(roots);

  const walk = (node: TagRenderNode, depth: number): void => {
    if (node.ownMembers.length === 0 && node.children.length === 0) return;
    visitor.group?.(depth, node.title);
    for (const member of node.ownMembers) {
      const block = byKey.get(member);
      if (block) emitEntry(block, depth + 1);
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(buildTagRenderTree(root, assignment), 2);
}
