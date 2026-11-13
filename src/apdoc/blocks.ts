// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The concrete block kinds — one class per kind, all inheriting ApBlock —
 * and the kind-strategy registry that makes every per-kind decision.
 *
 * Rule of the module: NO `if (kind === …)` anywhere. Each class owns its
 * typed fields, its JSON shape (`argsJson`), its id prefix and its own
 * construction from a source (`fromDefinition`). Whatever must be decided
 * per kind WITHOUT an instance (building, indexing, ref ids) is answered by
 * the KIND_STRATEGIES registry, whose rows only point back at the classes —
 * consumers iterate or look up, they never branch on kind.
 */
import type { ApRef, ApShape, ApSlot, ApSlotType, ApNode, ApBlockData, ApStoreProjection, ApCheck } from './types.js';
import type { Definition } from '../definition.js';
import type { BundleContext } from '../dispatch/types.js';
import { ApBlock, type ApBlockInit } from './block.js';
import { addressName, stableId } from './ids.js';
import type { ApDocument } from './document.js';
import { buildNamespace } from '../namespace.js';
import { FORMULAS, fill } from '../formulas.js';
import { withScopeLine } from '../withUse.js';
import { executorKey, headerExecutorOf } from '../executor.js';
import { type MdEnv, slotTypePhrase, forceIntro, renderNodes, shapeLine, executorHow } from '../../adapters/md/toolkit.js';
import {
  templateScaffoldIntro, scalarTemplateLine, FIELDS_LABEL, OPTIONAL_MARK,
  EXAMPLE_OPEN, EXAMPLE_CLOSE, lensInLine, lensBridgeLine, refName,
  storeHomeLine, storeUsageLabel, storeRejectLine, storeUnknownDriverLine, varCommand,
} from '../../adapters/md/phrases.js';
import { storeDriverOf, storeDriverNames } from '../storeDrivers/registry.js';
import { DEFAULT_DRIVER, phraseOf, STORE_LIFETIMES, type StoreDecl, type StoreLifetime } from '../storeDrivers/types.js';
import { storeUsage } from '../storeDrivers/usage.js';
import { parseTemplate, templateLayout, composeExample, SLOT_NAME, type Slot } from '../shapeCompiler.js';
import type { VarScope } from '../vars.js';
import { extractPrimitive, stripPrimitives, unwrapExportFile } from '../services/text.js';
import { renderIdentityBlock, renderGlobs, } from '../primitives.js';
import { DirectiveNode, reviveNodes } from './nodes.js';
import { deslugifyRole } from '../services/role.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import type { Block } from '../parseBlocks.js';
import { isTeamFile, type TeamFile } from '../services/teamMetadata.js';
import { isMainFile } from '../services/mainMetadata.js';
import { unitNameFromPath } from '../ingest.js';
import { splitList } from '../lists.js';
import { domainLines, formulaFiles, DEFAULT_DOMAIN_THRESHOLDS, type DomainFormula, type DomainThresholds } from '../domains.js';
import type { DomainLine } from '../lexer.js';
import { serviceCommand } from '../apx/service.js';
import { pluginOf, recordOfLines, lineKeyOf, inputUsage, type PluginSpec } from '../plugins.js';

/**
 * The services a block needs from its builder to construct itself: the body
 * walk (events → nodes, block-level AS captured into `host.shape`), the slot
 * type resolver, and the Definition helpers (universal init, walkable body).
 * Implemented by the recorder.
 */
export interface BlockCx {
  /** Walk a body into `sink`. */
  walk(body: string, sink: ApNode[], host?: ApBlock): void;
  slotType(rawType: string): ApSlotType;
  /** Keyword (or alias) → family base + numeric force — the builder's lexicon. */
  parseForce(keyword: string): { base: string; force: number | null };
  defInit(def: Definition): ApBlockInit;
  walkableBody(def: Definition): string;
  /** A template by name; `report` false leaves an unknown one unresolved without an error. */
  templateRef(name: string, report?: boolean): ApRef;
  /** A store by name. */
  storeRef(name: string): ApRef;
  /** The SLOTS of a template the compilation holds — null when it holds none by that name. */
  templateSlots(name: string): Slot[] | null;
  agentRef(name: string): ApRef;
  refFromAddress(address: string, expectedKind?: string): ApRef;
  /** Namespace of a library file path, or null when outside every root. */
  namespaceOfPath(path: string): string | null;
}


/** The universal init of a revived block, straight from its serialized data. */
function initOf(data: ApBlockData): ApBlockInit {
  return {
    name: data.name, namespace: data.namespace, about: data.about,
    tags: data.tags, scopes: data.scopes, when: data.when,
  };
}

/** Restore the sealed/serialized fields onto a revived block — no resealing. */
function restore<T extends ApBlock>(block: T, data: ApBlockData): T {
  block.id = data.id;
  block.contentHash = data.contentHash;
  block.chars = data.chars;
  block.body = reviveNodes(data.body);
  return block;
}

/** policy | procedure | flow | skill — rule-bearing body, optional output shape. */
export class RuleBlock extends ApBlock {
  /** The id prefixes of the four kinds this class covers. */
  static readonly PREFIXES: Record<string, string> = {
    policy: 'pol', procedure: 'prc', flow: 'flw', skill: 'skl',
  };
  readonly kind: string;
  protected readonly idPrefix: string;

  constructor(kind: string, init: ApBlockInit) {
    super(init);
    this.kind = kind;
    this.idPrefix = RuleBlock.PREFIXES[kind] ?? kind.slice(0, 3);
  }

  /** A rule block from a raw body: construct, walk, capture the trailing AS. */
  static fromBody(kind: string, init: ApBlockInit, body: string, cx: BlockCx): RuleBlock {
    const block = new RuleBlock(kind, init);
    cx.walk(body, block.body, block);
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): RuleBlock {
    const block = new RuleBlock(def.kind, cx.defInit(def));
    // The head's mark — carried by the definition, or on the header line a legacy
    // module keeps in its body — is known before the walk: the conditions read it.
    const executor = def.executor ?? headerExecutorOf(def.body, def.name);
    if (executor) block.executor = executor;
    cx.walk(cx.walkableBody(def), block.body, block);
    return block;
  }

