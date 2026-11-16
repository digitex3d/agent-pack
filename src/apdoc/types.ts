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
import type { ApBlock } from './block.js';
import type { ApCondCheck, ApCheckSpec } from '../check.js';
import type { RuleCriteria } from '../shapeCompiler.js';
import type { ApExecutorSpec } from '../executor.js';
import type { PluginSpec } from '../plugins.js';
import type { ApBackgroundWork, ApMark, HarnessInvocation } from '../delegation.js';

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
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  keyword: string;
  force: number | null;
  text: string;
  chars: number;
  body?: ApNode[];
  /**
   * The template the directive's subject takes (`MEM <event>` + `AS <template>`,
   * `WITH <skill> AS <template>:`), or — with `into` — the type of the variable its result fills.
   */
  shape?: ApShape;
  /** `DO … INTO <name>`: the session variable the step's result is stored in. */
  into?: ApRef;
  /** A decorator's (`@WITH …`, `@WITHIN …`): the blocks the work nested below is under — a tag already expanded; a flow's DELEGATE / FORK: the agent or team its BY names. */
  uses?: ApRef[];
  /** `DELEGATE … BY <agent>`, `FORK … BY <agent>`: who the line is handed to; absent = the default delegate, or a fork of whoever runs it. */
  by?: string;
  /** `DELEGATE … BY <harness>:<agent>`: the other harness the agent `by` runs on, launched from outside (src/harnesses.ts, D66). */
  harness?: string;
  /** `DELEGATE … AS <template>`: the shape of what is handed over — only what it holds is passed (src/delegation.ts). */
  as?: ApShape;
  /** `DELEGATE~` / `FORK~`: started in the background — a WAIT takes it back. */
  async?: true;
  /** A DELEGATE / COMPUTE line's contract id (`exe-…`, `meta.executors`) — src/executor.ts. */
  exe?: string;
  /** A flow's `DELEGATE~` / `FORK~`: its id in the apx's registry (`dlg-…`, `meta.background`) — src/delegation.ts. */
  work?: string;
  /** A `DELEGATE~` / `FORK~` inside an EACH: one piece per run, `<work>-<k>`. */
  element?: true;
  /** A flow's WAIT: the ids of the background work it takes back. */
  waits?: string[];
  /** A flow's MARK: its id (`mrk-…`, `meta.marks`); a DELEGATE of a contract list: the MARK it starts. */
  mark?: string;
  /** A DELEGATE of a contract list: the list (`DELEGATE <list> BY <agent>`). */
  list?: string;
  /** A MARK's `MAX <n>` — absent: the project's `mark.max`. */
  max?: number;
  /** A MARK's `WITHIN <domain>`: where its contracts may write beyond their zones. */
  within?: string;
}

/** `RUN <name>` — invocation of a runnable (procedure/flow), always a Ref. */
export interface ApRunNode {
  type: 'run';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  ref: ApRef;
  /** `RUN p INTO x` — the variable the procedure's result fills. */
  into?: ApRef;
  /** The type of that variable: the template its result is shaped as. */
  shape?: ApShape;
  chars: number;
}

/** Verbatim text: RAW regions, prose lines. */
export interface ApTextNode {
  type: 'text';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  raw: string;
  chars: number;
}

/** `IF <condition>:` with its two branches; ELSE is the second branch, not a node. */
export interface ApIfNode {
  type: 'if';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  /** The condition as written — '' when it is sealed (`IF!!`): only the apx's `meta.checks` holds it. */
  condition: string;
  /** `IF!` / `IF!!`: who answers for the condition, and how (src/check.ts). Absent on a plain IF. */
  check?: ApCondCheck;
  /** `IF*` / `IF**`: the condition is decided by a delegate (1) or a program (2) — src/executor.ts. */
  executor?: number;
  /** Its contract id (`exe-…`), when it has one of its own. */
  exe?: string;
  chars: number;
  then: ApNode[];
  else: ApNode[];
}

/**
 * `VAR <name>:` — the session variable the block beneath fills: its value is the
 * block's final outcome. `shape` is the variable's type, declared or inferred,
 * imposed on the block.
 */
