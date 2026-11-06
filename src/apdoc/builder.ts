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
 *             legacy paths (standalone/orchestration) migrate onto the
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
import { readDecorator, decoratorPhrase, lookupIn } from '../decoratorUse.js';
import { DecoratorScope, DECORATOR_MARK, escapeMessage, workless, type DecoratorLine } from '../decorators.js';
import { plugins, pluginOf } from '../plugins.js';
import { basename } from 'node:path';
import type { BundleContext } from '../dispatch/types.js';
import type { Definition } from '../definition.js';
import { lex, type Token } from '../lexer.js';
import { buildTree, isStructural, stripTrailingColon, rawOf, restOf, type Node as WalkNode } from '../bundlers/renderTree.js';
import { condCheckOf, checkedKeyword, checkedVars, questionOf, sugaredHead, splitMax, maxIssue, type ApCheckSpec, type CheckKind, type CheckLevel, type CheckSite } from '../check.js';
import { sequencePrimitiveFor } from '../sequencePrimitives.js';
import { parseTypeSpec, templateClosure } from '../shapeSchema.js';
import { refName } from '../../adapters/md/phrases.js';
import { extractPrimitive, stripPrimitives, } from '../services/text.js';
import { strategyFor } from '../definition.js';
import { stripHeaderKeyword } from '../primitives.js';
import { buildNamespace } from '../namespace.js';
import { buildRoleIndex, resolveRole, type RoleIndex } from '../roleIndex.js';
import { align, positionOf, type SourceSpan } from '../sources.js';
import { apxCommand } from '../apx/paths.js';
import type { StoreBlock } from './blocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { ENUM_PRIMITIVES, FORCE_LEVEL_PRIMITIVES, enumPrimitiveFor } from '../primitives.js';
import { validateEnumValue } from '../enumPrimitives.js';
import {
  readTeamMembers,
  readTeamFile,
  teamRootForAgentFile,
} from '../services/teamMetadata.js';
import { type Block } from '../parseBlocks.js';
import type { ApNode, ApRef, ApShape, ApSlotType, ApStepNode, ApIfNode, ApDocumentMeta, ApStoreProjection } from './types.js';
import { parseVarLine, eachHeadOf, readsOf, splitInto, takesInto, constantOf, type VarScope } from '../vars.js';
import { isDelegationVerb, parseDelegation, bindBackgroundWork, parseMark, contractListOf, delegationPhrases, MARK_VERB, type ApMark } from '../delegation.js';
import { splitHarness } from '../delegation.js';
import { shortId } from './ids.js';
import type { PlacedVariable } from '../exportedVars.js';
import { introOf, refSuffix, } from '../formulas.js';
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
import type { ApBlock, ApBlockInit } from './block.js';
import {
  type BlockCx, RuleBlock, TeamBlock, AgentBlock, VarBlock,type TeamScan, KIND_STRATEGIES, strategyOf, kindOfFolder, refId, namespaceOf, type RefClass,
} from './blocks.js';
import { ApDocument, type BlockProvenance } from './document.js';
import { COMPUTE_SECTIONS, executorMark, executorSpecs, returnShape } from '../executor.js';
import { DirectiveNode, RunNode, TextNode, IfNode, UntilNode, WhenNode, StepNode, EachNode, InNode, VarNode } from './nodes.js';
import { splitList } from '../lists.js';


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
  /** The roles the agent binds with `AS <role>, …`, in order — empty when none. */
  boundRoles: Definition[];
  agentBody: string;
  agentFilePath: string;
  /** Where the agent body was written — the span its reader composed it from. */
  agentSpan: SourceSpan | null;
  /** The lazy WHEN→RUN triggers of the Dynamic-rules chapter (bodies fetched on demand). */
  /** The md bootstrap prose (team membership + shared + runtime defaults). */
  bootstrap: string;
  /** Body substitution vars ({{name}} …) — the constants. */
  vars: Record<string, string>;
  /** The variables the agent imports, with where (`` `@main.vars` ``). */
  declaredVars: PlacedVariable[];
  /** The project's teams, by name — what a `BY <team>` resolves against. Absent: not known. */
  teams?: readonly string[];
}

/** A variable's declaration: its name, scope, template, and where it was written. */
interface VarSite {
  name: string;
  scope: VarScope;
  type: string | null;
  /** A `VAR x:` block: it assigns as well — or only assigns, a variable the agent imports. */
  block: boolean;
  /** How `ls kind=var` says where it lives: `` `@main.vars` ``, `procedure verify`. */
  where: string;
  path: string;
  line: number | null;
  /** Declared in a body of this agent — not imported. */
  inBody: boolean;
}

export class DocumentBuilder implements BlockCx {
  private ctx: BundleContext | null = null;

  // --- reference index: name → identity, per reference class ---------------
  private runnables = new Map<string, IndexedBlock>();
  private templates = new Map<string, IndexedBlock>();
  private goals = new Map<string, IndexedBlock>();
  private stores = new Map<string, IndexedBlock>();
  private agents = new Map<string, IndexedBlock>();
  /** The project's teams, by name. */
  private projectTeams: readonly string[] = [];
  /** The lists a MARK of a flow fills, by name — what a `DELEGATE <list>` hands out. */
  private markedLists = new Set<string>();
  /** A flow's DELEGATE of one bare name no MARK above it fills — an error when that name is a variable (D63). */
  private bareDelegations: { name: string; path: string; line: number | null }[] = [];