  static fromData(data: ApBlockData): RuleBlock {
    const block = restore(new RuleBlock(data.kind, initOf(data)), data);
    block.shape = (data.args.shape as ApShape | undefined) ?? null;
    block.lensIn = (data.args.lensIn as ApShape | undefined) ?? null;
    block.executor = (data.args.executor as number | undefined) ?? null;
    const exe = data.args.exe as string | undefined;
    if (exe) block.exe = exe;
    const sections = data.args as { require?: ApNode[]; ensure?: ApNode[] };
    if (sections.require) block.require = reviveNodes(sections.require);
    if (sections.ensure) block.ensure = reviveNodes(sections.ensure);
    return block;
  }

  /**
   * A COMPUTE block: its rules on top, when its program refuses (REQUIRE), what
   * it computes — its result's shape first (RETURN AS) — and what it guarantees
   * (ENSURE). RETURN starts at `shapePos`.
   */
  private computeMd(env: MdEnv): string {
    const computeFormulas = FORMULAS.keywords.COMPUTE;
    const at = this.shapePos ?? 0;
    // A section's rules are conditions on the input or the result, never orders: `MUST x be y` → `It requires that x be y`.
    const asConditions = (that: string): MdEnv => ({
      ...env,
      forceLevels: Object.fromEntries(Object.entries(env.forceLevels).map(([family, levels]) =>
        [family, Object.fromEntries(Object.keys(levels).map(level => [level, Number(level) < 0 ? computeFormulas.rule.never : that]))])),
    });
    const section = (head: string, nodes: ApNode[] | null, that: string) =>
      (nodes?.length ? [head, ...renderNodes(asConditions(that), nodes, false)] : []);
    return [
      ...renderNodes(env, this.body.slice(0, at)),
      ...section(computeFormulas.require, this.require, computeFormulas.rule.require),
      computeFormulas.return,
      ...(this.shape ? [shapeLine(env, this.shape)] : []),
      ...renderNodes(env, this.body.slice(at)),
      ...section(computeFormulas.ensure, this.ensure, computeFormulas.rule.ensure),
    ].join('\n');
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.lensIn ? { lensIn: this.lensIn } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      ...(this.executor ? { executor: this.executor } : {}),
      ...(this.exe ? { exe: this.exe } : {}),
      ...(this.require ? { require: this.require } : {}),
      ...(this.ensure ? { ensure: this.ensure } : {}),
    };
  }

  /**
   * Who carries a procedure out, then its input contract, open its body; the
   * rest is the shared rendering. A COMPUTE block says when its program refuses,
   * what it computes and what it guarantees.
   */
  override asMdBody(env: MdEnv): string {
    let body = this.require || this.ensure ? this.computeMd(env) : super.asMdBody(env);
    // A policy or a skill opens with the line that says where it applies (src/withUse.ts).
    body = withScopeLine(this.kind, this.scopes, body);
    if (this.lensIn) body = `${fill(FORMULAS.keywords['LENS-IN'].input, { name: refName(this.lensIn.ref), ref: env.refOf(this.lensIn.ref.target) })}\n${body}`;
    if (this.executor) body = `${fill(FORMULAS.keywords.EXECUTOR.procedure[executorKey(this.executor)], { how: executorHow(env, this.exe, this.executor) })}\n${body}`;
    return body;
  }
}

export class RoleBlock extends ApBlock {
  static readonly PREFIX = 'rol';
  readonly kind = 'role';
  protected readonly idPrefix = RoleBlock.PREFIX;
  expertise: string[] | null = null;

  static fromData(data: ApBlockData): RoleBlock {
    const block = restore(new RoleBlock(initOf(data)), data);
    block.expertise = (data.args.expertise as string[] | undefined) ?? null;
    block.shape = (data.args.shape as ApShape | undefined) ?? null;
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): RoleBlock {
    const block = new RoleBlock(cx.defInit(def));
    // EXPERTISE may already be lifted out of the body (Definition.expertise).
    const expertise = def.expertise ?? extractPrimitive(def.body, 'EXPERTISE');
    if (expertise) block.expertise = splitList(expertise);
    cx.walk(cx.walkableBody(def), block.body, block);
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.expertise ? { expertise: this.expertise } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
    };
  }
}

export class StoreBlock extends ApBlock {
  static readonly PREFIX = 'sto';
  readonly kind = 'store';
  protected readonly idPrefix = StoreBlock.PREFIX;
  /** The `DRIVER` value — resolved against the driver registry at render; `files` when the store names none. */
  storeDriver = DEFAULT_DRIVER;
  lasts: StoreLifetime = 'session';
  /** The `KEY` slot name, or null when the store declares none. */
  storeKey: string | null = null;
  /** The `LASTS` value as written — null when the store does not say (it then lasts a session). */
  declaredLasts: string | null = null;
  /** Its fields — from its SLOTS region, or from the template its `AS` names. */
  slots: ApSlot[] = [];
  /** Whether its body has a SLOTS region of its own — beside an `AS`, the compiler refuses one of them. */
  ownSlots = false;

  static fromData(data: ApBlockData): StoreBlock {
    const block = restore(new StoreBlock(initOf(data)), data);
    block.storeDriver = (data.args.driver as string | undefined) ?? DEFAULT_DRIVER;
    block.lasts = (data.args.lasts as StoreLifetime | undefined) ?? 'session';
    block.declaredLasts = (data.args.declaredLasts as string | undefined) ?? null;
    block.storeKey = (data.args.key as string | undefined) ?? null;
    block.slots = (data.args.slots as ApSlot[] | undefined) ?? [];
    block.shape = (data.args.shape as ApShape | undefined) ?? null;
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): StoreBlock {
    const block = new StoreBlock(cx.defInit(def));
    block.storeDriver = extractPrimitive(def.body, 'DRIVER') ?? DEFAULT_DRIVER;
    block.declaredLasts = extractPrimitive(def.body, 'LASTS');
    block.lasts = (STORE_LIFETIMES as readonly string[]).includes(block.declaredLasts ?? '') ? block.declaredLasts as StoreLifetime : 'session';
    block.storeKey = extractPrimitive(def.body, 'KEY');
    const own = parseTemplate(def.body)?.slots ?? [];
    block.ownSlots = own.length > 0;
    // `AS <template>`: the fields are the template's, read with the same grammar — never a second copy of them.
    const as = extractPrimitive(def.body, 'AS');
    if (as) block.shape = { force: 0, ref: cx.templateRef(as) };
    const raw: Slot[] = as && !block.ownSlots ? cx.templateSlots(as) ?? [] : own;
    block.slots = raw.map((slot): ApSlot => ({
      name: slot.name,
      optional: slot.optional,
      type: cx.slotType(slot.rawType),
      ...(slot.description ? { description: slot.description } : {}),
      rules: [],
      chars: slot.description?.length ?? 0,
    }));
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      driver: this.storeDriver,
      lasts: this.lasts,
      ...(this.declaredLasts ? { declaredLasts: this.declaredLasts } : {}),
      ...(this.storeKey ? { key: this.storeKey } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      slots: this.slots,
    };
  }

