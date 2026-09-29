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
import type { ApRef, ApShape, ApSlot, ApSlotType, ApNode, ApBlockData, ApStoreProjection } from './types.js';
import type { Definition } from '../definition.js';
import type { BundleContext } from '../dispatch/types.js';
import { ApBlock, ApBlockInit } from './block.js';
import { stableId } from './ids.js';
import { buildNamespace } from '../namespace.js';
import { FORMULAS, fill } from '../formulas.js';
import { MdEnv, slotTypePhrase, forceIntro, renderNodes, shapeLine } from '../../adapters/md/toolkit.js';
import {
  templateScaffoldIntro, scalarTemplateLine, FIELDS_LABEL, OPTIONAL_MARK,
  EXAMPLE_OPEN, EXAMPLE_CLOSE, lensInLine, lensBridgeLine, refName,
  storeHomeLine, storeUsageLabel, storeRejectLine, storeUnknownTypeLine,
} from '../../adapters/md/phrases.js';
import { storeTypeOf, storeTypeNames } from '../storeTypes/registry.js';
import { phraseOf, STORE_LIFETIMES, type StoreDecl, type StoreLifetime } from '../storeTypes/types.js';
import { parseTemplate } from '../shapeCompiler.js';
import { extractPrimitive, extractPrimitives } from '../services/text.js';
import { renderIdentityBlock } from '../primitives.js';
import { DirectiveNode, reviveNodes } from './nodes.js';
import { deslugifyRole } from '../services/role.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import type { Block } from '../parseBlocks.js';
import { readTeamMembers, readTeamPurpose, TEAM_FLOWS_FILE } from '../services/teamMetadata.js';

/**
 * The services a block needs from its builder to construct itself: the body
 * walk (events → nodes, block-level AS captured into `host.shape`), the slot
 * type resolver, and the Definition helpers (universal init, walkable body).
 * Implemented by the recorder.
 */
export interface BlockCx {
  walk(body: string, sink: ApNode[], host?: ApBlock): void;
  slotType(rawType: string): ApSlotType;
  /** Keyword (or alias) → family base + numeric force — the builder's lexicon. */
  parseForce(keyword: string): { base: string; force: number | null };
  defInit(def: Definition): ApBlockInit;
  walkableBody(def: Definition): string;
  templateRef(name: string): ApRef;
  agentRef(name: string): ApRef;
  runnableRef(name: string): ApRef;
  refFromAddress(address: string, expectedKind?: string): ApRef;
  /** Namespace of a library file path, or null when outside every root. */
  namespaceOfPath(path: string): string | null;
}


