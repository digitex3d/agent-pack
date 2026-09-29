// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * apx structured format — the typed mirror of a compiled agent bundle.
 *
 * One document per agent (`<agent>.ap.json`): the agent block (root) plus the
 * closure of everything it imports — policies, role, templates, procedures,
 * flows, team — as addressable blocks with stable ids and
 * uniform cross-references (`ApRef`). The format is the validated schema in
 * `experiments/apdoc/structured-format.example.jsonc`.
 *
 * The document is produced by a passive recorder inside the existing bundle
 * pipeline (see recorder.ts) — never by re-parsing the rendered markdown.
 */

/**
 * A pointer to another block. `id` is the stable identity of the target
 * (never content-derived); `target` is the readable `namespace/name` address.
 * Unresolved references keep the source text in `target`, carry `id: null`
 * and `resolved: false` — failure is data, never silent.
 */
export interface ApRef {
  id: string | null;
  target: string;
  kind: string;
  resolved?: false;
}

/** A shape binding (`AS`/`LENS`): calibrated force level + template ref. */
export interface ApShape {
  force: number;
  ref: ApRef;
}

/**
 * One keyword line. `keyword` is the family base (MUST, ALWAYS, DO, …) after
 * desugaring; `force` is the numeric level (-1..2) for force-level families,
 * null for plain bullet keywords (DO, BY, LOG, …). The resolved intro phrases
 * live once in `meta.forceLevels` — clients join `forceLevels[keyword][force]`.
 * The optional `body` carries the indented children of a bodied keyword head
 * that is not a dedicated control construct.
 */
export interface ApDirectiveNode {
  type: 'directive';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  keyword: string;
  force: number | null;
  text: string;
  chars: number;
  body?: ApNode[];
  /** The template the directive's subject takes (`MEM <event>` + `AS <template>`). */
  shape?: ApShape;
}

/** `RUN <name>` — invocation of a runnable (procedure/flow), always a Ref. */
export interface ApRunNode {
  type: 'run';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  ref: ApRef;
  chars: number;
}

/** Verbatim text: RAW regions, prose lines. */
export interface ApTextNode {
  type: 'text';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  raw: string;
  chars: number;
}

/** `IF <condition>:` with its two branches; ELSE is the second branch, not a node. */
export interface ApIfNode {
  type: 'if';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  condition: string;
  chars: number;
  then: ApNode[];
  else: ApNode[];
}

/** `UNTIL <condition>:` loop head. */
export interface ApUntilNode {
  type: 'until';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  condition: string;
  chars: number;
  body: ApNode[];
}

/** `WHEN <trigger>:` block inside a body. */
export interface ApWhenNode {
  type: 'when';
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  condition: string;
  chars: number;
  body: ApNode[];
}

/** A flow STEP: signature lifted to fields (title/by/context/shape), DOs in body. */
export interface ApStepNode {
  type: 'step';
  title: string;
  by: ApRef | null;
  context: string | null;
  shape: ApShape | null;
  chars: number;
  body: ApNode[];
}

/** PARALLEL container: its steps run together. */
/**
 * `IN <store>:` — the steps under it work in that store. The store is a Ref,
 * never a bare name, so the link is checkable like every other cross-block
 * reference in the format.
 */
export interface ApInNode {
  type: 'in';
  chars: number;
  indent?: number;
  store: ApRef;
  body: ApNode[];
}

export interface ApParallelNode {
  type: 'parallel';
  chars: number;
  steps: ApStepNode[];
}

/**
 * A procedure's `DISTILL` mark, closing its body: the script id, its level, and
 * the procedure's contract — output (`AS`) and optional input (`LENS-IN`) —
 * with an example JSON value of each, generated from their templates.
 */
export interface ApDistillNode {
  type: 'distill';
  force: number;
  id: string;
  shape: ApShape;
  input?: ApShape;
  outputExample: string;
  inputExample?: string;
  chars: number;
}

export type ApNode =
  | ApDistillNode
  | ApInNode
  | ApDirectiveNode
  | ApRunNode
  | ApTextNode
  | ApIfNode
  | ApUntilNode
  | ApWhenNode
  | ApStepNode
  | ApParallelNode;

/** Machine-resolved slot type (mirror of shapeSchema's SlotTypeSpec, JSON-safe). */
export type ApSlotType =
  | { kind: 'text'; minWords?: number; maxWords?: number; regex?: string }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'enum'; values: string[] }
  | { kind: 'shape'; ref: ApRef }
  | { kind: 'list'; ref: ApRef; min?: number; max?: number }
  | { kind: 'any'; raw: string };