  /** The store as a driver is handed it, for the agent it belongs to. */
  decl(agent: string): StoreDecl {
    return {
      name: this.name,
      agent,
      about: this.about,
      key: this.storeKey,
      lasts: this.lasts,
      slots: this.slots,
    };
  }

  /**
   * What this store's driver makes of it — file, exact commands, what it
   * cannot keep — for the agent it belongs to and the command that serves it
   * (its apx). The driver is asked once, here; the md body renders this and
   * the document records it (meta.md.stores), so a reader never needs the driver.
   */
  projection(agent = '', command = ''): ApStoreProjection {
    const driver = storeDriverOf(this.storeDriver);
    if (!driver) {
      return { driver: this.storeDriver, location: '', usage: [], rejects: {}, unknownDriver: { available: storeDriverNames() } };
    }
    const decl = this.decl(agent);
    const rejects: Record<string, string> = {};
    for (const slot of this.slots) {
      const reason = driver.rejects?.(slot);
      if (reason) rejects[slot.name] = reason;
    }
    const refused = driver.rejectsStore?.(decl);
    return {
      driver: driver.name,
      location: driver.location(decl),
      usage: storeUsage(decl, driver, op => serviceCommand(command, 'store', op, this.id)),
      rejects,
      ...(refused ? { refused } : {}),
    };
  }

  override asMdBody(env: MdEnv): string {
    const projection = this.projection(env.agent, env.apxOf(null));
    if (projection.unknownDriver) {
      return storeUnknownDriverLine(this.name, this.storeDriver, projection.unknownDriver.available);
    }
    const out: string[] = [storeHomeLine(projection.location, this.lasts), '', FIELDS_LABEL];
    const storeFormulas = FORMULAS.blocks.store;
    for (const slot of this.slots) {
      out.push(fill(storeFormulas.field, {
        name: slot.name,
        // a store field sets the mark one space further out than a template field
        optional: slot.optional ? ` ${OPTIONAL_MARK}` : '',
        type: phraseOf(slot.type),
        description: slot.description ? fill(FORMULAS.blocks.template.description, { description: slot.description }) : '',
        key: this.storeKey === slot.name ? storeFormulas.key : '',
      }));
      if (projection.rejects[slot.name]) out.push(storeRejectLine(projection.driver, projection.rejects[slot.name]));
    }
    out.push('', storeUsageLabel(), '```', ...projection.usage, '```');
    const body = super.asMdBody(env);
    if (body.trim()) out.push('', body);
    return out.join('\n');
  }
}

/**
 * A dimension (D43): an answer implicit in a source file — its pseudocode, its
 * patterns — that an agent works out once and the apx keeps, so other agents
 * read it instead of reasoning again. ABOUT is the question, FOR the files it
 * covers, EACH what to translate inside one (verbatim, or a template it names),
 * AS the template its value is a list of (`shape`); its rules are the walked
 * body. When it is worth reading is the reader's to say: a dimension is read
 * where a WITH names it, like a policy or a skill with no perimeter
 * (src/withUse.ts). The apx never reasons: it hashes files and serves the cache.
 */
export class DimensionBlock extends ApBlock {
  static readonly PREFIX = 'dim';
  readonly kind = 'dimension';
  protected readonly idPrefix = DimensionBlock.PREFIX;
  /** The `FOR` globs — from the project root. */
  globs: string[] = [];
  /** The store its `STORE` line names: the fields of its records, and the driver that keeps them. */
  store: ApRef | null = null;
  /** The `EACH` text, verbatim — empty when it names a template (`eachRef`). */
  each = '';
  /** The template `EACH` names, when its text is exactly one template's name: the reference, never the name, is its content. */
  eachRef: ApRef | null = null;

  static fromData(data: ApBlockData): DimensionBlock {
    const block = restore(new DimensionBlock(initOf(data)), data);
    block.globs = (data.args.for as string[] | undefined) ?? [];
    block.store = (data.args.store as ApRef | undefined) ?? null;
    block.each = (data.args.each as string | undefined) ?? '';
    block.eachRef = (data.args.eachRef as ApRef | undefined) ?? null;
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): DimensionBlock {
    const block = new DimensionBlock(cx.defInit(def));
    block.globs = splitList(extractPrimitive(def.body, 'FOR') ?? '');
    const store = extractPrimitive(def.body, 'STORE')?.trim();
    if (store) block.store = cx.storeRef(store);
    block.each = (extractPrimitive(def.body, 'EACH') ?? '').trim();
    if (new RegExp(`^${SLOT_NAME}$`).test(block.each)) {
      const ref = cx.templateRef(block.each, false);
      if (ref.resolved !== false) { block.eachRef = ref; block.each = ''; }
    }
    cx.walk(stripPrimitives(cx.walkableBody(def), 'FOR', 'EACH', 'STORE'), block.body, block);
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      for: this.globs,
      ...(this.store ? { store: this.store } : {}),
      ...(this.eachRef ? { eachRef: this.eachRef } : { each: this.each }),
    };
  }

  /** Where it applies (src/withUse.ts), what it covers and its store, how to read, write and search it, then its rules. */
  override asMdBody(env: MdEnv): string {
    const dimensionFormulas = FORMULAS.blocks.dimension;
    // A dimension is reached by its id, like every block: `<apx> dimension <op> <dim-id>`.
    const command = (op: string) => serviceCommand(env.apxOf(null), 'dimension', op, this.id);
    const each = this.eachRef ? fill(dimensionFormulas.eachShape, { name: refName(this.eachRef), ref: env.refOf(this.eachRef.target) }) : this.each;
    return withScopeLine(this.kind, this.scopes, [
      fill(dimensionFormulas.covers, {
        globs: renderGlobs(this.globs),
        each,
        name: this.store ? refName(this.store) : '',
        ref: this.store ? env.refOf(this.store.target) : '',
      }),
      fill(dimensionFormulas.read, { read: command('read') }),
      fill(dimensionFormulas.write, { write: command('write') }),
      fill(dimensionFormulas.query, { q: command('q'), next: command('next') }),
      ...renderNodes(env, this.body),
    ].join('\n'));
  }
}

