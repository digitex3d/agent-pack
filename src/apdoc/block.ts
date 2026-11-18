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
import type { ApDocument } from './document.js';
import { stableId, blockContentHash } from './ids.js';
import { measure } from './measure.js';
import { renderNodes, shapeLine, type MdEnv } from '../../adapters/md/toolkit.js';
import { scopeLabel } from '../withUse.js';
import { SCOPED_KINDS } from '../services/tags.js';

/** The universal (identity + catalog) fields a block is born with. */
export interface ApBlockInit {
  name: string;
  namespace: string;
  about?: string | null;
  tags?: string[];
  /** The perimeter tokens of its APPLIES line — `universal`, `team:<team>`, `agent:<agent>`. */
  scopes?: string[];
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
  scopes: string[];
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
  /** A `PROCEDURE*` / `PROCEDURE**` head: a delegate (1) or a program (2) carries the body out — src/executor.ts. */
  executor: number | null = null;
  /** A starred procedure's contract id (`exe-…`, `meta.executors`). */
  exe?: string;
  /** A COMPUTE block's `REQUIRE:` section — when its program refuses the input; null on any other block. */
  require: ApNode[] | null = null;
  /** A COMPUTE block's `ENSURE:` section — the guarantees on its result, which become tests. */
  ensure: ApNode[] | null = null;
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
    this.scopes = init.scopes ?? [];
    this.when = init.when ?? 'always';
  }

  /** The address the document (and every Ref) knows this block by. */
  get address(): string {
    return `${this.namespace}/${this.name}`;
  }

  /** `kind name` — how the block is named wherever it is cited. */
  get title(): string {
    return `${this.kind} ${this.name}`;
  }

  /** The apx verb that opens the block — `get`; a kind run step by step answers its own. */
  get opener(): string {
    return 'get';
  }

  /** `command opener id` — the command that opens it; the command is the apx's own. */
  opening(command: string): string {
    return `${command} ${this.opener} ${this.id}`;
  }

  /** `kind name  [command opener id]` — the title with the command that opens it. */
  cited(command: string): string {
    return `${this.title}  [${this.opening(command)}]`;
  }

  /** Its line in the agent's scope view — its citation; a kind that says more there overrides. */
  inScope(command: string): string {
    return this.cited(command);
  }

  /** A line followed by `— about` after the gap, when the block has an ABOUT — else the line as it is. */
  described(line: string, gap = '  '): string {
    return this.about ? `${line}${gap}— ${this.about}` : line;
  }

  /** `# kind name — about` — the heading of its views. */
  get heading(): string {
    return this.described(`# ${this.title}`, ' ');
  }

  /** `  #a #b` — its tags as its lines end with them; empty when it has none. */
  get tagged(): string {
    return this.tags.length > 0 ? `  ${this.tags.map(tag => `#${tag}`).join(' ')}` : '';
  }

  /** Where it holds, as a catalog shows it — a policy, a skill or a dimension (src/withUse.ts); null for any other kind. */
  get perimeter(): string | null {
    return SCOPED_KINDS.includes(this.kind) ? scopeLabel(this.scopes) : null;
  }

  /** `id  name  #tag  [perimeter]  — about` — its line in a catalog; the tags and the perimeter when it has them. */
  listed(): string {
    const perimeter = this.perimeter;
    return this.described(`${this.id}  ${this.name}${this.tagged}${perimeter !== null ? `  [${perimeter}]` : ''}`);
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
      ...(this.scopes.length ? { scopes: this.scopes } : {}),
      when: this.when,
      args: this.argsJson(),
      body: this.body,
    };
  }

  /** Its identity, when it is the document's root — who it is: an agent's role, a unit's members. None for any other block. */
  asMdIdentity(_env: MdEnv, _doc: ApDocument): string {
    return '';
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
