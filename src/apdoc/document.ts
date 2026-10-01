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
import { resolve as resolvePath } from 'path';
import type { ApDocumentMeta, ApMdMeta, ApOutlineItem, ApOutlinePart, ApRef, ApDistillNode, ApNode, ApLine } from './types.js';
import { walk, type LineHead } from './nodes.js';
import { DISTILLED_DIR } from '../apx/paths.js';
import { ApBlock } from './block.js';
import type { AgentBlock, TemplateBlock } from './blocks.js';
import { slotSpecsOf, type SlotSpec, type SlotResolver } from '../shapeSchema.js';
import { KIND_STRATEGIES, strategyOf } from './blocks.js';
import { FORMULAS } from '../formulas.js';
import { buildHierarchy } from '../services/tags.js';
import { assignLeafNodes, buildTagRenderTree, TagRenderNode } from '../bundlers/sections.js';

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

  /** Every DISTILL mark of the document, with the procedure whose body it closes. */
  distillMarks(): { mark: ApDistillNode; block: ApBlock }[] {
    return this.nodes()
      .filter((n): n is { node: ApDistillNode; block: ApBlock; containers: ApNode[] } => n.node.type === 'distill')
      .map(({ node, block }) => ({ mark: node, block }));
  }

  /**
   * Every node of each block's body, at any depth, with its block and the nodes
   * containing it. Body nodes only — a template's slot rules and a team's
   * routing are not body nodes.
   */
  nodes(): { node: ApNode; block: ApBlock; containers: ApNode[] }[] {
    return this.all().flatMap(block => [...walk(block.body)].map(w => ({ ...w, block })));
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

  /** The document's templates by name — how nested `<template>` slots resolve. */
  slotResolver(): SlotResolver {
    return name => {
      const template = this.byKind('template').find(b => b.name === name);
      return template ? slotsOfTemplate(template as TemplateBlock) : null;
    };
  }

  /**
   * The agent's perimeter as it applies: its OWNS globs, plus the distilled
   * scripts' folder when it has a procedure to distill — writing its own
   * scripts is always allowed. Null when the agent declares no perimeter.
   */
  owns(): string | null {
    const owns = (this.root() as AgentBlock | null)?.owns ?? null;
    if (!owns) return null;
    return this.distillMarks().some(d => d.mark.force >= 0) ? `${owns}, ${DISTILLED_DIR}/**` : owns;
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
    return JSON.stringify({ schemaVersion: this.schemaVersion, meta: this.docMeta, blocks: ordered }, null, 2) + '\n';
  }

  // ----------------------------------------------------------------- layout

  /**
   * Walk one part's chapters, reporting every heading to the visitor. The md
   * outline is built on THIS walk.
   */
  walkChapters(provenance: BlockProvenance, visitor: ChapterVisitor): void {

    // The bound role is IN the document (it is the agent's identity) but the
    // Roles chapter excludes it — identity fused into the Identity block.
    const boundRoleAddress = (this.root() as AgentBlock | null)?.role?.target;

    const partBlocks = this.byProvenance(provenance);
    for (const strategy of KIND_STRATEGIES) {
      if (!strategy.entries) continue; // chapter kinds only
      const entries = partBlocks.filter(
        b => b.kind === strategy.kind && b.address !== boundRoleAddress,
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
   * Explicit tags (declared minus the breadcrumb's automatic ones) shared by
   * at least two definition entries, alphabetical — each with its
   * entries in COLLECTION order (the legacy walked the strategy collections,
   * not the emission order).
   */
  private crossReferenceRows(items: ApOutlineItem[]): { tag: string; entries: { id: string; name: string }[] }[] {
    const listed = new Set<string>();
    for (const item of items) if (item.type === 'entry' && item.part === 'definition') listed.add(item.address);
    const breadcrumbs = this.mdSource?.breadcrumbs ?? {};
    const byTag = new Map<string, { id: string; name: string }[]>();
    for (const block of this.byProvenance('definition')) {
      if (!listed.has(block.address)) continue;
      const auto = new Set(breadcrumbs[block.address] ?? []);
      for (const t of block.tags) {
        const tag = `#${t}`;
        if (auto.has(tag)) continue;
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