/** A region of the code (D44) — `@WITHIN <domain>` puts work within it, and a CONTRACT's DOMAIN line names one. */
export class DomainBlock extends ApBlock {
  static readonly PREFIX = 'dom';
  readonly kind = 'domain';
  protected readonly idPrefix = DomainBlock.PREFIX;
  /** The globs of its plain WRITES lines' IN — from the project root: what work within it may write. */
  writes: string[] = [];
  /** The globs of its plain READS lines' IN: what work within it may only read. */
  reads: string[] = [];
  /** Its formula lines — each with the probability of every file the judge was asked about, once judged. */
  formulas: DomainFormula[] = [];
  /** The thresholds the compilation judged its formulas with — absent while it has none. */
  thresholds: DomainThresholds | null = null;

  static fromData(data: ApBlockData): DomainBlock {
    const block = restore(new DomainBlock(initOf(data)), data);
    block.writes = (data.args.writes as string[] | undefined) ?? [];
    block.reads = (data.args.reads as string[] | undefined) ?? [];
    block.formulas = (data.args.formulas as DomainFormula[] | undefined) ?? [];
    block.thresholds = (data.args.thresholds as DomainThresholds | undefined) ?? null;
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): DomainBlock {
    const block = new DomainBlock(cx.defInit(def));
    const lines = domainLines(unwrapExportFile(def.body));
    block.writes = lines.writes;
    block.reads = lines.reads;
    block.formulas = lines.formulas;
    return block;
  }

  /**
   * The files of one side (WRITES or READS) as globs a path is matched with:
   * its plain globs, then each file a formula puts within — and, under `!`,
   * the uncertain ones the agent decides (`uncertain`: file → probability).
   */
  side(keyword: DomainLine): { globs: string[]; within: string[]; uncertain: Record<string, number> } {
    const within: string[] = [];
    const uncertain: Record<string, number> = {};
    for (const formula of this.formulas.filter(candidate => candidate.keyword === keyword)) {
      const files = formulaFiles(formula, this.thresholds ?? DEFAULT_DOMAIN_THRESHOLDS);
      within.push(...files.within);
      Object.assign(uncertain, files.uncertain);
    }
    return { globs: keyword === 'WRITES' ? this.writes : this.reads, within, uncertain };
  }

  /** Whether it says anything of a side — a plain glob or a formula. */
  declares(keyword: DomainLine): boolean {
    return (keyword === 'WRITES' ? this.writes : this.reads).length > 0 || this.formulas.some(formula => formula.keyword === keyword);
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.writes.length ? { writes: this.writes } : {}),
      ...(this.reads.length ? { reads: this.reads } : {}),
      ...(this.formulas.length ? { formulas: this.formulas } : {}),
      ...(this.thresholds ? { thresholds: this.thresholds } : {}),
    };
  }

  /** The files it covers — a domain holds no rule, it only says where. */
  override asMdBody(): string {
    const domainFormulas = FORMULAS.blocks.domain;
    const side = (keyword: DomainLine, line: string) => {
      const { globs } = this.side(keyword);
      const judged = this.formulas.filter(formula => formula.keyword === keyword).map(formula => fill(domainFormulas.formula, { formula: formula.formula, count: String(formulaFiles(formula, this.thresholds ?? DEFAULT_DOMAIN_THRESHOLDS).within.length) }));
      const what = [...(globs.length ? [renderGlobs(globs)] : []), ...judged].join(', ');
      return what ? [fill(line, { globs: what })] : [];
    };
    return [...side('WRITES', domainFormulas.writes), ...side('READS', domainFormulas.reads)].join('\n');
  }
}

/**
 * A block a plugin declares (src/plugins.ts) — `CHECKLIST before-release:`. Its
 * lines are a record of the plugin's template, kept as written; its chapter
 * shows them, then the commands the plugin serves it with.
 */
export class PluginBlock extends ApBlock {
  readonly kind: string;
  protected readonly idPrefix: string;
  /** Its lines, as a record of the plugin's template: `{ item: ['the tests pass', …] }`. */
  fields: Record<string, unknown> = {};

  constructor(spec: PluginSpec, init: ApBlockInit) {
    super(init);
    this.kind = spec.name;
    this.idPrefix = spec.prefix;
  }

  static fromData(spec: PluginSpec, data: ApBlockData): PluginBlock {
    const block = restore(new PluginBlock(spec, initOf(data)), data);
    block.fields = (data.args.fields as Record<string, unknown> | undefined) ?? {};
    return block;
  }

  static fromDefinition(spec: PluginSpec, def: Definition, cx: BlockCx): PluginBlock {
    const block = new PluginBlock(spec, cx.defInit(def));
    const lines = def.body.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*([A-Z][A-Z0-9-]*)\s+(.+)$/);
      return match ? [{ key: match[1], rest: match[2] }] : [];
    });
    block.fields = recordOfLines(spec, lines);
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return { fields: this.fields };
  }

  /** Its lines as written, then each command its plugin serves it with, on its id. */
  override asMdBody(env: MdEnv): string {
    const spec = pluginOf(this.kind);
    const pluginFormulas = FORMULAS.blocks.plugin;
    const lines = Object.entries(this.fields).flatMap(([slot, value]) =>
      (Array.isArray(value) ? value : [value]).map(item => fill(pluginFormulas.line, { key: lineKeyOf(slot), value: String(item) })));
    if (!spec || spec.operations.length === 0) return lines.join('\n');
    const commands = spec.operations.map(operation => fill(pluginFormulas.command, {
      command: `${serviceCommand(env.apxOf(null), spec.name, operation.op, this.id)} ${inputUsage(spec, operation.input)}`.trimEnd(),
      about: operation.about,
    }));
    return [...lines, '', pluginFormulas.commands, ...commands].join('\n');
  }
}

export class TemplateBlock extends ApBlock {
  static readonly PREFIX = 'tpl';
  readonly kind = 'template';
  protected readonly idPrefix = TemplateBlock.PREFIX;
  slots: ApSlot[] | null = null;
  layout: string | null = null;
  example: string | null = null;
  scalar: { typePhrase: string; description?: string } | null = null;

  static fromData(data: ApBlockData): TemplateBlock {
    const block = restore(new TemplateBlock(initOf(data)), data);
    const slots = (data.args.slots as ApSlot[] | undefined) ?? null;
    block.slots = slots ? slots.map(slot => ({ ...slot, rules: reviveNodes(slot.rules) })) : null;
    block.layout = (data.args.layout as string | undefined) ?? null;
    block.example = (data.args.example as string | undefined) ?? null;
    block.scalar = (data.args.scalar as { typePhrase: string; description?: string } | undefined) ?? null;
    block.shape = (data.args.shape as ApShape | undefined) ?? null;
    return block;
  }