  private team: TeamScan | null = null;
  /** The team's roles, each bound to the member that takes it — `BY <role>` names that member, as in AGENTS.md. */
  private roles: RoleIndex | null = null;
  /** The source file being built — where an unresolved name is reported. */
  private sourcePath = '';
  /** The span of the block being built — where its nodes were written (null: no positions). */
  private span: SourceSpan | null = null;
  /** The file line of each line of the body being walked (null: no positions). */
  private bodyLines: number[] | null = null;
  /** Every name that resolved to no block: a compile error, reported by the caller. */
  readonly unresolved: { path: string; name: string; kind: string }[] = [];
  /** address → auto tags ('#segment') — md-projection data gathered from Definitions. */
  /** The variables declared in the bodies walked, in walk order. */
  private varSites: VarSite[] = [];
  /** Every assignment of a variable — a `VAR x:` block, a `DO … INTO x` — in walk order. */
  private varWrites: { name: string; node: VarNode | DirectiveNode | RunNode; path: string }[] = [];
  /** Every `EACH … IN {{<list>}}` — its list must be a variable typed with one LIST slot (D56). */
  private eachLists: { name: string; node: EachNode; path: string }[] = [];
  /** The INTO of each delegation inside an EACH — it collects one result per run, a list (D56). */
  private eachInto: { name: string; node: DirectiveNode; path: string }[] = [];
  /** How deep the walk is inside EACH blocks: their delegations' INTOs collect lists. */
  private eachDepth = 0;
  /** What is wrong with the variables: a compile error each, reported by the caller. */
  readonly varErrors: { path: string; name: string; line: number | null; message: string }[] = [];
  /** The checked conditions this agent's apx answers for, in walk order — their questions are built at finish. */
  private checkSites: { id: string; kind: CheckKind; level: CheckLevel; head: string; condition: string; inStep: boolean; rounds?: number; path: string; line: number | null }[] = [];
  /** The IF! token a `WHEN!` was desugared into, while its WHEN's body is walked — and the head its messages name (`WHEN!`). */
  private sugared: { token: Token; head: string } | null = null;
  /** The WHEN whose body is walked, and the bodies an `AS` line shapes it from — its own, and a `WHEN!`'s IF! branch. */
  private when: { node: WhenNode; bodies: ApNode[][] } | null = null;
  /** What is wrong with the checked conditions: a compile error each — or a warning — reported by the caller. */
  readonly checkIssues: { path: string; name: string; line: number | null; message: string; severity?: 'warning' }[] = [];
  /** What does not hold in the decorators walked — names and tags that select nothing (src/decorators.ts). */
  readonly decoratorProblems: { path: string; line: number | null; message: string }[] = [];
  /** The blocks some decorator names — a policy, a skill or a dimension named so holds there (unappliedErrors). */
  readonly decoratorNamed = new Set<string>();
  /** At every decorator walked, what its key names there — combined with the enclosing ones of the same key. */
  readonly decoratorTrail: { path: string; line: number | null; key: string; names: string[] }[] = [];
  /** The conditions the walk is under at this point: every enclosing decorator, combined. */
  private scope: DecoratorScope = DecoratorScope.EMPTY;
  /** The decorators above the definition being built, until its first walk wraps its work in them. */
  private definitionDecorators: DecoratorLine[] | null = null;
  /** Every step walked, with the agent its BY names and the conditions it is under — what a step may do is held to its agent's (compiler). */
  /** Each `DELEGATE … BY x` / `FORK … BY x`, under the decorators enclosing it — a flow step's `@WITHIN` among them. */
  readonly delegationScopes: { by: string; scope: DecoratorScope; path: string; line: number | null }[] = [];
  /** The agent the DELEGATE block being walked goes to — null outside one. */
  private delegatedTo: string | null = null;

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
    // A definition's decorators decorate all its work: its first walk is their block's.
    const decorators = this.definitionDecorators ?? [];
    this.definitionDecorators = null;
    const text = decorators.length ? wrapped(decorators, body) : body;
    this.bodyLines = this.span ? align(text.split(/\r?\n/), this.span) : null;
    decorators.forEach((d, k) => { if (this.bodyLines) this.bodyLines[k] = d.line; });
    this.visit(buildTree(lex(text)), sink, host ?? null, []);
    this.bodyLines = null;
  }

  /** Stamp where a node was written: the file line its body line came from. */
  private at<T extends ApNode>(node: T, t: Token): T {
    const line = this.fileLine(t);
    if (line !== null) node.pos = positionOf(this.span!, line);
    return node;
  }

  /** The file line a body token came from — null when the block has no positions. */
  private fileLine(t: Token): number | null {
    return this.span && this.bodyLines ? this.bodyLines[t.line - 1] ?? this.span.line : null;
  }

  /**
   * Build one block from its source span: its nodes get their positions while
   * it walks, the block its header. No span (a file or block not found) → no
   * positions, never an error.
   */
  private fromSource<T extends ApBlock>(span: SourceSpan | null, build: () => T, decorators: readonly DecoratorLine[] = span?.decorators ?? []): T {
    this.span = span;
    this.definitionDecorators = decorators.length ? [...decorators] : null;
    const block = build();
    // A definition whose build walked no body has no work for the decorators above it.
    for (const d of this.definitionDecorators ?? []) this.decoratorProblems.push({ path: this.sourcePath, line: d.line, message: workless(d.key, block.kind.toUpperCase()) });
    this.definitionDecorators = null;
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

      // A COMPUTE block's sections: REQUIRE and ENSURE land on the block, RETURN AS <template>
      // is its result's shape and its body the computation (src/executor.ts).
      if (t.kind === 'blockOpener' && host && (COMPUTE_SECTIONS as readonly string[]).includes(t.key)) {
        if (t.key === 'RETURN') {
          const as = returnShape(t.rest);
          if (as) host.shape = { force: 0, ref: this.templateRef(as) };
          // Where RETURN starts — the AS line renders there, and the computation after it.
          host.shapePos = sink === host.body ? host.body.length : null;
          this.visit(n.children, sink, host, steps);
        } else {
          this.visit(n.children, t.key === 'REQUIRE' ? (host.require ??= []) : (host.ensure ??= []), host, steps);
        }
        i++;
        continue;
      }

      // A decorator: opening a block, it decorates its own lines; above one, the block that
      // follows — through any decorators stacked between them.
      if (t.kind === 'decorator') {
        let end = i;
        if (!t.opens) {
          end = i + 1;
          while (end < nodes.length && (nodes[end].token.kind === 'blank' || (nodes[end].token.kind === 'decorator' && !(nodes[end].token as { opens: boolean }).opens))) end++;
        }
        this.decorate(t, t.opens ? n.children : nodes.slice(i + 1, end + 1), sink, host, steps);
        i = t.opens ? i + 1 : end + 1;
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

      // Sequence block (STEP): consecutive siblings, each a label over the lines whoever runs the flow carries out.
      if (sequencePrimitiveFor(kw)) {
        while (i < nodes.length) {
          const item = nodes[i];
          if (item.token.kind !== 'keyword' || (item.token.keyword as string) !== kw) break;
          const step = this.at(new StepNode(stripColon(restOf(item.token))), item.token);
          sink.push(step);
          this.visit(item.children, step.body, host, [...steps, step]);
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

      if (kw === 'EACH') {
        // `EACH <item> IN {{<list>}} MAX <n>:` — a malformed head is the lint's to report; a DIMENSION's EACH line is no block.
        const each = eachHeadOf(t.rest);
        if (each) {
          const node = this.at(new EachNode({ item: each.item, list: VarBlock.ref(each.list), max: each.max }, t.indent), t);
          this.eachLists.push({ name: each.list, node, path: this.sourcePath });
          sink.push(node);
          this.eachDepth++;
          this.visit(n.children, node.body, host, steps);
          this.eachDepth--;
          i++;
          continue;
        }
      }

      if (kw === 'IF') {
        const split = splitMax(stripTrailingColon(t.rest));
        const node = this.at(new IfNode(split.condition, t.indent), t);
        const bounded = this.executed('IF', node, t, host) || this.checked('IF', node, t, host, steps);
        this.roundsIssue('IF', node.condition, t, bounded, split);
        sink.push(node);
        // The IF! a `WHEN!` was desugared into: its lines are the trigger's.
        if (t === this.sugared?.token) this.when?.bodies.push(node.then);
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
        const split = splitMax(stripTrailingColon(t.rest));
        const node = this.at(new UntilNode(split.condition, t.indent, split.max), t);
        const bounded = this.executed('UNTIL', node, t, host) || this.checked('UNTIL', node, t, host, steps);
        this.roundsIssue('UNTIL', node.condition, t, bounded, split);
        sink.push(node);
        this.visit(n.children, node.body, host, steps);
        i++;
        continue;
      }
      if (kw === 'VAR') {
        this.variable(t, n.children, sink, host, steps);
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
        const first = n.children.find(c => c.token.kind !== 'blank')?.token;
        const prior = this.sugared;
        const priorWhen = this.when;
        const head = first?.kind === 'keyword' && first.keyword === 'IF'
          ? sugaredHead({ keyword: 'WHEN', condition: rest }, true, first.level ?? 0, stripTrailingColon(first.rest)) : null;
        this.sugared = head && first ? { token: first, head } : null;
        this.when = { node, bodies: [node.body] };
        this.visit(n.children, node.body, host, steps);
        this.sugared = prior;
        this.when = priorWhen;
      } else if (isDelegationVerb(base)) {
        // `DELEGATE … BY x:` — its DO lines are what the one it goes to is told; a checked condition among them is its.
        const node = this.at(this.directive(base, force, t.rest, t.indent, t, host), t);
        node.body = [];
        sink.push(node);
        const prior = this.delegatedTo;
        this.delegatedTo = node.by ?? null;
        this.visit(n.children, node.body, host, steps);
        this.delegatedTo = prior;
      } else {
        const node = this.at(new DirectiveNode(base, force, rest, t.indent, []), t);
        sink.push(node);
        this.visit(n.children, node.body!, host, steps);
      }
      i++;
    }
  }

  /**
   * An `IF*`/`IF**`/`UNTIL*`/`UNTIL**` head: a delegate or a program decides the
   * condition, which reads at least one variable — its only input. A star with a
   * `!` is the vocabulary check's error: the head is never also checked.
   */
  private executed(kind: CheckKind, node: IfNode | UntilNode, t: Token & { kind: 'keyword' }, host: ApBlock | null): boolean {
    // Unmarked inside a PROCEDURE* / PROCEDURE**, the condition is its executor's too (src/executor.ts).
    const executor = t.executor ?? ((t.level ?? 0) === 0 ? host?.executor ?? 0 : 0);
    if (!executor) return false;
    node.executor = executor;
    if (readsOf(node.condition).length === 0) {
      this.checkIssues.push({ path: this.sourcePath, name: node.condition, line: this.fileLine(t),
        message: `${kind}${executorMark(executor)}: a condition a delegate or a program decides reads at least one variable — \`{{name}}\`: it is the only input they receive` });
    }
    return true;
  }

  /**
   * An `IF!`/`IF!!`/`UNTIL!`/`UNTIL!!` head: the agent whose apx answers for it —
   * this agent, or the agent of the flow's DELEGATE block it sits in — its id, its round
   * limit on an UNTIL, and, sealed, its condition taken out of the node (only
   * the apx's `meta.checks` keeps it). Where it stands is the builder's to say;
   * what follows from it — the id, a warning, an error — is `condCheckOf`'s.
   */
  private checked(kind: CheckKind, node: IfNode | UntilNode, t: Token & { kind: 'keyword' }, host: ApBlock | null, steps: ApStepNode[]): boolean {
    const judged = (t.level ?? 0) > 0;
    // Inside a PROCEDURE* / PROCEDURE** its executor decides the conditions: a judge cannot stand there.
    if (host?.executor && judged) {
      this.checkIssues.push({ path: this.sourcePath, name: node.condition, line: this.fileLine(t),
        message: `${kind}${'!'.repeat(t.level!)} is not allowed under PROCEDURE${executorMark(host.executor)} \`${host.name}\` — its executor decides its conditions: write ${kind} or ${kind}${executorMark(host.executor)}` });
      return judged;
    }
    // In a flow, the one a DELEGATE block goes to checks the conditions among its lines; whoever runs the flow checks none yet.
    const step = steps[steps.length - 1];
    const by = this.delegatedTo;
    // A role names the member bound to it, as AGENTS.md resolves it.
    const agent = by ? (this.roles && resolveRole(this.roles, by)?.name) ?? by : null;
    const site: CheckSite = agent && host?.kind === 'flow' ? { at: 'step', agent: this.agents.has(agent) ? agent : null }
      : host?.kind === 'flow' ? { at: 'flow' } : { at: 'agent', agent: this.ctx!.agentName };
    const head = t === this.sugared?.token ? this.sugared.head : checkedKeyword(kind, t.level ?? 0);
    const rounds = node.type === 'until' ? node.max : undefined;
    const { check, issue } = condCheckOf(kind, t.level ?? 0, node.condition, site, this.ctx?.checks, head, rounds);
    const at = { path: this.sourcePath, name: node.condition, line: this.fileLine(t) };
    if (issue) this.checkIssues.push({ ...at, ...issue });
    if (!check) return judged;
    node.check = check;
    if (check.agent === this.ctx!.agentName) this.checkSites.push({ ...at, id: check.id, kind, level: check.level, head, condition: node.condition, inStep: !!step || !!by, ...(rounds ? { rounds } : {}) });
    if (check.level === 2) node.condition = '';
    return judged;
  }

  /** The MAX of an IF/UNTIL head judged where it stands (src/check.ts maxIssue): `bounded` when someone other than the agent ends the loop. */
  private roundsIssue(kind: CheckKind, condition: string, t: Token & { kind: 'keyword' }, bounded: boolean, split: { max?: number; bad?: string }): void {
    const head = `${kind}${'!'.repeat(Math.max(t.level ?? 0, 0))}${executorMark(t.executor ?? 0)}`;
    const message = maxIssue(kind, head, bounded, split);
    if (message) this.checkIssues.push({ path: this.sourcePath, name: condition, line: this.fileLine(t), message });
  }

  /**
   * The checked conditions this agent answers for, into `meta.checks`: each
   * reads at least one variable the agent sees — the judge decides on the
   * state they hold — and its question is built now, from the source: a
   * constant's value written in, a shaped read's template fields as guidance.
   */
  private checkSpecs(doc: ApDocument, constants: Record<string, string>): void {
    const visible = new Set(doc.byKind('var').map(b => b.name));
    const isConstant = (name: string) => constantOf(constants, name) !== undefined;
    const fields = (template: string) => doc.templateNamed(template)?.slots
      ?.map(slot => ({ name: slot.name, ...(slot.description ? { description: slot.description } : {}) })) ?? null;
    const checks: Record<string, ApCheckSpec> = {};
    for (const site of this.checkSites) {
      const issue = (message: string) => { this.checkIssues.push({ path: site.path, name: site.condition, line: site.line, message }); };
      const { head } = site;
      const vars = checkedVars(site.condition, isConstant);
      const unseen = vars.filter(v => !visible.has(v));
      // A step's reads are checked here: a flow file's reads are no other check's.
      if (site.inStep) for (const v of unseen) issue(`${head}: \`{{${v}}}\` is no variable the agent it is delegated to sees — export it as a SESSION VAR and IMPORT it in that agent`);
      if (unseen.length === 0 && vars.length === 0) {
        issue(`${head}: a checked condition reads at least one variable — \`{{name}}\`: the judge decides on the state the variables hold, never on the agent's word`);
      }
      checks[site.id] = { kind: site.kind, level: site.level, question: questionOf(site.condition, name => constantOf(constants, name), fields), vars, ...(site.rounds ? { rounds: site.rounds } : {}) };
    }
    if (Object.keys(checks).length > 0) doc.meta.checks = checks;
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
          const into = splitInto(raw.trim());
          const name = into ? into.text : raw.trim();
          const node = this.at(new RunNode(this.ref(this.runnables.get(name), name, 'procedure'), indent), tokens[i + k]);
          if (into) {
            node.into = VarBlock.ref(into.name);
            this.varWrites.push({ name: into.name, node, path: this.sourcePath });
          }
          sink.push(node);
        });
      } else if (base === 'VAR') {
        for (let k = i; k < j; k++) this.variable(tokens[k] as Token & { kind: 'keyword' }, [], sink, host, steps);
      } else if (base === 'AS') {
        this.applyShape(force ?? 0, actions[0] ?? '', sink, host, steps);
      } else if (base === 'LENS-IN' && host?.kind === 'procedure') {
        // A procedure's input contract.
        host.lensIn = { force: 0, ref: this.templateRef(stripColon(actions[0] ?? '')) };
      } else if (enumPrimitiveFor(keyword)) {
        for (const raw of actions) this.applyEnum(keyword, raw.trim());
      } else if (getIntroByKeyword(keyword) !== null || BULLET_KEYWORDS.has(keyword)) {
        // Plain grouped lines: text travels VERBATIM (a trailing colon may be
        // legitimate prose); the source indent is presentation, recorded apart.
        actions.forEach((a, k) => sink.push(this.at(this.directive(base, force, a, indent, tokens[i + k], host), tokens[i + k])));
      } else {
        // Unclaimed keyword lines pass through verbatim (the legacy raw path).
        for (let k = i; k < j; k++) this.pushText(sink, tokens[k]);
      }
      i = j;
    }
  }

  /**
   * A plain line — an action ending in `INTO <name>` records the variable its
   * result fills; a delegation (src/delegation.ts) who it is handed to, the
   * shape of what it is handed, whether it runs in the background — and, in
   * a flow, the perimeter it is handed under.
   */
  private directive(base: string, force: number | null, text: string, indent: number, token?: Token, host?: ApBlock | null): DirectiveNode {
    if (base === MARK_VERB) return this.mark(force, text, indent, token);
    if (isDelegationVerb(base)) {
      const d = parseDelegation(base, text);
      const node = new DirectiveNode(base, force, d.task, indent);
      // In a flow, BY names a member, a role bound to one, or a team — resolved as the flow's own reference, which it uses.
      // `BY <harness>:<agent>`: an agent of the project as another harness runs it — no member, role or team of this one (D66).
      const other = d.by ? splitHarness(d.by) : null;
      if (other) {
        node.harness = other.harness;
        node.by = other.agent;
      } else if (d.by && host?.kind === 'flow') {
        const ref = this.byRef(d.by);
        node.by = refName(ref);
        node.uses = [ref];
      } else if (d.by) node.by = d.by;
      if (d.as) node.as = { force: d.as.force, ref: this.templateRef(d.as.name) };
      if (token?.kind === 'keyword' && token.async) node.async = true;
      // `DELEGATE <list> BY <agent>`: the contracts a MARK of this flow filled the list with.
      const list = host?.kind === 'flow' && base === 'DELEGATE' ? contractListOf(d.task) : null;
      if (list && this.markedLists.has(list)) node.list = list;
      else if (list) this.bareDelegations.push({ name: list, path: this.sourcePath, line: token ? this.fileLine(token) : null });
      if (d.into) {
        node.into = VarBlock.ref(d.into);
        this.varWrites.push({ name: d.into, node, path: this.sourcePath });
        if (this.eachDepth > 0) this.eachInto.push({ name: d.into, node, path: this.sourcePath });
      }
      if (d.by && !other) this.delegationScopes.push({ by: d.by, scope: this.scope, path: this.sourcePath, line: token ? this.fileLine(token) : null });
      return node;
    }
    const into = takesInto(base) ? splitInto(text) : null;
    const node = new DirectiveNode(base, force, into ? into.text : text, indent);
    if (into) {
      node.into = VarBlock.ref(into.name);
      this.varWrites.push({ name: into.name, node, path: this.sourcePath });
    }
    return node;
  }

  /**
   * `MARK <criterion> INTO <list> AS <spec> [MAX <n>] [WITHIN <domain>]` — the
   * list is a declared variable like any INTO's (D63); the spec a template;
   * the domain one that exists and, under an `@WITHIN`, stays inside it (D32).
   * Its form is the lint's.
   */
  private mark(force: number | null, text: string, indent: number, token?: Token): DirectiveNode {
    const m = parseMark(text);
    const node = new DirectiveNode(MARK_VERB, force, text, indent);
    if (m.spec) node.as = { force: 0, ref: this.templateRef(m.spec) };
    if (m.max) node.max = m.max;
    if (m.into) {
      node.into = VarBlock.ref(m.into);
      this.varWrites.push({ name: m.into, node, path: this.sourcePath });
      this.markedLists.add(m.into);
    }
    if (m.within) {
      node.within = m.within;
      const line = token ? this.fileLine(token) : null;
      const known = this.ctx ? lookupIn(this.ctx)('domain').some(d => d.name === m.within) : true;
      const enclosing = this.scope.get('WITHIN');
      if (!known) this.decoratorProblems.push({ path: this.sourcePath, line, message: `MARK … WITHIN ${m.within}: no imported domain is called \`${m.within}\` — IMPORT it, or declare it here` });
      else if (enclosing && !enclosing.some(u => u.name === m.within)) {
        this.decoratorProblems.push({ path: this.sourcePath, line, message: `MARK … WITHIN ${m.within}: the work here is within ${enclosing.map(u => `\`${u.name}\``).join(', ')} — a contract's domain stays inside it` });
      }
    }
    return node;
  }

  /**
   * A decorator and the work it decorates (src/decorators.ts): one node for
   * every decorator — its sentence, the blocks it names as Refs, the work
   * beneath as its body — walked under the scope it opens. What it names that
   * does not hold is reported with its line; a key no decorator has is the
   * lint's, and its work is walked undecorated.
   */
  private decorate(t: Token & { kind: 'decorator' }, decorated: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    const read = this.ctx ? readDecorator(t, this.ctx) : null;
    if (!read) { this.visit(decorated, sink, host, steps); return; }
    const outside = this.scope.outside(read.spec, read.uses);
    const problems = outside.length ? [...read.problems, escapeMessage(read.spec, outside, this.scope.get(read.spec.key) ?? [])] : read.problems;
    for (const message of problems) this.decoratorProblems.push({ path: this.sourcePath, line: this.fileLine(t), message });
    const refs = read.uses.map(d => this.ref({ kind: d.kind, name: d.name, namespace: this.nsOf(d) }, d.name, d.kind));
    const shape = read.template ? { force: 0, ref: this.templateRef(read.template.name, false) } : null;
    const phrase = decoratorPhrase(read.spec, read.uses.map((d, k) => ({ kind: d.kind, name: d.name, ref: refSuffix(refs[k].id) })),
      shape ? { name: read.template!.name, ref: refSuffix(shape.ref.id) } : undefined);
    const node = this.at(new DirectiveNode(`${DECORATOR_MARK}${read.spec.key}`, null, phrase, t.indent, []), t);
    node.uses = refs;
    if (shape) node.shape = shape;
    for (const d of read.uses) this.decoratorNamed.add(d.name);
    sink.push(node);
    const prior = this.scope;
    this.scope = prior.enter(read.spec, read.uses.map(d => ({ kind: d.kind, name: d.name })));
    this.decoratorTrail.push({ path: this.sourcePath, line: this.fileLine(t), key: read.spec.key, names: (this.scope.get(read.spec.key) ?? []).map(u => u.name) });
    this.visit(decorated, node.body!, host, steps);
    this.scope = prior;
  }

  /**
   * A `VAR` line of a body: it declares a private variable and, with a block
   * beneath (`VAR x:`), assigns it the block's outcome — a node holding that
   * block; a block naming a variable the agent imports only assigns it. A
   * malformed line, a constant or a scope word is the lint's to report.
   */
  private variable(t: Token & { kind: 'keyword' }, children: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    const decl = parseVarLine(t.keyword as string, t.rest);
    if (!decl || 'error' in decl || decl.form === 'constant') return;
    const where = host ? `${host.kind} ${host.name}` : basename(this.sourcePath);
    this.varSites.push({ name: decl.name, scope: decl.scope, type: decl.type, block: decl.block, where, path: this.sourcePath, line: this.fileLine(t), inBody: true });
    if (!decl.block) return;
    const node = this.at(new VarNode(VarBlock.ref(decl.name), t.indent), t);
    sink.push(node);
    this.visit(children, node.body, host, steps);
    this.varWrites.push({ name: decl.name, node, path: this.sourcePath });
  }

  private pushText(sink: ApNode[], token: Token): void {
    const raw = rawOf(token);
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) return;
    // Keep the line as written (indentation included) — it is verbatim text.
    sink.push(this.at(new TextNode(raw.replace(/\s+$/, '')), token));
  }

  private applyShape(force: number, rawName: string, sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    // In a step, the shape of what is handed over is its DELEGATE's `AS` — the lint names the rewrite.
    if (steps.length > 0) return;
    const shape: ApShape = { force, ref: this.templateRef(stripColon(rawName)) };
    // Written in a WHEN's body: the shape of that trigger's answer, never the host's.
    if (this.when?.bodies.includes(sink)) { this.when.node.shape = shape; return; }
    if (host) {
      host.shape = shape;
      // Source position of the AS line, when it sits directly in the host body.
      host.shapePos = sink === host.body ? host.body.length : null;
    }
  }

  /** A stray enum line (`BUDGET` outside an agent's head): validated, nothing more. */
  private applyEnum(keyword: string, value: string): void {
    const prim = enumPrimitiveFor(keyword);
    if (prim) validateEnumValue(prim, value, this.ctx ?? undefined);
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

  private ref(entry: IndexedBlock | undefined, rawName: string, expectedKind: string, report = true): ApRef {
    if (!entry) {
      if (report && !this.unresolved.some(u => u.path === this.sourcePath && u.name === rawName)) {
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

  /** A template by name; `report` false leaves an unknown one unresolved without an error. */
  templateRef(name: string, report = true): ApRef {
    return this.ref(this.templates.get(name), name, 'template', report);
  }

  /** A flow delegation's BY: an agent, a role bound to one — or a team, which takes the work by its own routing. */
  private byRef(name: string): ApRef {
    const agent = (this.roles && resolveRole(this.roles, name)?.name) ?? name;
    const team = this.agents.has(agent) ? undefined : this.projectTeams.find(t => t === name);
    if (team) return this.ref({ kind: 'team', name: team, namespace: TeamBlock.NAMESPACE }, name, 'team');
    return this.ref(this.agents.get(agent), agent, 'agent');
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
    return {
      name: def.name,
      namespace: this.nsOf(def),
      about: def.about,
      tags: def.tags.map(t => t.replace(/^#/, '')),
      scopes: def.scopes,
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
      ? stripPrimitives(body, 'ABOUT', 'APPLIES', 'EXPERTISE')
      : stripPrimitives(body, 'APPLIES', 'EXPERTISE');
  }

  // ---------------------------------------------------------- index (pass 1)

  private indexDefinition(def: Definition): void {
    const ref = strategyOf(def.kind)?.ref;
    if (!ref) return;
    this.refIndex(ref).set(def.name, { kind: def.kind, name: def.name, namespace: this.nsOf(def) });
  }

  /**
   * Index the `IMPORT a, b FROM @ns` declarations of a source that never
   * reaches the agent's BundleContext (a team's file, the log recipe).
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
      for (const name of splitList(m[1])) {
        this.refIndex(ref).set(name, { kind, name, namespace: ns });
      }
    }
  }

  /** Read the agent's team ONCE: its file, the blocks of its TEAM block, its flow slices. */
  private scanTeam(agentFilePath: string): TeamScan | null {
    const root = teamRootForAgentFile(agentFilePath);
    if (!root) return null;
    const sources = this.ctx!.sources;
    const file = readTeamFile(root, sources);
    if (!file) return null;
    const written = file.block.children.filter((c): c is Block => c.type === 'block');
    // A FLOW's body runs from the line after its header to its next sibling in
    // the TEAM block (a WHEN can sit between two FLOWs), de-indented by the
    // block's indent — the text a flow file would hold.
    const flows: TeamScan['flows'] = written
      .filter(b => b.key === 'FLOW' && b.name !== null)
      .map(b => ({ name: b.name!, block: b, body: sources.nestedSpan(file.path, file.block, b).lines.slice(1).map(l => l.text.slice(file.childIndent)).join('\n') }));
    return { root, name: file.name, file, members: file.members.map(m => m.name), blocks: written, flows };
  }

  private buildRefIndex(ctx: BundleContext, opts: RecorderFinishOpts): void {
    for (const strategy of KIND_STRATEGIES) {
      for (const def of strategy.entries?.(ctx, opts) ?? []) this.indexDefinition(def);
    }
    this.agents.set(ctx.agentName, { kind: 'agent', name: ctx.agentName, namespace: AgentBlock.NAMESPACE });

    if (this.team) {
      const members = readTeamMembers(this.team.root);
      for (const member of members) {
        this.agents.set(member.name, { kind: 'agent', name: member.name, namespace: AgentBlock.NAMESPACE });
      }
      // The same role index the orchestration resolves `BY <role>` with: the team's inline blocks and its members' bindings.
      this.roles = buildRoleIndex({ blocks: this.team.blocks, anchor: 'directory' },
        { bindings: members.filter(m => m.roles.length > 0).map(m => ({ name: m.name, roles: m.roles })), anchor: 'directory' });
      this.indexImportLines(this.team.file.source);
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
        const block = this.fromSource(ctx.sources.span(def.path, def.kind, def.name, ctx.agentName), () => from(def, this));
        out.push(block);
      }
    }
    return out;
  }

  /** The team block (built by its class from the scan) + its flow blocks. */
  private teamBlocks(): ApBlock[] {
    if (!this.team) return [];
    const team = this.team;
    const sources = this.ctx!.sources;
    const path = team.file.path;
    this.sourcePath = path;
    const flowsNs = TeamBlock.flowsNamespace(team.name);
    // The decorators above the team decorate its work — its flows, each inside them, then in its own.
    const around = team.file.block.decorators ?? [];
    return [
      ...team.flows.map(f => {
        const span = f.block ? sources.nestedSpan(path, team.file.block, f.block) : null;
        return this.fromSource(span, () => RuleBlock.fromBody('flow', { name: f.name, namespace: flowsNs }, f.body, this), [...around, ...(span?.decorators ?? [])]);
      }),
      // The team is its EXPORT TEAM block.
      this.fromSource(sources.blockSpan(path, team.file.block), () => TeamBlock.fromScan(team, this), []),
    ];
  }

  /** The agent root block — built by its class from the pipeline's state. */
  private agentBlock(ctx: BundleContext, opts: RecorderFinishOpts): ApBlock {
    this.sourcePath = opts.agentFilePath;
    return this.fromSource(opts.agentSpan, () => AgentBlock.fromContext({ agentName: ctx.agentName, ...opts }, this));
  }

  // -------------------------------------------------------------- variables

  /**
   * The variables — one block each — from every declaration: the imported
   * ones and the bodies'. Each name is declared once, in one scope — no
   * private variable shadows a SESSION one; a body's `VAR x:` naming a variable
   * the agent imports assigns it, never redeclares it. A variable is assigned
   * only when declared (a constant takes no value at run time), and keeps one
   * type: its declared template, or the result type of the block that yields
   * one — a `RUN` of a procedure with an `AS`. Every step that fills a typed
   * variable is shaped by its template.
   */
  private variableBlocks(doc: ApDocument, opts: RecorderFinishOpts): ApBlock[] {
    const fail = (path: string, name: string, line: number | null, message: string) => this.varErrors.push({ path, name, line, message });
    const table = new Map<string, VarSite>();
    const sites: VarSite[] = [...opts.declaredVars.map(v => ({ ...v, block: false, path: v.file, inBody: false })), ...this.varSites];
    for (const site of sites) {
      const first = table.get(site.name);
      if (constantOf(opts.vars, site.name) !== undefined) {
        fail(site.path, site.name, site.line, `\`${site.name}\` is already a constant — a variable needs a name of its own`);
      } else if (!first) {
        table.set(site.name, site);
      } else if (first.inBody || !site.block || site.type) {
        // A body's plain `VAR x:` assigns what the agent imports; anything else declares again.
        fail(site.path, site.name, site.line, first.scope !== site.scope
          ? `\`${site.name}\` is already a ${first.scope === 'session' ? 'SESSION' : 'private'} variable (${first.where}) — no variable of another scope takes its name; assign it with \`VAR ${site.name}:\` or \`DO … INTO ${site.name}\``
          : `variable \`${site.name}\` is declared twice — first in ${first.where}; assign it with \`VAR ${site.name}:\` or \`DO … INTO ${site.name}\`, never redeclare it`);
      }
    }
    for (const w of this.varWrites) {
      if (table.has(w.name)) continue;
      fail(w.path, w.name, w.node.pos?.line ?? null, constantOf(opts.vars, w.name) !== undefined
        ? `INTO ${w.name}: \`${w.name}\` is a constant — only a variable takes a value while the agent works`
        : `INTO ${w.name}: no variable \`${w.name}\` — declare it with \`VAR ${w.name}\` in the agent's body, or IMPORT the module that exports it`);
    }
    const types = new Map<string, ApRef | null>();
    const blocks = [...table.values()].map(site => {
      const writes = this.varWrites.filter(w => w.name === site.name);
      this.sourcePath = site.path;
      // A shared declaration nobody here fills needs no template here; one this agent fills, or declares, does.
      let type = site.type ? this.templateRef(site.type, site.inBody || writes.length > 0) : null;
      for (const w of writes) {
        if (w.node.type === 'directive') continue;
        const line = w.node.pos?.line ?? null;
        const yielded = this.yieldOf(w.node.type === 'var' ? w.node.body : [w.node], doc, (a, b) =>
          fail(w.path, site.name, line, `\`${site.name}\`: the IF and ELSE branches yield different types — \`${refName(a)}\` and \`${refName(b)}\``));
        if (!yielded) continue;
        if (!type) type = yielded;
        else if (yielded.target !== type.target) {
          fail(w.path, site.name, line, `\`${site.name}\` is a \`${refName(type)}\`, but this ${w.node.type === 'var' ? 'block' : 'procedure'} yields a \`${refName(yielded)}\` — a variable keeps one type for its whole life`);
        }
      }
      // A run of an EACH answers one element, not the list its INTO collects.
      if (type) for (const w of writes) if (!this.eachInto.some(e => e.node === w.node)) w.node.shape = { force: 1, ref: type };
      types.set(site.name, type);
      return VarBlock.fromDeclaration(site.name, site.scope, type, site.where);
    });
    // `EACH … IN {{<list>}}`: the list is a variable whose template holds one LIST slot — the elements.
    const oneList = (type: ApRef) => (doc.slotsOf(type) ?? []).filter(s => s.spec.kind === 'list').length;
    for (const { name, node, path } of this.eachLists) {
      const at = (message: string) => fail(path, name, node.pos?.line ?? null, `EACH ${node.each.item} IN {{${name}}}: ${message}`);
      const type = types.get(name);
      if (type === undefined) at(`no variable \`${name}\` — IMPORT the module that exports it, or declare it with \`VAR ${name} AS <template>\``);
      else if (!type) at(`\`${name}\` has no type — declare it \`AS <template>\`, a template with one LIST slot`);
      else if (oneList(type) !== 1) at(`\`${refName(type)}\` has ${oneList(type)} LIST slots — the list to run over is its one LIST slot`);
    }
    // An INTO inside an EACH collects one result per run: a plain variable, or a template with one LIST slot.
    for (const { name, node, path } of this.eachInto) {
      const type = types.get(name);
      if (type && oneList(type) !== 1) {
        fail(path, name, node.pos?.line ?? null, `INTO ${name} inside EACH collects one result per run — \`${refName(type)}\` has ${oneList(type)} LIST slots: declare \`${name}\` with no type, or with a template of one LIST slot`);
      }
    }
    return blocks;
  }

  /**
   * The type a block of lines yields — its final outcome's: the result template
   * of a procedure its last line runs, through the last line of an IF/ELSE
   * (each branch, which must agree), an UNTIL or an IN. Null when untyped.
   */
  private yieldOf(nodes: ApNode[], doc: ApDocument, conflict: (a: ApRef, b: ApRef) => void): ApRef | null {
    const last = nodes[nodes.length - 1];
    switch (last?.type) {
      case 'run': return doc.resolve(last.ref)?.shape?.ref ?? null;
      case 'if': {
        const a = this.yieldOf(last.then, doc, conflict);
        const b = this.yieldOf(last.else, doc, conflict);
        if (a && b && a.target !== b.target) conflict(a, b);
        return a ?? b;
      }
      case 'until':
      case 'in': return this.yieldOf(last.body, doc, conflict);
      default: return null;
    }
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

    const flowRun = ctx.renderings?.FLOW?.run;
    const phrases = delegationPhrases(ctx.renderings);
    return {
      root: `${AgentBlock.NAMESPACE}/${ctx.agentName}`,
      forceLevels,
      enums,
      ...(flowRun ? { flowRun } : {}),
      ...(phrases ? { phrases } : {}),
      ...(ctx.sessionEnv ? { sessionEnv: ctx.sessionEnv } : {}),
    };
  }

  /**
   * The md-projection metadata, SERIALIZED into meta.md — everything a
   * decompiler needs beyond the blocks: bootstrap prose (RAW-clean), the
   * chapter intros (pre-rendered, and ONLY for chapters this document
   * actually has — anything else is wasted bytes), substitution vars,
   * presentation positions.
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
      const text = renderedIntro(kind) || (pluginOf(kind)?.about ?? '');
      if (text) intros[kind] = text;
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
      agentBodyLead: (/^\n*/.exec(opts.agentBody)?.[0].length ?? 0) || 1,
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
    this.projectTeams = opts.teams ?? [];
    this.team = this.scanTeam(opts.agentFilePath);
    this.buildRefIndex(ctx, opts);

    const doc = new ApDocument(this.buildMeta(ctx));
    const producers: [BlockProvenance, () => ApBlock[]][] = [
      ['definition', () => this.definitionBlocks(ctx, opts)],
      ['team',       () => this.teamBlocks()],
      ['agent',      () => [this.agentBlock(ctx, opts)]],
      // Last: a variable's type may come from any procedure the others hold.
      ['definition', () => this.variableBlocks(doc, opts)],
    ];
    const provenanceMap: Record<string, string> = {};
    for (const [provenance, produce] of producers) {
      for (const block of produce()) {
        doc.add(block, provenance);
        provenanceMap[block.address] = provenance;
      }
    }
    this.checkSpecs(doc, opts.vars);
    // A DELEGATE of a variable hands out contracts only when a MARK above it filled that variable.
    const variables = new Set(doc.byKind('var').map(b => b.name));
    for (const d of this.bareDelegations.filter(d => variables.has(d.name))) {
      this.varErrors.push({ path: d.path, name: d.name, line: d.line, message: `DELEGATE ${d.name}: \`${d.name}\` is a variable no MARK above it fills — a DELEGATE of a variable hands out the contracts a MARK made; MARK it first, or say the task in words` });
    }
    const executors = executorSpecs(doc, opts.vars ?? {}, this.ctx!.agentName, name => templateClosure(name, this.ctx?.templates ?? []));
    if (Object.keys(executors).length > 0) doc.meta.executors = executors;
    // What the flows start in the background: an id for each, and on each WAIT the ids it takes back.
    // And what their MARKs bind: an id for each, the list it fills, its spec, its limit and its domain.
    const marks: Record<string, ApMark> = {};
    const markOf = (node: { text?: string; as?: ApShape; max?: number; within?: string }, step: string, flow: string): ApMark | null => {
      const m = parseMark(node.text ?? '');
      return m.into && node.as ? { flow, step, list: m.into, spec: refName(node.as.ref), max: node.max ?? 0, within: node.within ?? null } : null;
    };
    // The agent's own body too: a delegation to another harness there is a piece of the registry (D66).
    const root = doc.root();
    const bodies = [...doc.byKind('flow'), ...(root ? [root] : [])];
    const background = Object.assign({}, ...bodies.map(f => bindBackgroundWork(f as unknown as { address: string; name: string; body: unknown[] },
      (text, prefix) => shortId(prefix, text), marks, (node, step) => markOf(node, step, f.name))));
    if (Object.keys(background).length > 0) doc.meta.background = background;
    if (Object.keys(marks).length > 0) doc.meta.marks = marks;
    const used = Object.fromEntries(plugins().filter(p => doc.byKind(p.name).length > 0).map(p => [p.name, p]));
    if (Object.keys(used).length > 0) doc.meta.plugins = used;
    doc.seal();
    const md = this.buildMdMeta(doc, opts, provenanceMap);
    doc.attachMdSource(md);
    const stores: Record<string, ApStoreProjection> = {};
    for (const block of doc.byKind('store')) stores[block.address] = (block as StoreBlock).projection(ctx.agentName, apxCommand(ctx.agentName));
    if (Object.keys(stores).length > 0) md.stores = stores;
    return doc;
  }
}

/** A definition's body nested in the decorators above it, outermost first — each opening the block the next one, then the body, stands in. */
function wrapped(decorators: readonly DecoratorLine[], body: string): string {
  const pad = (n: number) => '    '.repeat(n);
  const heads = decorators.map((d, k) => `${pad(k)}${DECORATOR_MARK}${d.key}${d.rest ? ` ${d.rest}` : ''}:`);
  return [...heads, ...body.split(/\r?\n/).map(l => (l.trim() ? `${pad(decorators.length)}${l}` : l))].join('\n');
}
