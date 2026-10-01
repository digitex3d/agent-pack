// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * ApBlock — the abstract base every block kind inherits from.
 *
 * The base owns what is universal: identity fields, the address, the sealing
 * protocol (measure → stable id → contentHash) and the JSON projection
 * (`toJSON`, invoked automatically by JSON.stringify). Each concrete kind
 * (blocks.ts) declares its own typed fields and contributes them through the
 * single `argsJson()` hook — the ONE place where that kind's JSON shape is
 * known. The CHILD structure (nodes, slots, refs) stays plain data from
 * types.ts: classes wrap the block level only, never the tree below.
 */
import type { ApBlockData, ApNode, ApShape, ApSource } from './types.js';
import { stableId, blockContentHash } from './ids.js';
import { measure } from './measure.js';
import { renderNodes, shapeLine, MdEnv } from '../../adapters/md/toolkit.js';

/** The universal (identity + catalog) fields a block is born with. */
export interface ApBlockInit {
  name: string;
  namespace: string;
  about?: string | null;
  tags?: string[];
  applies?: string | null;
  when?: string;
}

export abstract class ApBlock {
  abstract readonly kind: string;
  /** The short prefix this kind stamps on its ids (e.g. 'tpl') — declared by each class. */
  protected abstract readonly idPrefix: string;
  name: string;
  namespace: string;
  id = '';
  contentHash = '';
  chars = 0;
  about: string | null;
  tags: string[];
  applies: string | null;
  when: string;
  body: ApNode[] = [];
  /**
   * A block-level `AS <template>` binding captured during the body walk
   * (e.g. a procedure's trailing output shape). Subclasses decide whether and
   * where it appears in their args.
   */
  shape: ApShape | null = null;
  /** A `LENS-IN <template>` binding: the shape of what comes in (an agent's requests, a procedure's input). */
  lensIn: ApShape | null = null;
  /**
   * A procedure's `DISTILL` level, captured during the body walk — the builder
   * turns it into the block's distill node. Never serialized.
   */
  distill: number | null = null;
  /**
   * Node index where the AS line sat in the source body — presentation
   * metadata for the md projection, never serialized.
   */
  shapePos: number | null = null;
  /**
   * Where the block was written — its file and header position. Provenance,
   * stamped by the builder, never serialized: null on a revived block.
   */
  source: ApSource | null = null;

  constructor(init: ApBlockInit) {
    this.name = init.name;
    this.namespace = init.namespace;
    this.about = init.about ?? null;
    this.tags = init.tags ?? [];
    this.applies = init.applies ?? null;
    this.when = init.when ?? 'always';
  }

  /** The address the document (and every Ref) knows this block by. */
  get address(): string {
    return `${this.namespace}/${this.name}`;
  }

  /** Kind-specific args, in each kind's canonical order. Base: none. */
  protected argsJson(): Record<string, unknown> {
    return {};
  }

  /**
   * The canonical plain shape — field order fixed here, once, for every kind.
   * JSON.stringify calls this automatically, so a sealed block serializes
   * identically wherever it travels.
   */
  toJSON(): ApBlockData {
    return {
      kind: this.kind,
      name: this.name,
      namespace: this.namespace,
      id: this.id,
      contentHash: this.contentHash,
      chars: this.chars,
      about: this.about,
      tags: this.tags,
      applies: this.applies,
      when: this.when,
      args: this.argsJson(),
      body: this.body,
    };
  }

  /**
   * The md prose of this block's body — its side of the md projection
   * (heading, numbering and chapter placement belong to the document).
   * Subclasses with a bespoke rendering (templates) override.
   */
  asMdBody(env: MdEnv): string {
    const lines: string[] = [];
    if (this.shape && this.shapePos !== null) {
      // The AS line renders where it sat in the source.
      lines.push(...renderNodes(env, this.body.slice(0, this.shapePos)));
      lines.push(shapeLine(env, this.shape));
      lines.push(...renderNodes(env, this.body.slice(this.shapePos)));
    } else {
      if (this.shape) lines.push(shapeLine(env, this.shape));
      lines.push(...renderNodes(env, this.body));
    }
    return lines.join('\n');
  }

  /**
   * Finalize: measure `chars` (stamped in place on the shared child data),
   * stamp the stable `id`, then the `contentHash` over the canonical shape
   * (id/contentHash excluded — see ids.ts). Idempotent.
   */
  seal(): void {
    const shape = this.toJSON();
    this.chars = measure(shape);
    this.id = stableId(this.idPrefix, this.kind, this.namespace, this.name);
    this.contentHash = blockContentHash(shape);
  }
}