  static fromBody(init: ApBlockInit, body: string, cx: BlockCx): TemplateBlock {
    const block = new TemplateBlock(init);
    block.fill(body, cx);
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): TemplateBlock {
    return TemplateBlock.fromBody(cx.defInit(def), def.body, cx);
  }

  /**
   * Project a template body: SLOTS/BODY/EXAMPLE into the typed fields
   * (via the core's parseTemplate), scalar shorthand into `scalar`, prose
   * fallback into a walked body.
   */
  fill(body: string, cx: BlockCx): void {
    const parsed = parseTemplate(body);
    if (parsed && parsed.slots.length > 0) {
      this.slots = parsed.slots.map((slot): ApSlot => {
        const criteria = (slot.rawRules ?? []).map(rawRule => rawRule.criteria ?? null);
        return {
          name: slot.name,
          optional: slot.optional,
          type: cx.slotType(slot.rawType),
          ...(slot.description ? { description: slot.description } : {}),
          rules: (slot.rawRules ?? []).map(rawRule => {
            const { base, force } = cx.parseForce(rawRule.keyword);
            const rule = new DirectiveNode(base, force, rawRule.text);
            rule.chars = rawRule.text.length;
            return rule;
          }),
          ...(criteria.some(Boolean) ? { criteria } : {}),
          chars: (slot.description?.length ?? 0) + (slot.rawRules ?? []).reduce((total, rawRule) => total + rawRule.text.length, 0),
        };
      });
      this.layout = parsed.bodyLayout;
      this.example = parsed.example;
    } else if (parsed?.scalar) {
      this.scalar = {
        typePhrase: parsed.scalar.typePhrase,
        ...(parsed.scalar.description ? { description: parsed.scalar.description } : {}),
      };
    } else {
      cx.walk(body, this.body, this);
    }
  }

  protected override argsJson(): Record<string, unknown> {
    if (this.slots) {
      return {
        slots: this.slots,
        ...(this.layout ? { layout: this.layout } : {}),
        ...(this.example ? { example: this.example } : {}),
      };
    }
    if (this.scalar) return { scalar: this.scalar };
    return this.shape ? { shape: this.shape } : {};
  }

  /** The slot rules as neutral checks, in order — id `<template>.<slot>.<n>`, the rule text verbatim. */
  asChecks(): ApCheck[] {
    return (this.slots ?? []).flatMap(slot => slot.rules.map((rule, index) => ({
      id: `${this.name}.${slot.name}.${index + 1}`,
      statement: rule.text,
      force: { keyword: rule.keyword, level: rule.force },
      ...(slot.criteria?.[index] ? { criteria: slot.criteria[index]! } : {}),
    })));
  }

  /** Its BODY layout — or, without one, every slot in order. */
  layoutText(): string {
    return templateLayout(this.layout, this.slots ?? []);
  }