export interface ApVarNode {
  type: 'var';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  var: ApRef;
  shape?: ApShape;
  chars: number;
  body: ApNode[];
}

/** `UNTIL <condition>:` loop head. */
export interface ApUntilNode {
  type: 'until';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  /** The condition as written — '' when it is sealed (`UNTIL!!`). */
  condition: string;
  /** The round limit the head wrote (`MAX <n>`) — on every loop someone other than the agent ends; absent on a plain UNTIL. */
  max?: number;
  /** `UNTIL!` / `UNTIL!!`: who answers for the condition, and its round limit. Absent on a plain UNTIL. */
  check?: ApCondCheck;
  /** `UNTIL*` / `UNTIL**`: the condition is decided by a delegate (1) or a program (2). */
  executor?: number;
  /** Its contract id (`exe-…`), when it has one of its own. */
  exe?: string;
  chars: number;
  body: ApNode[];
}

/** `WHEN <trigger>:` block inside a body. */
export interface ApWhenNode {
  type: 'when';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  /** Source indentation (spaces) within the block body; absent = 0. */
  indent?: number;
  condition: string;
  /** The `AS <template>` line written in its body: the shape of the answer it gives. */
  shape?: ApShape;
  /** `WHEN handed <contract>:` — the contract whose instance is the input of this trigger. */
  input?: ApRef;
  chars: number;
  body: ApNode[];
}

/** A flow STEP: a label grouping the lines whoever runs the flow carries out — DO, DELEGATE, FORK, WAIT. */
export interface ApStepNode {
  type: 'step';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  title: string;
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
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  chars: number;
  indent?: number;
  store: ApRef;
  body: ApNode[];
}

export interface ApEachNode {
  type: 'each';
  /** Where the node was written — provenance, never serialized. */
  pos?: ApPos;
  chars: number;
  indent?: number;
  /** `EACH <item> IN {{<list>}} MAX <n>`: its delegations run once per element of the list variable (D56). */
  each: ApEachHead;
  /** The delegations — DELEGATE and FORK lines — one run of each per element. */
  body: ApNode[];
}

export interface ApEachHead {
  /** The name `{{item}}` reads beneath: the run's element. */
  item: string;
  /** The variable holding the list. */
  list: ApRef;
  /** The most runs — a longer list is an error at run time. */
  max: number;
}


/**
 * A source position: the 1-based line, the column of its first character (the
 * primitive's keyword), and the column just past its last non-blank character.
 * Provenance, never serialized — a document revived from JSON has none.
 */
export interface ApPos {
  line: number;
  col: number;
  endCol: number;
}

/** Where a block was written: its file and the position of its header. Provenance, never serialized. */
export interface ApSource {
  file: string;
  line: number;
  col: number;
}

/**
 * One keyword line of the document — `DO <text>`, `IF <condition>`, `STEP
 * <title>`, … — with where it was written, the block it belongs to and the
 * nodes that contain it (outermost first). Position fields are null on a
 * document revived from JSON.
 */
export interface ApLine {
  primitive: string;
  /** A starred condition's own executor (`IF*` 1, `IF**` 2) — src/executor.ts. */
  executor?: number;
  force: number | null;
  text: string;
  file: string | null;
  line: number | null;
  col: number | null;
  endCol: number | null;
  block: ApBlock;
  containers: ApNode[];
}

export type ApNode =
  | ApInNode
  | ApDirectiveNode
  | ApRunNode
  | ApTextNode
  | ApIfNode
  | ApUntilNode
  | ApVarNode
  | ApWhenNode
  | ApStepNode
  | ApEachNode;

/** Machine-resolved slot type (mirror of shapeSchema's SlotTypeSpec, JSON-safe). */
export type ApSlotType =
  | { kind: 'text'; minWords?: number; maxWords?: number; regex?: string }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'enum'; values: string[] }
  | { kind: 'shape'; ref: ApRef }
  | { kind: 'list'; ref: ApRef; min?: number; max?: number }
  | { kind: 'any'; raw: string };