/** One template slot: resolved type + nested rules as plain directives. */
export interface ApSlot {
  name: string;
  optional: boolean;
  type: ApSlotType;
  description?: string;
  rules: ApDirectiveNode[];
  chars: number;
}

/**
 * One addressable block — the PLAIN DATA contract. Universal fields live
 * top-level on every kind; kind-specific structure lives in `args` (template
 * slots/layout/example, agent identity, team
 * members/routing/shared). The behavioural side (address, seal) lives in the
 * `ApBlock` class (block.ts), which implements this shape.
 */
export interface ApBlockData {
  kind: string;
  name: string;
  namespace: string;
  /** Stable identity: `<pfx>-<8hex>` of sha256(kind|namespace|name). */
  id: string;
  /** Content fingerprint: sha256:16hex of the canonical serialization. */
  contentHash: string;
  chars: number;
  about: string | null;
  tags: string[];
  applies: string | null;
  when: string;
  args: Record<string, unknown>;
  body: ApNode[];
}

/**
 * The md-projection metadata — EVERYTHING the md decompiler needs beyond the
 * blocks themselves, serialized into the document (`meta.md`): a consumer of
 * the .ap.json alone must be able to reconstruct the md byte-for-byte.
 */
export interface ApMdMeta {
  /** Bootstrap prose (team membership + shared + runtime defaults), RAW-clean. */
  bootstrap: string;
  /** Kind introductions, already rendered, keyed by kind — every kind the document holds. */
  intros: Record<string, string>;
  /** Body substitution vars ({{name}} …). */
  vars: Record<string, string>;
  /** address → auto tags ('#segment') from the source breadcrumb. */
  breadcrumbs: Record<string, string[]>;
  /** Leading blank lines of the agent body (metadata-strip artifact). */
  agentBodyLead: number;
  /** Whether the OWNS fence renders in the body (adapter did not claim it). */
  ownsInBody: boolean;
  /** address → provenance — which part of the md each block belongs to. */
  provenance: Record<string, string>;
  /** address → node index of the block-level AS line in the source body. */
  shapePos: Record<string, number>;
  /** store address → what its backing makes of it (file, commands, limits). */
  stores?: Record<string, ApStoreProjection>;
}

/** Which part of the md an outline item belongs to — numbering restarts per part. */
export type ApOutlinePart = 'definition';

/**
 * One heading of the md, in order.
 *   chapter          — `# N. Title`, then its intro (meta.md.intros[intro])
 *   group            — a tag group heading at `depth`
 *   entry            — a block's own section, heading at `depth`
 *   crossReferences  — tags shared by at least two entries
 *   part             — a new part opens (the run log), numbering restarts
 */
export type ApOutlineItem =
  | { type: 'chapter'; part: ApOutlinePart; title: string; kind: string; intro: string | null }
  | { type: 'group'; part: ApOutlinePart; depth: number; title: string }
  | { type: 'entry'; part: ApOutlinePart; depth: number; address: string }
  | { type: 'crossReferences'; title: string; rows: { tag: string; entries: { id: string; name: string }[] }[] };

/**
 * A store as its backing type makes it: the file it lives in, the exact
 * commands (with this store's own fields), and the slots it cannot hold and
 * why. Computed by the store type plugin, once.
 * `unknownType` is set instead when TYPE names no registered backing.
 */
export interface ApStoreProjection {
  type: string;
  location: string;
  usage: string[];
  rejects: Record<string, string>;
  unknownType?: { available: string[] };
}

export interface ApDocumentMeta {
  /** Address of the root (agent) block in `blocks`. */
  root: string;
  /** Resolved force-level intros: family → level (as string) → phrase. */
  forceLevels: Record<string, Record<string, string>>;
  /** Resolved enum primitives (e.g. CONTEXT modes), neutral prose. */
  enums: Record<string, Record<string, string>>;
  /**
   * How the active adapter's harness runs a flow from its compiled script
   * (`renderings.FLOW.run`, `{script}` = the script's path, `{steps}` = how to
   * read the steps). Absent = the flow's steps are carried out as written.
   */
  flowRun?: string;
  /** Md-projection metadata — present when the document renders prose. */
  md?: ApMdMeta;
}