  /** One instance of it, as text: its layout with every `{slot}` replaced by the instance's value — a text as is, any other value as JSON. */
  instanceText(instance: Record<string, unknown>): string {
    const slots = new Set((this.slots ?? []).map(slot => slot.name));
    return this.layoutText().replace(new RegExp(`\\{(${SLOT_NAME})\\}`, 'g'), (placeholder, name: string) => {
      if (!slots.has(name)) return placeholder;
      const value = instance[name];
      return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  /** Mirror of the legacy renderTemplate — sourced from the typed fields. */
  override asMdBody(env: MdEnv): string {
    const out: string[] = [];
    if (this.scalar) {
      out.push(scalarTemplateLine(this.name, this.scalar.typePhrase, this.scalar.description));
    } else if (this.slots) {
      const templateFormulas = FORMULAS.blocks.template;
      out.push(templateScaffoldIntro(this.name));
      out.push('', this.layoutText(), '');
      out.push(FIELDS_LABEL);
      for (const slot of this.slots) {
        out.push(fill(templateFormulas.field, {
          name: slot.name,
          optional: slot.optional ? OPTIONAL_MARK : '',
          type: slotTypePhrase(env, slot.type),
          description: slot.description ? fill(templateFormulas.description, { description: slot.description }) : '',
        }));
        for (const rule of slot.rules) {
          out.push(fill(templateFormulas.rule, { intro: forceIntro(env, rule.keyword, rule.force) ?? rule.keyword, text: rule.text }));
        }
      }
    } else {
      return super.asMdBody(env);
    }
    if (this.example) {
      const example = env.exampleOf ? composeExample(this.example, this.name, env.exampleOf) : this.example;
      out.push('', EXAMPLE_OPEN, example, EXAMPLE_CLOSE);
    }
    return out.join('\n');
  }
}

/**
 * A variable (I7): a name the agent's work fills while it runs, kept by the apx
 * for the session — private to the agent, or shared by the session's agents
 * (`SESSION`) — with a type when a template shapes it. Imported from a module or
 * a body; one variable namespace, so the id depends on the name alone.
 */
export class VarBlock extends ApBlock {
  static readonly PREFIX = 'var';
  static readonly NAMESPACE = '@main.vars';
  readonly kind = 'var';
  protected readonly idPrefix = VarBlock.PREFIX;
  /** Who sees it: the declaring agent alone, or every agent of the session. */
  scope: VarScope = 'private';
  /** The template that types it, or null. */
  type: ApRef | null = null;
  /** Where it is declared: `` `@main.vars` ``, `procedure verify`, … */
  declared = '';

  /** The reference to a variable by name — derivable without the block. */
  static ref(name: string): ApRef {
    return { id: refId('var', VarBlock.NAMESPACE, name), target: `${VarBlock.NAMESPACE}/${name}`, kind: 'var' };
  }

  static fromDeclaration(name: string, scope: VarScope, type: ApRef | null, declared: string): VarBlock {
    const varFormulas = FORMULAS.keywords.VAR;
    const block = new VarBlock({
      name, namespace: VarBlock.NAMESPACE,
      about: fill(varFormulas.about, { scope: varFormulas.scopes[scope], type: type ? fill(varFormulas.typed, { name: refName(type) }) : '', where: declared }),
    });
    block.scope = scope;
    block.type = type;
    block.declared = declared;
    return block;
  }

  static fromData(data: ApBlockData): VarBlock {
    const block = restore(new VarBlock(initOf(data)), data);
    block.scope = (data.args.scope as VarScope | undefined) ?? 'private';
    block.type = (data.args.type as ApRef | undefined) ?? null;
    block.declared = (data.args.declared as string | undefined) ?? '';
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return { scope: this.scope, ...(this.type ? { type: this.type } : {}), declared: this.declared };
  }

  /** How to read and store it, through the apx. */
  override asMdBody(env: MdEnv): string {
    const apx = env.apxOf(null);
    return fill(FORMULAS.keywords.VAR.entry, { read: varCommand(apx, 'get', this.name), write: varCommand(apx, 'set', this.name) });
  }
}

/** A team's scanned context: read once by the recorder, consumed here and by the index. */
/** A unit's file as its scan reads it: the team's, or the main's. */
type UnitFile = Pick<TeamFile, 'path' | 'source' | 'block' | 'childIndent' | 'about' | 'name'>;

/** A unit read for its document — a team, or the main. */
export interface TeamScan {
  kind: 'team' | 'main';
  root: string;
  name: string;
  /** The unit's file, read once (services/teamMetadata.ts, services/mainMetadata.ts). */
  file: UnitFile;
  /** The agents it holds, by name: a team's MEMBER roster, the main's MEMBER lines. */
  members: string[];
  /** The main's TEAMS lines — none in a team. */
  teams: string[];
  /** The files of the agents it holds — where each one's own decorators are written. */
  memberFiles: string[];
  /** The blocks of the TEAM or MAIN block — its routing WHENs and its FLOWs. */
  blocks: Block[];
  /** Its routing as its body: every WHEN of the block, de-indented as an agent's body is written. */
  routing: string;
  /** The FLOW blocks sliced back to raw text, de-indented as a flow file writes them. */
  flows: { name: string; body: string; block: Block | null }[];
}

export class TeamBlock extends ApBlock {
  static readonly PREFIX = 'tea';
  static readonly NAMESPACE = '@main.teams';
  readonly kind = 'team';
  protected readonly idPrefix = TeamBlock.PREFIX;
  members: ApRef[] = [];
  shared: string | null = null;

  /** The namespace a team's own flows live under. */
  static flowsNamespace(teamName: string): string {
    return `@main.flows.${teamName}`;
  }

  static fromData(data: ApBlockData): TeamBlock {
    const block = restore(new TeamBlock(initOf(data)), data);
    block.members = (data.args.members as ApRef[] | undefined) ?? [];
    block.shared = (data.args.shared as string | undefined) ?? null;
    return block;
  }

  /** Build the team block from its scanned directory: its members, its routing as its body — walked as an agent's is — and its shared text. */
  static fromScan(scan: TeamScan, cx: BlockCx): TeamBlock {
    const block = new TeamBlock({
      name: scan.name,
      namespace: TeamBlock.NAMESPACE,
      about: scan.file.about || null,
    });
    block.members = scan.members.map(name => cx.agentRef(name));
    cx.walk(scan.routing, block.body, block);

    const teamAp = resolve(scan.root, 'team.ap');
    if (existsSync(teamAp)) {
      const shared = readFileSync(teamAp, 'utf-8').replace(/^RAW:\s*$/m, '').replace(/^:RAW\s*$/m, '').trim();
      if (shared) block.shared = shared;
    }
    return block;
  }

  /** The team's identity — who it is and its members, each with the command that reaches it: what an agent's role is to the agent. */
  override asMdIdentity(env: MdEnv, doc: ApDocument): string {
    const words = FORMULAS.blocks.team.unit;
    return unitIdentity(env, doc, this, { lead: words.lead, groups: [{ title: words.members, refs: this.members }] });
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      members: this.members,
      ...(this.shared ? { shared: this.shared } : {}),
    };
  }
}

/**
 * A unit's identity: the line that says who it is, then each group of what it
 * holds — its members, the main's teams — one row per block, with its ABOUT
 * (read by id wherever the block is held) and the command that starts it.
 */
function unitIdentity(env: MdEnv, doc: ApDocument, unit: ApBlock, { lead, groups }: { lead: string; groups: { title: string; refs: readonly ApRef[] }[] }): string {
  const lines = [FORMULAS.blocks.agent.identity, '', fill(lead, { name: unit.name, about: unit.about ?? '' })];
  for (const { title, refs } of groups.filter(group => group.refs.length > 0)) {
    lines.push('', title);
    for (const ref of refs) {
      const name = addressName(ref.target);
      lines.push(fill(FORMULAS.blocks.team.unit.row, { name, about: doc.reach(ref)?.about ?? FORMULAS.blocks.team.undescribed, command: env.apxOf(name) }));
    }
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * The project's main — the root of its document: what it is, the standalone
 * agents and the teams it holds, and its routing. Its flows are blocks of the
 * same document, as a team's are of the team's.
 */
export class MainBlock extends ApBlock {
  static readonly PREFIX = 'mai';
  static readonly NAMESPACE = '@main.main';
  readonly kind = 'main';
  protected readonly idPrefix = MainBlock.PREFIX;
  members: ApRef[] = [];
  teams: ApRef[] = [];

  static fromData(data: ApBlockData): MainBlock {
    const block = restore(new MainBlock(initOf(data)), data);
    block.members = (data.args.members as ApRef[] | undefined) ?? [];
    block.teams = (data.args.teams as ApRef[] | undefined) ?? [];
    return block;
  }

  /** Build the main's block from its scan: its agents, its teams, its routing. */
  static fromScan(scan: TeamScan, cx: BlockCx): MainBlock {
    const block = new MainBlock({ name: scan.name, namespace: MainBlock.NAMESPACE, about: scan.file.about || null });
    block.members = scan.members.map(name => cx.agentRef(name));
    block.teams = scan.teams.map(name => cx.refFromAddress(`${TeamBlock.NAMESPACE}/${name}`, 'team'));
    cx.walk(scan.routing, block.body, block);
    return block;
  }

  /** The main's identity — who it is, its teams, its agents, each with the command that reaches it. */
  override asMdIdentity(env: MdEnv, doc: ApDocument): string {
    const words = FORMULAS.blocks.main.unit;
    return unitIdentity(env, doc, this, { lead: words.lead, groups: [{ title: words.teams, refs: this.teams }, { title: words.members, refs: this.members }] });
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      members: this.members,
      teams: this.teams,
    };
  }
}

/** What the agent factory needs from the pipeline's collected state. */
export interface AgentSource {
  agentName: string;
  metadata: Map<string, string[]>;
  /** The roles the agent binds with `AS <role>, …`, in order — empty when none. */
  boundRoles: Definition[];
  agentBody: string;
}

/**
 * The behaviours of the bound roles, in the order bound: a rule a later role
 * repeats is kept once — the first role keeps all of its own, so one role
 * renders exactly as it always did.
 */
function mergedBehaviours(roleBlocks: readonly ApBlock[]): ApNode[] {
  const seen = new Set<string>();
  const key = (node: ApNode) => JSON.stringify(node, (field, fieldValue) => (field === 'line' || field === 'col' || field === 'chars' ? undefined : fieldValue));
  return roleBlocks.flatMap((role, index) => {
    const kept = index === 0 ? role.body : role.body.filter(node => !seen.has(key(node)));
    kept.forEach(node => seen.add(key(node)));
    return kept;
  });
}

export class AgentBlock extends ApBlock {
  static readonly PREFIX = 'agt';
  static readonly NAMESPACE = '@main.agents';
  readonly kind = 'agent';
  protected readonly idPrefix = AgentBlock.PREFIX;
  /** The roles it binds, in the order of its `AS` list — one role is a list of one. */
  roles: ApRef[] = [];
  mandate: string | null = null;
  /** `BUDGET <tier>`: the cost tier the adapter maps to a model. */
  budget: string | null = null;
  lensOut: ApShape | null = null;
  /** The team it is a member of — a reference: the team's block is the team's own document's. */
  team: ApRef | null = null;

  static fromData(data: ApBlockData): AgentBlock {
    const block = restore(new AgentBlock(initOf(data)), data);
    block.roles = (data.args.roles as ApRef[] | undefined) ?? [];
    block.mandate = (data.args.mandate as string | undefined) ?? null;
    block.budget = (data.args.budget as string | undefined) ?? null;
    block.lensIn = (data.args.lensIn as ApShape | undefined) ?? null;
    block.lensOut = (data.args.lensOut as ApShape | undefined) ?? null;
    block.shape = (data.args.shape as ApShape | undefined) ?? null;
    block.team = (data.args.team as ApRef | undefined) ?? null;
    return block;
  }

  /**
   * The agent's md preamble — Identity (via the ONE legacy composer) and the
   * lens binding lines. The block owns its own md; the backend composes.
   */
  override asMdIdentity(env: MdEnv, doc: ApDocument): string {
    const roleBlocks = this.roles.map(ref => doc.resolve(ref)).filter((block): block is ApBlock => block !== null);
    // One identity line per role, in the order bound; ROLE, ROLE-ABOUT and EXPERTISE align by position.
    const identityMeta = new Map<string, string[]>();
    if (roleBlocks.length) {
      identityMeta.set('ROLE', roleBlocks.map(role => deslugifyRole(role.name)));
      identityMeta.set('ROLE-ABOUT', roleBlocks.map(role => role.about ?? ''));
      identityMeta.set('EXPERTISE', roleBlocks.map(role => ((role as { expertise?: string[] | null }).expertise ?? []).join(', ')));
    }
    if (this.mandate) identityMeta.set('MANDATE', [this.mandate]);
    const behaviours = renderNodes(env, mergedBehaviours(roleBlocks)).join('\n');
    // Legacy composition: `${identityBlock}\n${lens}${body}` — keep the extra newline.
    let out = `${renderIdentityBlock(identityMeta, behaviours)}\n`;

    if (this.lensIn) {
      out += `${lensInLine(refName(this.lensIn.ref), env.refOf(this.lensIn.ref.target))}\n\n`;
    }
    if (this.lensIn && this.lensOut) {
      out += `${lensBridgeLine(refName(this.lensOut.ref), env.refOf(this.lensOut.ref.target))}\n\n`;
    }
    if (this.lensOut) out += `${shapeLine(env, this.lensOut)}\n\n`;
    return out;
  }

  /** The root block: identity from the already-extracted metadata Map. */
  static fromContext(src: AgentSource, cx: BlockCx): AgentBlock {
    const md = (key: string): string | null => src.metadata.get(key)?.[0]?.trim() ?? null;
    const block = new AgentBlock({ name: src.agentName, namespace: AgentBlock.NAMESPACE, about: md('ABOUT') });

    block.roles = src.boundRoles.map(role => {
      const ns = cx.defInit(role).namespace;
      return { id: refId('role', ns, role.name), target: `${ns}/${role.name}`, kind: 'role' };
    });
    block.mandate = md('MANDATE');
    block.budget = md('BUDGET');
    const lensIn = md('LENS-IN');
    if (lensIn) block.lensIn = { force: 0, ref: cx.templateRef(lensIn) };
    const lensOut = md('LENS-OUT');
    if (lensOut) block.lensOut = { force: 1, ref: cx.templateRef(lensOut) };

    cx.walk(src.agentBody, block.body, block);
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.roles.length ? { roles: this.roles } : {}),
      ...(this.mandate ? { mandate: this.mandate } : {}),
      ...(this.budget ? { budget: this.budget } : {}),
      ...(this.lensIn ? { lensIn: this.lensIn } : {}),
      ...(this.lensOut ? { lensOut: this.lensOut } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      ...(this.team ? { team: this.team } : {}),
    };
  }

  /** The reference to a team by its name — its one block's id, wherever that block is. */
  static teamRef(name: string): ApRef {
    return { id: refId('team', TeamBlock.NAMESPACE, name), target: `${TeamBlock.NAMESPACE}/${name}`, kind: 'team' };
  }
}

// ---------------------------------------------------------------------------
// Kind strategies — every per-kind decision, answered by iteration or lookup,
// never by branching on kind. Rows only point back at the classes.
// ---------------------------------------------------------------------------

/** Which reference index a kind participates in (for Ref resolution by name). */
export type RefClass = 'runnables' | 'templates' | 'goals' | 'stores';

export interface KindStrategy {
  kind: string;
  /** Id prefix — declared by the class, referenced here. */
  prefix: string;
  /** Library folder / namespace segment of this kind ('procedures', …). */
  folder: string;
  /** Reference index this kind is looked up in, when a name points at it. */
  ref: RefClass | null;
  /** The Definitions of this kind collected by the bundle pipeline, if any. */
  entries?: (ctx: BundleContext, opts: { boundRoles: Definition[] }) => Definition[];
  /** Build the block from one of those Definitions — delegates to the class. */
  from?: (def: Definition, cx: BlockCx) => ApBlock;
  /** Revive the block from its serialized data — delegates to the class. */
  revive: (data: ApBlockData) => ApBlock;
  /** Md chapter title (chapter kinds only). */
  chapterTitle?: string;
}

export const KIND_STRATEGIES: KindStrategy[] = [
  // Chapter kinds, in the md chapter order (mirror of definition.ts STRATEGIES:
  // policy → role → template → procedure → flow → goal) — the layout pass
  // iterates this list to number chapters.
  { kind: 'policy', revive: RuleBlock.fromData, folder: 'policies', chapterTitle: FORMULAS.blocks.policy.chapter, prefix: RuleBlock.PREFIXES.policy,    ref: null,
    entries: ctx => ctx.policies,   from: RuleBlock.fromDefinition },
  { kind: 'role', revive: RoleBlock.fromData, folder: 'roles', chapterTitle: FORMULAS.blocks.role.chapter, prefix: RoleBlock.PREFIX,                ref: null,
    entries: (ctx, opts) => [...opts.boundRoles, ...ctx.roles],
    from: RoleBlock.fromDefinition },
  { kind: 'template', revive: TemplateBlock.fromData, folder: 'templates', chapterTitle: FORMULAS.blocks.template.chapter, prefix: TemplateBlock.PREFIX,            ref: 'templates',
    entries: ctx => ctx.templates,  from: TemplateBlock.fromDefinition },
  { kind: 'procedure', revive: RuleBlock.fromData, folder: 'procedures', chapterTitle: FORMULAS.blocks.procedure.chapter, prefix: RuleBlock.PREFIXES.procedure, ref: 'runnables',
    entries: ctx => ctx.procedures, from: RuleBlock.fromDefinition },
  { kind: 'flow', revive: RuleBlock.fromData, folder: 'flows', chapterTitle: FORMULAS.blocks.flow.chapter, prefix: RuleBlock.PREFIXES.flow,      ref: 'runnables',
    entries: ctx => ctx.flows,      from: RuleBlock.fromDefinition },
  { kind: 'skill', revive: RuleBlock.fromData, folder: 'skills', chapterTitle: FORMULAS.blocks.skill.chapter, prefix: RuleBlock.PREFIXES.skill, ref: null,
    entries: ctx => ctx.skills,     from: RuleBlock.fromDefinition },
  { kind: 'store', revive: StoreBlock.fromData, folder: 'stores', chapterTitle: FORMULAS.blocks.store.chapter, prefix: StoreBlock.PREFIX,               ref: 'stores',
    entries: ctx => ctx.stores,     from: StoreBlock.fromDefinition },
  // Reached by its name through the apx, and named by a WITH like a policy: no reference index.
  { kind: 'dimension', revive: DimensionBlock.fromData, folder: 'dimensions', chapterTitle: FORMULAS.blocks.dimension.chapter, prefix: DimensionBlock.PREFIX, ref: null,
    entries: ctx => ctx.dimensions, from: DimensionBlock.fromDefinition },
  // Named by `@WITHIN`: the perimeter reads its WRITES and READS globs.
  { kind: 'domain', revive: DomainBlock.fromData, folder: 'domains', chapterTitle: FORMULAS.blocks.domain.chapter, prefix: DomainBlock.PREFIX, ref: null,
    entries: ctx => ctx.domains, from: DomainBlock.fromDefinition },
  // Non-chapter kinds — referenceable identities only.
  { kind: 'team', revive: TeamBlock.fromData, folder: 'teams',      prefix: TeamBlock.PREFIX,                ref: null },
  { kind: 'main', revive: MainBlock.fromData, folder: 'main',       prefix: MainBlock.PREFIX,                ref: null },
  { kind: 'agent', revive: AgentBlock.fromData, folder: 'agents',     prefix: AgentBlock.PREFIX,               ref: null },
  { kind: 'var', revive: VarBlock.fromData, folder: 'vars',         prefix: VarBlock.PREFIX,                 ref: null },
];

export function strategyOf(kind: string): KindStrategy | null {
  return KIND_STRATEGIES.find(strategy => strategy.kind === kind) ?? null;
}

/**
 * Make a plugin's block a kind of the document — the one row every reader
 * finds it by (revive, folder, chapter). Once per plugin; the compiler and the
 * apx both call it.
 */
export function installPluginKind(spec: PluginSpec): void {
  if (KIND_STRATEGIES.some(strategy => strategy.kind === spec.name)) return;
  KIND_STRATEGIES.push({
    kind: spec.name, prefix: spec.prefix, folder: spec.folder, ref: null,
    chapterTitle: spec.folder.charAt(0).toUpperCase() + spec.folder.slice(1),
    revive: data => PluginBlock.fromData(spec, data),
    entries: ctx => (ctx as unknown as Record<string, Definition[]>)[spec.folder] ?? [],
    from: (def, cx) => PluginBlock.fromDefinition(spec, def, cx),
  });
}

/** The kind living in a library folder / namespace segment, or null. */
export function kindOfFolder(folder: string): string | null {
  return KIND_STRATEGIES.find(strategy => strategy.folder === folder)?.kind ?? null;
}

/** The folder / namespace segment of a kind (fallback: kind + 's'). */
export function folderOfKind(kind: string): string {
  return strategyOf(kind)?.folder ?? `${kind}s`;
}

/**
 * The stable id a Ref points at, computed WITHOUT a block instance — a
 * pointer must be derivable from (kind, namespace, name) alone. Same hash,
 * same prefixes as the classes' own sealing.
 */
export function refId(kind: string, namespace: string, name: string): string {
  return stableId(strategyOf(kind)?.prefix ?? kind.slice(0, 3), kind, namespace, name);
}

/** The namespace of a collected definition: its library, else `@main.<folder>`. */
export function namespaceOf(def: Definition, libraryRoots: string[], libraries?: Record<string, string>): string {
  if (def.namespace) return def.namespace;
  const viaLibrary = buildNamespace(def.path, libraryRoots, libraries);
  if (viaLibrary) return viaLibrary.startsWith('@') ? viaLibrary : `@${viaLibrary}`.replace(/^@library/, 'library');
  // A unit's flows live in its block: one namespace per team — and the main — whoever builds them.
  if (def.kind === 'flow' && isTeamFile(def.path)) return TeamBlock.flowsNamespace(basename(dirname(def.path)));
  if (def.kind === 'flow' && isMainFile(def.path)) return TeamBlock.flowsNamespace(unitNameFromPath(def.path));
  return `@main.${folderOfKind(def.kind)}`;
}

/** The block id of a collected definition — the one reference every projection prints. */
export function definitionId(def: Definition, ctx: Pick<BundleContext, 'libraryRoots' | 'libraries'>): string {
  return refId(def.kind, namespaceOf(def, ctx.libraryRoots, ctx.libraries), def.name);
}