/** The universal init of a revived block, straight from its serialized data. */
function initOf(data: ApBlockData): ApBlockInit {
  return {
    name: data.name, namespace: data.namespace, about: data.about,
    tags: data.tags, applies: data.applies, when: data.when,
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

/** policy | procedure | flow | playbook — rule-bearing body, optional output shape. */
export class RuleBlock extends ApBlock {
  /** The id prefixes of the four kinds this class covers. */
  static readonly PREFIXES: Record<string, string> = {
    policy: 'pol', procedure: 'prc', flow: 'flw', playbook: 'pbk',
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
    return RuleBlock.fromBody(def.kind, cx.defInit(def), cx.walkableBody(def), cx);
  }

  static fromData(data: ApBlockData): RuleBlock {
    const block = restore(new RuleBlock(data.kind, initOf(data)), data);
    block.shape = (data.args['shape'] as ApShape | undefined) ?? null;
    block.lensIn = (data.args['lensIn'] as ApShape | undefined) ?? null;
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.lensIn ? { lensIn: this.lensIn } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
    };
  }

  /** A procedure's input contract opens its body; the rest is the shared rendering. */
  override asMdBody(env: MdEnv): string {
    const body = super.asMdBody(env);
    if (!this.lensIn) return body;
    return `${fill(FORMULAS.keywords['LENS-IN'].input, { name: refName(this.lensIn.ref), ref: env.refOf(this.lensIn.ref.target) })}\n${body}`;
  }
}

export class RoleBlock extends ApBlock {
  static readonly PREFIX = 'rol';
  readonly kind = 'role';
  protected readonly idPrefix = RoleBlock.PREFIX;
  expertise: string[] | null = null;

  static fromData(data: ApBlockData): RoleBlock {
    const block = restore(new RoleBlock(initOf(data)), data);
    block.expertise = (data.args['expertise'] as string[] | undefined) ?? null;
    block.shape = (data.args['shape'] as ApShape | undefined) ?? null;
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): RoleBlock {
    const block = new RoleBlock(cx.defInit(def));
    // EXPERTISE may already be lifted out of the body (Definition.expertise).
    const expertise = def.expertise ?? extractPrimitive(def.body, 'EXPERTISE');
    if (expertise) block.expertise = expertise.trim().split(/\s+/);
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
  /** The `TYPE` value — resolved against the store-type registry at render. */
  storeType = '';
  lasts: StoreLifetime = 'session';
  /** The `KEY` slot name, or null when the store declares none. */
  storeKey: string | null = null;
  slots: ApSlot[] = [];

  static fromData(data: ApBlockData): StoreBlock {
    const block = restore(new StoreBlock(initOf(data)), data);
    block.storeType = (data.args['storeType'] as string | undefined) ?? '';
    block.lasts = (data.args['lasts'] as StoreLifetime | undefined) ?? 'session';
    block.storeKey = (data.args['key'] as string | undefined) ?? null;
    block.slots = (data.args['slots'] as ApSlot[] | undefined) ?? [];
    return block;
  }

  static fromDefinition(def: Definition, cx: BlockCx): StoreBlock {
    const block = new StoreBlock(cx.defInit(def));
    block.storeType = extractPrimitive(def.body, 'TYPE') ?? '';
    const lasts = extractPrimitive(def.body, 'LASTS');
    block.lasts = (STORE_LIFETIMES as readonly string[]).includes(lasts ?? '') ? lasts as StoreLifetime : 'session';
    block.storeKey = extractPrimitive(def.body, 'KEY');
    block.slots = (parseTemplate(def.body)?.slots ?? []).map((s): ApSlot => ({
      name: s.name,
      optional: s.optional,
      type: cx.slotType(s.rawType),
      ...(s.description ? { description: s.description } : {}),
      rules: [],
      chars: s.description?.length ?? 0,
    }));
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      storeType: this.storeType,
      lasts: this.lasts,
      ...(this.storeKey ? { key: this.storeKey } : {}),
      slots: this.slots,
    };
  }

  private decl(agent: string): StoreDecl {
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
   * What this store's backing type makes of it — file, exact commands, the
   * slots it cannot hold — for the agent it belongs to and the command that
   * serves it (its apx). The plugin is asked once, here; the md body renders
   * this and the document records it (meta.md.stores), so a reader never
   * needs the plugin.
   */
  projection(agent = '', command = ''): ApStoreProjection {
    const type = storeTypeOf(this.storeType);
    if (!type) {
      return { type: this.storeType, location: '', usage: [], rejects: {}, unknownType: { available: storeTypeNames() } };
    }
    const decl = this.decl(agent);
    const rejects: Record<string, string> = {};
    for (const slot of this.slots) {
      const reason = type.rejects?.(slot);
      if (reason) rejects[slot.name] = reason;
    }
    return {
      type: type.name,
      location: type.location(decl),
      usage: type.usage(decl, `${command} ${this.name}`.trim()),
      rejects,
    };
  }

  override asMdBody(env: MdEnv): string {
    const p = this.projection(env.agent, env.apxOf(null));
    if (p.unknownType) {
      return storeUnknownTypeLine(this.name, this.storeType, p.unknownType.available);
    }
    const out: string[] = [storeHomeLine(p.location, this.lasts), '', FIELDS_LABEL];
    const S = FORMULAS.blocks.store;
    for (const slot of this.slots) {
      out.push(fill(S.field, {
        name: slot.name,
        // a store field sets the mark one space further out than a template field
        optional: slot.optional ? ` ${OPTIONAL_MARK}` : '',
        type: phraseOf(slot.type),
        description: slot.description ? fill(FORMULAS.blocks.template.description, { description: slot.description }) : '',
        key: this.storeKey === slot.name ? S.key : '',
      }));
      if (p.rejects[slot.name]) out.push(storeRejectLine(p.type, p.rejects[slot.name]));
    }
    out.push('', storeUsageLabel(p.type), '```', ...p.usage, '```');
    const body = super.asMdBody(env);
    if (body.trim()) out.push('', body);
    return out.join('\n');
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
    const slots = (data.args['slots'] as ApSlot[] | undefined) ?? null;
    block.slots = slots ? slots.map(s => ({ ...s, rules: reviveNodes(s.rules) })) : null;
    block.layout = (data.args['layout'] as string | undefined) ?? null;
    block.example = (data.args['example'] as string | undefined) ?? null;
    block.scalar = (data.args['scalar'] as { typePhrase: string; description?: string } | undefined) ?? null;
    block.shape = (data.args['shape'] as ApShape | undefined) ?? null;
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
      this.slots = parsed.slots.map((s): ApSlot => ({
        name: s.name,
        optional: s.optional,
        type: cx.slotType(s.rawType),
        ...(s.description ? { description: s.description } : {}),
        rules: (s.rawRules ?? []).map(r => {
          const { base, force } = cx.parseForce(r.keyword);
          const rule = new DirectiveNode(base, force, r.text);
          rule.chars = r.text.length;
          return rule;
        }),
        chars: (s.description?.length ?? 0) + (s.rawRules ?? []).reduce((n, r) => n + r.text.length, 0),
      }));
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

  /** Mirror of the legacy renderTemplate — sourced from the typed fields. */
  override asMdBody(env: MdEnv): string {
    const out: string[] = [];
    if (this.scalar) {
      out.push(scalarTemplateLine(this.name, this.scalar.typePhrase, this.scalar.description));
    } else if (this.slots) {
      const T = FORMULAS.blocks.template;
      const layout = this.layout ?? this.slots.map(s => fill(T.layoutSlot, { name: s.name })).join(T.layoutSeparator);
      out.push(templateScaffoldIntro(this.name));
      out.push('', layout, '');
      out.push(FIELDS_LABEL);
      for (const s of this.slots) {
        out.push(fill(T.field, {
          name: s.name,
          optional: s.optional ? OPTIONAL_MARK : '',
          type: slotTypePhrase(env, s.type),
          description: s.description ? fill(T.description, { description: s.description }) : '',
        }));
        for (const r of s.rules) {
          out.push(fill(T.rule, { intro: forceIntro(env, r.keyword, r.force) ?? r.keyword, text: r.text }));
        }
      }
    } else {
      return super.asMdBody(env);
    }
    if (this.example) out.push('', EXAMPLE_OPEN, this.example, EXAMPLE_CLOSE);
    // A structured template renders its own layout, not its body — except a DISTILL mark.
    const marks = this.body.filter(n => n.type === 'distill');
    if (marks.length > 0) out.push('', ...renderNodes(env, marks));
    return out.join('\n');
  }
}

/** A team's scanned context: read once by the recorder, consumed here and by the index. */
export interface TeamScan {
  root: string;
  name: string;
  flowsSource: string;
  /** Top-level blocks of flows.ap, parsed once. */
  topBlocks: Block[];
  /** The FLOW blocks sliced back to raw text. */
  flows: { name: string; body: string }[];
}

export class TeamBlock extends ApBlock {
  static readonly PREFIX = 'tea';
  static readonly NAMESPACE = '@main.teams';
  readonly kind = 'team';
  protected readonly idPrefix = TeamBlock.PREFIX;
  members: ApRef[] = [];
  routing: { when: string; run: ApRef }[] | null = null;
  shared: string | null = null;

  /** The namespace a team's own flows live under. */
  static flowsNamespace(teamName: string): string {
    return `@main.flows.${teamName}`;
  }

  static fromData(data: ApBlockData): TeamBlock {
    const block = restore(new TeamBlock(initOf(data)), data);
    block.members = (data.args['members'] as ApRef[] | undefined) ?? [];
    block.routing = (data.args['routing'] as { when: string; run: ApRef }[] | undefined) ?? null;
    block.shared = (data.args['shared'] as string | undefined) ?? null;
    return block;
  }

  /** Build the team block from its scanned directory: members/routing/shared. */
  static fromScan(scan: TeamScan, cx: BlockCx): TeamBlock {
    const block = new TeamBlock({
      name: scan.name,
      namespace: TeamBlock.NAMESPACE,
      about: readTeamPurpose(scan.root) || null,
    });
    block.members = readTeamMembers(scan.root).map(m => cx.agentRef(m.name));

    // Top-level `WHEN … : RUN <flow>` routing entries of flows.ap.
    const routing: { when: string; run: ApRef }[] = [];
    for (const b of scan.topBlocks) {
      if (b.key !== 'WHEN') continue;
      const when = [b.name, b.rest].filter(Boolean).join(' ');
      for (const child of b.children) {
        if (child.type === 'line' && child.keyword === 'RUN') {
          routing.push({ when, run: cx.runnableRef(child.rest.trim()) });
        }
      }
    }
    if (routing.length > 0) block.routing = routing;

    const teamAp = resolve(scan.root, 'team.ap');
    if (existsSync(teamAp)) {
      const shared = readFileSync(teamAp, 'utf-8').replace(/^RAW:\s*$/m, '').replace(/^:RAW\s*$/m, '').trim();
      if (shared) block.shared = shared;
    }
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      members: this.members,
      ...(this.routing ? { routing: this.routing } : {}),
      ...(this.shared ? { shared: this.shared } : {}),
    };
  }
}

/** What the agent factory needs from the pipeline's collected state. */
export interface AgentSource {
  agentName: string;
  metadata: Map<string, string[]>;
  boundRole: Definition | null;
  agentBody: string;
}

export class AgentBlock extends ApBlock {
  static readonly PREFIX = 'agt';
  static readonly NAMESPACE = '@main.agents';
  readonly kind = 'agent';
  protected readonly idPrefix = AgentBlock.PREFIX;
  role: ApRef | null = null;
  mandate: string | null = null;
  owns: string | null = null;
  lensOut: ApShape | null = null;

  static fromData(data: ApBlockData): AgentBlock {
    const block = restore(new AgentBlock(initOf(data)), data);
    block.role = (data.args['role'] as ApRef | undefined) ?? null;
    block.mandate = (data.args['mandate'] as string | undefined) ?? null;
    block.owns = (data.args['owns'] as string | undefined) ?? null;
    block.lensIn = (data.args['lensIn'] as ApShape | undefined) ?? null;
    block.lensOut = (data.args['lensOut'] as ApShape | undefined) ?? null;
    block.shape = (data.args['shape'] as ApShape | undefined) ?? null;
    return block;
  }

  /**
   * The agent's md preamble — Identity (via the ONE legacy composer) and the
   * lens binding lines. The block owns its own md; the backend composes.
   */
  asMdIdentity(env: MdEnv, roleBlock: ApBlock | null): string {
    const identityMeta = new Map<string, string[]>();
    if (roleBlock) {
      identityMeta.set('ROLE', [deslugifyRole(roleBlock.name)]);
      if (roleBlock.about) identityMeta.set('ROLE-ABOUT', [roleBlock.about]);
      const expertise = (roleBlock as { expertise?: string[] | null }).expertise;
      if (expertise?.length) identityMeta.set('EXPERTISE', [expertise.join(' ')]);
    }
    if (this.mandate) identityMeta.set('MANDATE', [this.mandate]);
    const behaviours = roleBlock ? renderNodes(env, roleBlock.body).join('\n') : '';
    // Legacy composition: `${identityBlock}\n${lens}${body}` — keep the extra newline.
    let out = renderIdentityBlock(identityMeta, behaviours) + '\n';

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
    const md = (k: string): string | null => src.metadata.get(k)?.[0]?.trim() ?? null;
    const block = new AgentBlock({ name: src.agentName, namespace: AgentBlock.NAMESPACE, about: md('ABOUT') });

    const roleName = md('AS');
    if (src.boundRole) {
      const ns = cx.defInit(src.boundRole).namespace;
      block.role = { id: refId('role', ns, src.boundRole.name), target: `${ns}/${src.boundRole.name}`, kind: 'role' };
    } else if (roleName) {
      block.role = { id: null, target: roleName, kind: 'role', resolved: false };
    }
    block.mandate = md('MANDATE');
    block.owns = md('OWNS');
    const lensIn = md('LENS-IN');
    if (lensIn) block.lensIn = { force: 0, ref: cx.templateRef(lensIn) };
    const lensOut = md('LENS-OUT');
    if (lensOut) block.lensOut = { force: 1, ref: cx.templateRef(lensOut) };

    cx.walk(src.agentBody, block.body, block);
    return block;
  }

  protected override argsJson(): Record<string, unknown> {
    return {
      ...(this.role ? { role: this.role } : {}),
      ...(this.mandate ? { mandate: this.mandate } : {}),
      ...(this.owns ? { owns: this.owns } : {}),
      ...(this.lensIn ? { lensIn: this.lensIn } : {}),
      ...(this.lensOut ? { lensOut: this.lensOut } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
    };
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
  entries?: (ctx: BundleContext, opts: { boundRole: Definition | null }) => Definition[];
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
  { kind: 'policy', revive: RuleBlock.fromData, folder: 'policies', chapterTitle: FORMULAS.blocks.policy.chapter, prefix: RuleBlock.PREFIXES['policy'],    ref: null,
    entries: ctx => ctx.policies,   from: RuleBlock.fromDefinition },
  { kind: 'role', revive: RoleBlock.fromData, folder: 'roles', chapterTitle: FORMULAS.blocks.role.chapter, prefix: RoleBlock.PREFIX,                ref: null,
    entries: (ctx, opts) => [...(opts.boundRole ? [opts.boundRole] : []), ...ctx.roles],
    from: RoleBlock.fromDefinition },
  { kind: 'template', revive: TemplateBlock.fromData, folder: 'templates', chapterTitle: FORMULAS.blocks.template.chapter, prefix: TemplateBlock.PREFIX,            ref: 'templates',
    entries: ctx => ctx.templates,  from: TemplateBlock.fromDefinition },
  { kind: 'procedure', revive: RuleBlock.fromData, folder: 'procedures', chapterTitle: FORMULAS.blocks.procedure.chapter, prefix: RuleBlock.PREFIXES['procedure'], ref: 'runnables',
    entries: ctx => ctx.procedures, from: RuleBlock.fromDefinition },
  { kind: 'flow', revive: RuleBlock.fromData, folder: 'flows', chapterTitle: FORMULAS.blocks.flow.chapter, prefix: RuleBlock.PREFIXES['flow'],      ref: 'runnables',
    entries: ctx => ctx.flows,      from: RuleBlock.fromDefinition },
  { kind: 'store', revive: StoreBlock.fromData, folder: 'stores', chapterTitle: FORMULAS.blocks.store.chapter, prefix: StoreBlock.PREFIX,               ref: 'stores',
    entries: ctx => ctx.stores,     from: StoreBlock.fromDefinition },
  // Non-chapter kinds — referenceable identities only.
  { kind: 'playbook', revive: RuleBlock.fromData, folder: 'playbooks',  prefix: RuleBlock.PREFIXES['playbook'],  ref: 'runnables' },
  { kind: 'team', revive: TeamBlock.fromData, folder: 'teams',      prefix: TeamBlock.PREFIX,                ref: null },
  { kind: 'agent', revive: AgentBlock.fromData, folder: 'agents',     prefix: AgentBlock.PREFIX,               ref: null },
];

export function strategyOf(kind: string): KindStrategy | null {
  return KIND_STRATEGIES.find(s => s.kind === kind) ?? null;
}

/** The kind living in a library folder / namespace segment, or null. */
export function kindOfFolder(folder: string): string | null {
  return KIND_STRATEGIES.find(s => s.folder === folder)?.kind ?? null;
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
  const viaLibrary = buildNamespace(def.path, libraryRoots, libraries);
  if (viaLibrary) return viaLibrary.startsWith('@') ? viaLibrary : `@${viaLibrary}`.replace(/^@library/, 'library');
  // A team's flows live in its flows.ap: one namespace per team, whoever builds them.
  if (def.kind === 'flow' && basename(def.path) === TEAM_FLOWS_FILE) return TeamBlock.flowsNamespace(basename(dirname(def.path)));
  return `@main.${folderOfKind(def.kind)}`;
}

/** The block id of a collected definition — the one reference every projection prints. */
export function definitionId(def: Definition, ctx: Pick<BundleContext, 'libraryRoots' | 'libraries'>): string {
  return refId(def.kind, namespaceOf(def, ctx.libraryRoots, ctx.libraries), def.name);
}
