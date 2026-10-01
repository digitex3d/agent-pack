// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * DocumentBuilder — the compiler's BUILD phase: resolved sources → ApDocument.
 *
 * Three named responsibilities, kept apart:
 *
 *   WALKER  — bodies are walked through the shared renderTree pass, which
 *             reports what it traverses via the single generic `on(type,
 *             data)` sink; while ARMED (only during the scoped walks below)
 *             the events become plain nodes. Other render passes fire events
 *             too — ignored, the builder is disarmed. When the remaining
 *             legacy paths (playbook/orchestration) migrate onto the
 *             document, the walker becomes a direct AST visit and the event
 *             bridge retires.
 *
 *   SYMBOLS — the reference index (declare/bind): name → identity, per
 *             reference class, fed by the collected Definitions, the team
 *             scan and the import declarations of out-of-context sources.
 *
 *   PRODUCERS — pure orchestration: each producer acquires ONE source and
 *             returns typed ApBlock subclasses. The JSON/md shape of every
 *             kind lives in its class, never here.
 */
import { existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { BundleContext } from '../dispatch/types.js';
import type { Definition } from '../definition.js';
import { lex, Token } from '../lexer.js';
import { buildTree, isStructural, splitArgs, stripTrailingColon, rawOf, restOf, Node as WalkNode } from '../bundlers/renderTree.js';
import { distillId } from '../distill.js';
import { sequencePrimitiveFor } from '../sequencePrimitives.js';
import { parseTypeSpec, jsonExample, templateClosure } from '../shapeSchema.js';
import { refName } from '../../adapters/md/phrases.js';
import { extractPrimitive, stripPrimitives, exportedBlockBodies } from '../services/text.js';
import { strategyFor } from '../definition.js';
import { stripHeaderKeyword } from '../primitives.js';
import { buildNamespace } from '../namespace.js';
import { align, positionOf, type SourceSpan } from '../sources.js';
import { apxCommand } from '../apx/paths.js';
import type { StoreBlock } from './blocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { ENUM_PRIMITIVES, FORCE_LEVEL_PRIMITIVES, enumPrimitiveFor } from '../primitives.js';
import { validateEnumValue } from '../enumPrimitives.js';
import {
  readTeamMembers,
  teamRootForAgentFile,
  TEAM_FLOWS_FILE,
} from '../services/teamMetadata.js';
import type { ApNode, ApRef, ApShape, ApSlotType, ApStepNode, ApIfNode, ApDocumentMeta, ApStoreProjection } from './types.js';
import { introOf } from '../formulas.js';
import { parseForceLevel, toCanonicalKeyword, getIntroByKeyword, forceLevelFamilies } from '../forceLevelConfig.js';

/** Keyword (post-desugar or alias) → family base + numeric force; null force for bullets. */
function parseForce(keyword: string): { base: string; force: number | null } {
  const canonical = toCanonicalKeyword(keyword);
  const parsed = parseForceLevel(canonical);
  return parsed ? { base: parsed.family, force: parsed.level } : { base: canonical, force: null };
}

/** Trimmed form of stripTrailingColon — for names/titles read from rests. */
function stripColon(s: string): string {
  return stripTrailingColon(s).trim();
}
import { ApBlock, ApBlockInit } from './block.js';
import {
  BlockCx, RuleBlock, TeamBlock, AgentBlock,
  TemplateBlock, TeamScan, KIND_STRATEGIES, strategyOf, kindOfFolder, refId, namespaceOf, RefClass,
} from './blocks.js';
import { ApDocument, BlockProvenance } from './document.js';
import { DirectiveNode, RunNode, TextNode, IfNode, UntilNode, WhenNode, StepNode, ParallelNode, InNode, DistillNode } from './nodes.js';


/** Bullet-group keywords (DO, BY, WHEN, LOG, …) that group like force levels. */
const BULLET_KEYWORDS = new Set(FORCE_LEVEL_PRIMITIVES.map(p => p.keyword));

interface IndexedBlock {
  kind: string;
  name: string;
  namespace: string;
}

/** Everything `finish()` needs from the bundle pipeline's collected state. */
export interface RecorderFinishOpts {
  metadata: Map<string, string[]>;
  boundRole: Definition | null;
  agentBody: string;
  agentFilePath: string;
  /** Where the agent body was written — the span its reader composed it from. */
  agentSpan: SourceSpan | null;
  /** The lazy WHEN→RUN triggers of the Dynamic-rules chapter (bodies fetched on demand). */
  /** The md bootstrap prose (team membership + shared + runtime defaults). */
  bootstrap: string;
  /** Body substitution vars ({{name}} …). */
  vars: Record<string, string>;
  /** Whether the OWNS fence renders in the body (adapter did not claim it). */
  ownsInBody: boolean;
}

export class DocumentBuilder implements BlockCx {
  private ctx: BundleContext | null = null;

  // --- reference index: name → identity, per reference class ---------------
  private runnables = new Map<string, IndexedBlock>();
  private templates = new Map<string, IndexedBlock>();
  private goals = new Map<string, IndexedBlock>();
  private stores = new Map<string, IndexedBlock>();
  private agents = new Map<string, IndexedBlock>();

  private team: TeamScan | null = null;
  /** The source file being built — where an unresolved name is reported. */
  private sourcePath = '';
  /** The span of the block being built — where its nodes were written (null: no positions). */
  private span: SourceSpan | null = null;
  /** The file line of each line of the body being walked (null: no positions). */
  private bodyLines: number[] | null = null;
  /** Every name that resolved to no block: a compile error, reported by the caller. */
  readonly unresolved: { path: string; name: string; kind: string }[] = [];
  /** address → auto tags ('#segment') — md-projection data gathered from Definitions. */
  private breadcrumbs = new Map<string, string[]>();

  /** The reference index a kind's strategy names — lookup, never a branch. */
  private refIndex(ref: RefClass): Map<string, IndexedBlock> {
    return { runnables: this.runnables, templates: this.templates, goals: this.goals, stores: this.stores }[ref];
  }

  // --------------------------------------------------------------- services
  // The BlockCx contract: what a block class may ask of its builder.

  /**
   * Walk one body: the shared indent-tree (buildTree — the SAME walk the md
   * renderer uses) visited directly into nodes. No events, no arming: the
   * builder owns its traversal; a block-level AS lands on `host.shape`.
   */
  walk(body: string, sink: ApNode[], host?: ApBlock): void {
    this.bodyLines = this.span ? align(body.split(/\r?\n/), this.span) : null;
    this.visit(buildTree(lex(body)), sink, host ?? null, []);
    this.bodyLines = null;
  }

  /** Stamp where a node was written: the file line its body line came from. */
  private at<T extends ApNode>(node: T, t: Token): T {
    if (this.span && this.bodyLines) node.pos = positionOf(this.span, this.bodyLines[t.line - 1] ?? this.span.line);
    return node;
  }

  /**
   * Build one block from its source span: its nodes get their positions while
   * it walks, the block its header. No span (a file or block not found) → no
   * positions, never an error.
   */
  private fromSource<T extends ApBlock>(span: SourceSpan | null, build: () => T): T {
    this.span = span;
    const block = build();
    if (this.span) block.source = { file: this.span.file, line: this.span.line, col: positionOf(this.span, this.span.line).col };
    this.span = null;
    return block;
  }

  private visit(nodes: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    let i = 0;
    while (i < nodes.length) {
      const n = nodes[i];
      const t = n.token;

      // Maximal run of non-structural leaves — grouped exactly like the flat pass.
      if (!isStructural(t, n.children.length > 0)) {
        const run: Token[] = [];
        while (i < nodes.length && !isStructural(nodes[i].token, nodes[i].children.length > 0)) {
          run.push(nodes[i].token);
          i++;
        }
        this.leafRun(run, sink, host, steps);
        continue;
      }

      if (t.kind !== 'keyword') {
        // Prose (or unknown token) with an indented body: verbatim head, children flattened.
        this.pushText(sink, t);
        this.visit(n.children, sink, host, steps);
        i++;
        continue;
      }

      const kw = t.keyword as string;

      // Sequence block (STEP): consecutive siblings, signature split from body.
      if (sequencePrimitiveFor(kw)) {
        while (i < nodes.length) {
          const item = nodes[i];
          if (item.token.kind !== 'keyword' || (item.token.keyword as string) !== kw) break;
          const { body, args } = splitArgs(kw, item.children);
          const by = args.get('BY');
          const step = this.at(new StepNode(
            stripColon(restOf(item.token)),
            by ? this.ref(this.agents.get(stripColon(by)), stripColon(by), 'agent') : null,
            args.get('CONTEXT') ?? null,
          ), item.token);
          sink.push(step);
          this.visit(body, step.body, host, [...steps, step]);
          i++;
        }
        continue;
      }

      // `IN <store>:` — the steps beneath work in that store. The name resolves
      // to a Ref against the declared stores, so an unknown one is caught here
      // rather than reading as prose.
      if (kw === 'IN') {
        const name = stripTrailingColon(t.rest).trim();
        const node = this.at(new InNode(this.ref(this.stores.get(name), name, 'store'), t.indent), t);
        sink.push(node);
        this.visit(n.children, node.body, host, steps);
        i++;
        continue;
      }

      if (kw === 'PARALLEL') {
        const node = this.at(new ParallelNode(), t);
        sink.push(node);
        this.visit(n.children, node.steps as unknown as ApNode[], host, steps);
        i++;
        continue;
      }

      if (kw === 'IF') {
        const node = this.at(new IfNode(stripTrailingColon(t.rest), t.indent), t);
        sink.push(node);
        this.visit(n.children, node.then, host, steps);
        i++;
        continue;
      }
      if (kw === 'ELSE') {
        // ELSE is the second branch of the preceding IF, not a node of its own.
        const prior = [...sink].reverse().find((x): x is ApIfNode => x.type === 'if');
        this.visit(n.children, prior ? prior.else : sink, host, steps);
        i++;
        continue;
      }
      if (kw === 'UNTIL') {
        const node = this.at(new UntilNode(stripTrailingColon(t.rest), t.indent), t);
        sink.push(node);
        this.visit(n.children, node.body, host, steps);
        i++;
        continue;
      }

      // Bodied leaf keyword head (e.g. `WHEN <trigger>:`): open its container.
      const { base, force } = parseForce(kw);
      const rest = stripColon(t.rest);
      // `MEM <event>` with an `AS <template>` line beneath: the memory's shape.
      if (base === 'MEM') {
        const node = this.at(new DirectiveNode(base, force, rest, t.indent), t);
        for (const c of n.children) {
          if (c.token.kind !== 'keyword') continue;
          const as = parseForce(c.token.keyword as string);
          if (as.base === 'AS') node.shape = { force: as.force ?? 0, ref: this.templateRef(stripColon(c.token.rest)) };
        }
        sink.push(node);
        i++;
        continue;
      }
      if (base === 'WHEN') {
        const node = this.at(new WhenNode(rest, t.indent), t);
        sink.push(node);
        this.visit(n.children, node.body, host, steps);
      } else {
        const node = this.at(new DirectiveNode(base, force, rest, t.indent, []), t);
        sink.push(node);
        this.visit(n.children, node.body!, host, steps);
      }
      i++;
    }
  }

  /** A leaf run: group consecutive same-keyword lines, emit typed nodes. */
  private leafRun(tokens: Token[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.kind !== 'keyword') {
        if (t.kind !== 'blank' && t.kind !== 'comment') this.pushText(sink, t);
        i++;
        continue;
      }
      const keyword = t.keyword as string;
      const indent = t.indent;
      const actions: string[] = [t.rest];
      let j = i + 1;
      while (j < tokens.length) {
        const tt = tokens[j];
        if (tt.kind !== 'keyword' || (tt.keyword as string) !== keyword || tt.indent !== indent) break;
        actions.push(tt.rest);
        j++;
      }

      const { base, force } = parseForce(keyword);
      if (base === 'RUN') {
        // The Ref resolves on the builder's own symbol table.
        actions.forEach((raw, k) => {
          const name = raw.trim();
          sink.push(this.at(new RunNode(this.ref(this.runnables.get(name), name, 'procedure'), indent), tokens[i + k]));
        });
      } else if (base === 'AS') {
        this.applyShape(force ?? 0, actions[0] ?? '', sink, host, steps);
      } else if (base === 'DISTILL') {
        // A bare level line: only a procedure can be distilled.
        if (host?.kind !== 'procedure') {
          throw new Error(`DISTILL belongs in a PROCEDURE${host ? ` — found in ${host.kind} \`${host.name}\`` : ''}`);
        }
        host.distill = force ?? 0;
      } else if (base === 'LENS-IN' && host?.kind === 'procedure') {
        // A procedure's input contract.
        host.lensIn = { force: 0, ref: this.templateRef(stripColon(actions[0] ?? '')) };
      } else if (enumPrimitiveFor(keyword)) {
        // Stray enum line (e.g. CONTEXT outside a step signature): validate and
        // apply to the innermost step lacking one — mirror of the legacy pass.
        for (const raw of actions) this.applyEnum(keyword, raw.trim(), steps);
      } else if (getIntroByKeyword(keyword) !== null || BULLET_KEYWORDS.has(keyword)) {
        // Plain grouped lines: text travels VERBATIM (a trailing colon may be
        // legitimate prose); the source indent is presentation, recorded apart.
        actions.forEach((a, k) => sink.push(this.at(new DirectiveNode(base, force, a, indent), tokens[i + k])));
      } else {
        // Unclaimed keyword lines pass through verbatim (the legacy raw path).
        for (let k = i; k < j; k++) this.pushText(sink, tokens[k]);
      }
      i = j;
    }
  }

  private pushText(sink: ApNode[], token: Token): void {
    const raw = rawOf(token);
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) return;
    // Keep the line as written (indentation included) — it is verbatim text.
    sink.push(this.at(new TextNode(raw.replace(/\s+$/, '')), token));
  }

  private applyShape(force: number, rawName: string, sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    const shape: ApShape = { force, ref: this.templateRef(stripColon(rawName)) };
    const step = steps[steps.length - 1];
    if (step) { step.shape = shape; return; }
    if (host) {
      host.shape = shape;
      // Source position of the AS line, when it sits directly in the host body.
      host.shapePos = sink === host.body ? host.body.length : null;
    }
  }

  private applyEnum(keyword: string, value: string, steps: ApStepNode[]): void {
    const prim = enumPrimitiveFor(keyword);
    if (!prim || !validateEnumValue(prim, value, this.ctx ?? undefined)) return;
    const step = steps[steps.length - 1];
    if (step && keyword === 'CONTEXT' && step.context === null) step.context = value;
  }

  /** Keyword (or alias) → family base + numeric force — BlockCx service. */
  parseForce(keyword: string): { base: string; force: number | null } {
    return parseForce(keyword);
  }

  /** Resolve a slot's raw TYPE expression, with template refs into the index. */
  slotType(rawType: string): ApSlotType {
    const spec = parseTypeSpec(rawType);
    switch (spec.kind) {
      case 'text': {
        const t: ApSlotType = { kind: 'text' };
        if (spec.minWords !== undefined) t.minWords = spec.minWords;
        if (spec.maxWords !== undefined) t.maxWords = spec.maxWords;
        if (spec.regex) t.regex = spec.regex.source;
        return t;
      }
      case 'number': {
        const t: ApSlotType = { kind: 'number' };
        if (spec.min !== undefined) t.min = spec.min;
        if (spec.max !== undefined) t.max = spec.max;
        return t;
      }
      case 'enum':
        return { kind: 'enum', values: spec.values };
      case 'shape':
        return { kind: 'shape', ref: this.templateRef(spec.ref) };
      case 'list': {
        const t: ApSlotType = { kind: 'list', ref: this.templateRef(spec.ref) };
        if (spec.min !== undefined) t.min = spec.min;
        if (spec.max !== undefined) t.max = spec.max;
        return t;
      }
      case 'any':
        return { kind: 'any', raw: spec.raw };
    }
  }

  // ------------------------------------------------------------- references

  private ref(entry: IndexedBlock | undefined, rawName: string, expectedKind: string): ApRef {
    if (!entry) {
      if (!this.unresolved.some(u => u.path === this.sourcePath && u.name === rawName)) {
        this.unresolved.push({ path: this.sourcePath, name: rawName, kind: expectedKind });
      }
      return { id: null, target: rawName, kind: expectedKind, resolved: false };
    }
    return {
      id: refId(entry.kind, entry.namespace, entry.name),
      target: `${entry.namespace}/${entry.name}`,
      kind: entry.kind,
    };
  }

  /** A deterministic Ref from a `namespace/name` address (manifest key). */
  refFromAddress(address: string, expectedKind = 'procedure'): ApRef {
    const slash = address.lastIndexOf('/');
    if (slash === -1) return { id: null, target: address, kind: expectedKind, resolved: false };
    const namespace = address.slice(0, slash);
    const name = address.slice(slash + 1);
    const kind = kindOfFolder(namespace.split('.')[1] ?? '') ?? expectedKind;
    return { id: refId(kind, namespace, name), target: address, kind };
  }

  templateRef(name: string): ApRef {
    return this.ref(this.templates.get(name), name, 'template');
  }

  agentRef(name: string): ApRef {
    return this.ref(this.agents.get(name), name, 'agent');
  }

  runnableRef(name: string): ApRef {
    return this.ref(this.runnables.get(name), name, 'flow');
  }

  /** Namespace of a library file path, or null when outside every root. */
  namespaceOfPath(path: string): string | null {
    return buildNamespace(path, this.ctx!.libraryRoots, this.ctx!.libraries) || null;
  }

  private nsOf(def: Definition): string {
    return namespaceOf(def, this.ctx!.libraryRoots, this.ctx!.libraries);
  }

  /** The universal init of a block born from a collected Definition. */
  defInit(def: Definition): ApBlockInit {
    this.breadcrumbs.set(
      `${this.nsOf(def)}/${def.name}`,
      def.breadcrumb.map(seg => `#${seg}`),
    );
    return {
      name: def.name,
      namespace: this.nsOf(def),
      about: def.about,
      tags: def.tags.map(t => t.replace(/^#/, '')),
      applies: extractPrimitive(def.body, 'APPLIES'),
      when: extractPrimitive(def.body, 'WHEN') ?? 'always',
    };
  }

  /** Body text with catalog/identity keywords removed — only content walks. */
  walkableBody(def: Definition): string {
    // Legacy (non-EXPORT) modules carry their own header line in the body —
    // same strip the md renderer applies (strategy-declared header keyword).
    const headerKeyword = strategyFor(def.kind)?.headerKeyword;
    const body = headerKeyword ? stripHeaderKeyword(def.body, headerKeyword, def.name) : def.body;
    // ABOUT is stripped only when it was LIFTED into the catalog field (imported
    // and inline blocks alike go through liftUnitMetadata).
    return def.about !== null
      ? stripPrimitives(body, 'ABOUT', 'TAGS', 'APPLIES', 'EXPERTISE')
      : stripPrimitives(body, 'TAGS', 'APPLIES', 'EXPERTISE');
  }

  // ---------------------------------------------------------- index (pass 1)

  private indexDefinition(def: Definition): void {
    const ref = strategyOf(def.kind)?.ref;
    if (!ref) return;
    this.refIndex(ref).set(def.name, { kind: def.kind, name: def.name, namespace: this.nsOf(def) });
  }

  /**
   * Index the `IMPORT a, b FROM @ns` declarations of a source that never
   * reaches the agent's BundleContext (a team's flows.ap, the log recipe).
   * The FROM namespace makes the address — and therefore the stable id —
   * fully derivable without resolving the module body.
   */
  private indexImportLines(source: string): void {
    for (const line of source.split(/\r?\n/)) {
      const m = line.match(/^IMPORT\s+(.+?)\s+FROM\s+(\S+)\s*$/);
      if (!m) continue;
      const ns = m[2];
      const kind = kindOfFolder(ns.split('.')[1] ?? '');
      const ref = kind ? strategyOf(kind)?.ref : null;
      if (!kind || !ref) continue;
      for (const raw of m[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        this.refIndex(ref).set(name, { kind, name, namespace: ns });
      }
    }
  }

  /** Read the agent's team ONCE: members, flows source, parsed blocks, flow slices. */
  private scanTeam(agentFilePath: string): TeamScan | null {
    const root = teamRootForAgentFile(agentFilePath);
    if (!root) return null;
    const name = basename(root);
    const flowsPath = resolve(root, TEAM_FLOWS_FILE);
    const sources = this.ctx!.sources;
    const flowsSource = existsSync(flowsPath) ? sources.read(flowsPath) : '';
    const topBlocks = flowsSource ? sources.tree(flowsPath).blocks : [];
    // A FLOW's body runs from the line after its header to the next TOP-LEVEL
    // block (any kind — a WHEN can sit between two FLOWs), or to EOF.
    const flows = topBlocks
      .filter(b => b.key === 'FLOW' && b.name !== null)
      .map(b => ({ name: b.name!, body: sources.blockSpan(flowsPath, b).lines.slice(1).map(l => l.text).join('\n') }));
    return { root, name, flowsSource, topBlocks, flows };
  }

  private buildRefIndex(ctx: BundleContext, opts: RecorderFinishOpts): void {
    for (const strategy of KIND_STRATEGIES) {
      for (const def of strategy.entries?.(ctx, opts) ?? []) this.indexDefinition(def);
    }
    this.agents.set(ctx.agentName, { kind: 'agent', name: ctx.agentName, namespace: AgentBlock.NAMESPACE });

    if (this.team) {
      for (const member of readTeamMembers(this.team.root)) {
        this.agents.set(member.name, { kind: 'agent', name: member.name, namespace: AgentBlock.NAMESPACE });
      }
      this.indexImportLines(this.team.flowsSource);
      for (const f of this.team.flows) {
        this.runnables.set(f.name, { kind: 'flow', name: f.name, namespace: TeamBlock.flowsNamespace(this.team.name) });
      }
    }
  }

  // ------------------------------------------------------ producers (pass 2)
  // Each producer acquires ONE source and returns typed blocks. The JSON
  // shape of every kind lives in its class (blocks.ts), not here.

  /**
   * The imported definitions: one loop over the kind strategies — each block
   * builds ITSELF from its Definition (the class owns the logic), the
   * registry only says which kinds exist and where their entries live.
   */
  private definitionBlocks(ctx: BundleContext, opts: RecorderFinishOpts): ApBlock[] {
    const out: ApBlock[] = [];
    for (const strategy of KIND_STRATEGIES) {
      if (!strategy.entries || !strategy.from) continue;
      for (const def of strategy.entries(ctx, opts)) {
        this.sourcePath = def.path;
        const from = strategy.from;
        const block = this.fromSource(ctx.sources.span(def.path, def.kind, def.name), () => from(def, this));
        // A procedure's `DISTILL` line: its mark closes the body, with the
        // procedure's own contract — output AS (required), input LENS-IN.
        if (block.distill !== null) {
          if (!block.shape) throw new Error(`PROCEDURE \`${def.name}\`: DISTILL needs an output contract — add AS <template>`);
          const out = this.contractSources(block.shape);
          const inp = this.contractSources(block.lensIn);
          block.body.push(new DistillNode(
            block.distill,
            distillId(def.body, [...inp, ...out]),
            block.shape,
            JSON.stringify(jsonExample(refName(block.shape.ref), ctx.templates)),
            block.lensIn ? { shape: block.lensIn, example: JSON.stringify(jsonExample(refName(block.lensIn.ref), ctx.templates)) } : undefined,
          ));
        }
        out.push(block);
      }
    }
    return out;
  }

  /** The sources of a contract's template and of every template it nests, for a DISTILL id. */
  contractSources(shape: ApShape | undefined | null): string[] {
    const name = shape?.ref.target.split('/').pop();
    return name ? templateClosure(name, this.ctx?.templates ?? []) : [];
  }

  /** The team block (built by its class from the scan) + its flow blocks. */
  private teamBlocks(): ApBlock[] {
    if (!this.team) return [];
    const team = this.team;
    const sources = this.ctx!.sources;
    const flowsPath = resolve(team.root, TEAM_FLOWS_FILE);
    this.sourcePath = flowsPath;
    const flowsNs = TeamBlock.flowsNamespace(team.name);
    return [
      ...team.flows.map(f => this.fromSource(sources.span(flowsPath, 'flow', f.name), () => RuleBlock.fromBody('flow', { name: f.name, namespace: flowsNs }, f.body, this))),
      // The team is its flows.ap as a whole: no TEAM block there, so the file from line 1.
      this.fromSource(sources.span(flowsPath, 'team', team.name), () => TeamBlock.fromScan(team, this)),
    ];
  }

  /** The agent root block — built by its class from the pipeline's state. */
  private agentBlock(ctx: BundleContext, opts: RecorderFinishOpts): ApBlock {
    this.sourcePath = opts.agentFilePath;
    return this.fromSource(opts.agentSpan, () => AgentBlock.fromContext({ agentName: ctx.agentName, ...opts }, this));
  }

  // -------------------------------------------------------------------- meta

  private buildMeta(ctx: BundleContext): ApDocumentMeta {
    // Each family's phrases, with the active adapter's renderings over them.
    const forceLevels: Record<string, Record<string, string>> = {};
    for (const f of forceLevelFamilies()) forceLevels[f.name] = { ...f.levels, ...ctx.renderings?.[f.name] };

    const enums: Record<string, Record<string, string>> = {};
    for (const prim of ENUM_PRIMITIVES) {
      enums[prim.keyword] = Object.fromEntries(
        Object.entries(prim.values).map(([k, fn]) => [k, ctx.renderings?.[prim.keyword]?.[k] ?? fn()]),
      );
    }

    const flowRun = ctx.renderings?.['FLOW']?.['run'];
    return {
      root: `${AgentBlock.NAMESPACE}/${ctx.agentName}`,
      forceLevels,
      enums,
      ...(flowRun ? { flowRun } : {}),
    };
  }

  /**
   * The md-projection metadata, SERIALIZED into meta.md — everything a
   * decompiler needs beyond the blocks: bootstrap prose (RAW-clean), the
   * chapter intros (pre-rendered, and ONLY for chapters this document
   * actually has — anything else is wasted bytes), substitution vars,
   * breadcrumbs, presentation positions.
   */
  private buildMdMeta(
    doc: ApDocument,
    opts: RecorderFinishOpts,
    provenance: Record<string, string>,
  ): import('./types.js').ApMdMeta {
    const renderedIntro = (name: string): string => {
      const raw = introOf(name);
      return raw ? renderTree(raw, undefined) : '';
    };

    // Intros: every kind this document holds — the md opens its chapters
    // with them, the apx serves them to whoever misses that kind's quiz.
    const intros: Record<string, string> = {};
    for (const kind of new Set(doc.all().map(b => b.kind))) {
      const text = renderedIntro(kind);
      if (text) intros[kind] = text;
    }

    const breadcrumbs: Record<string, string[]> = {};
    for (const [address, tags] of this.breadcrumbs) {
      if (tags.length > 0) breadcrumbs[address] = tags;
    }

    const shapePos: Record<string, number> = {};
    for (const prov of ['definition', 'team', 'agent'] as const) {
      for (const block of doc.byProvenance(prov)) {
        if (block.shapePos !== null && block.shape) shapePos[block.address] = block.shapePos;
      }
    }

    return {
      // RAW block delimiters are lexer syntax — cleaned at the source.
      bootstrap: opts.bootstrap.split('\n').filter(l => !/^\s*(RAW:|:RAW)\s*$/.test(l)).join('\n'),
      intros,
      vars: opts.vars,
      breadcrumbs,
      agentBodyLead: (/^\n*/.exec(opts.agentBody)?.[0].length ?? 0) || 1,
      ownsInBody: opts.ownsInBody,
      provenance,
      shapePos,
    };
  }

  // ------------------------------------------------------------------ finish

  /**
   * Assemble the document: scan the team, index the referenceable identities,
   * run each producer, seal. Called once, after the md pass (assignedNumbers
   * propagated, lint complete).
   */
  finish(ctx: BundleContext, opts: RecorderFinishOpts): ApDocument {
    this.ctx = ctx;
    this.team = this.scanTeam(opts.agentFilePath);
    this.buildRefIndex(ctx, opts);

    const doc = new ApDocument(this.buildMeta(ctx));
    const producers: [BlockProvenance, () => ApBlock[]][] = [
      ['definition', () => this.definitionBlocks(ctx, opts)],
      ['team',       () => this.teamBlocks()],
      ['agent',      () => [this.agentBlock(ctx, opts)]],
    ];
    const provenanceMap: Record<string, string> = {};
    for (const [provenance, produce] of producers) {
      for (const block of produce()) {
        doc.add(block, provenance);
        provenanceMap[block.address] = provenance;
      }
    }
    doc.seal();
    const md = this.buildMdMeta(doc, opts, provenanceMap);
    doc.attachMdSource(md);
    const stores: Record<string, ApStoreProjection> = {};
    for (const block of doc.byKind('store')) stores[block.address] = (block as StoreBlock).projection(ctx.agentName, apxCommand(ctx.agentName));
    if (Object.keys(stores).length > 0) md.stores = stores;
    return doc;
  }
}