/** One template slot: resolved type + nested rules as plain directives. */
/**
 * One check a template states about the text filling a slot: a slot rule as a
 * neutral statement — `<template>.<slot>.<n>`, the rule text verbatim, and its
 * force (family keyword and level). What a judge is asked to verify.
 */
export interface ApCheck {
  id: string;
  statement: string;
  force: { keyword: string; level: number | null };
  /** What a judge's yes and no mean for this rule — its `YES` / `NO` lines. */
  criteria?: RuleCriteria;
}

export interface ApSlot {
  name: string;
  optional: boolean;
  type: ApSlotType;
  description?: string;
  rules: ApDirectiveNode[];
  /** Per rule, in order, its `YES` / `NO` criteria or null — present only when one rule has some. */
  criteria?: (RuleCriteria | null)[];
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
  /** The perimeter tokens of its APPLIES line — absent when it has none. */
  scopes?: string[];
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
  /** Leading blank lines of the agent body (metadata-strip artifact). */
  agentBodyLead: number;
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
 * `unknownDriver` is set instead when DRIVER names no installed driver;
 * `refused` when the driver cannot keep the store at all.
 */
export interface ApStoreProjection {
  driver: string;
  location: string;
  usage: string[];
  rejects: Record<string, string>;
  refused?: string;
  unknownDriver?: { available: string[] };
}

export interface ApDocumentMeta {
  /** Address of the root (agent) block in `blocks`. */
  root: string;
  /** Resolved force-level intros: family → level (as string) → phrase. */
  forceLevels: Record<string, Record<string, string>>;
  /** Resolved enum primitives (e.g. BUDGET tiers), neutral prose. */
  enums: Record<string, Record<string, string>>;
  /**
   * How the active adapter's harness runs a flow from its compiled script
   * (`renderings.FLOW.run`, `{script}` = the script's path, `{steps}` = how to
   * read the steps). Absent = the flow's steps are carried out as written.
   */
  flowRun?: string;
  /**
   * The active adapter's own words for the delegation lines (`renderings.DELEGATE`,
   * `.FORK`, `.WAIT`), over the formulas: how its harness starts work in the
   * background, forks, waits. Absent = the neutral words.
   */
  phrases?: Record<string, Record<string, string>>;
  /**
   * The environment variable the active adapter's harness puts its session id
   * in — where the apx finds the session its variables live in. Absent = no
   * adapter named one: session variables cannot be read or written.
   */
  sessionEnv?: string;
  /**
   * The checked conditions this agent's apx answers for (`apx check <cnd-id>`):
   * the judge's question and the variables it reads, by condition id. Kept
   * here, outside every block, so no view of a block shows a sealed one.
   */
  checks?: Record<string, ApCheckSpec>;
  /**
   * What a delegate or a program carries out for this agent, by id (`exe-…`):
   * its input and its output — src/executor.ts.
   */
  executors?: Record<string, ApExecutorSpec>;
  /**
   * What this agent's flows start in the background, by id (`dlg-…`): the flow,
   * the step, the task, its INTO and its BY — the apx's registry starts from here
   * (src/delegation.ts, src/apx/services/delegate.ts).
   */
  background?: Record<string, ApBackgroundWork>;
  /**
   * What this agent's flows MARK, by id (`mrk-…`): the flow, the step, the list
   * it fills, the spec of each zone, its limit (0: the project's `mark.max`) and
   * its domain — the contracts it binds start from here (src/delegation.ts).
   */
  marks?: Record<string, ApMark>;
  /**
   * The launch recipe of each other harness this agent's delegations go to, by
   * harness (`BY <harness>:<agent>`, D66) — what the apx fills when the piece
   * starts: the command, the rules to run it by, the files the copy is given.
   */
  harnesses?: Record<string, HarnessInvocation>;
  /** The plugins whose blocks this agent holds, by name — the apx serves them from here (src/plugins.ts). */
  plugins?: Record<string, PluginSpec>;
  /** The agent an ASK without BY is handed to — set when this agent has one (src/executor.ts). */
  delegate?: string;
  /** The model this agent runs on, from the `delegate.models` config key — absent: the harness decides. */
  model?: string;
  /** Md-projection metadata — present when the document renders prose. */
  md?: ApMdMeta;
}

