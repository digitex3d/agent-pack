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
import { basename, dirname } from 'node:path';
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
import { align, positionOf, type SourceSpan, type SourceRegistry } from '../sources.js';
import { readMainFile } from '../services/mainMetadata.js';
import { apxCommand } from '../apx/paths.js';
import type { StoreBlock } from './blocks.js';
import { renderTree } from '../bundlers/renderTree.js';
import { ENUM_PRIMITIVES, FORCE_LEVEL_PRIMITIVES, enumPrimitiveFor } from '../primitives.js';
import { validateEnumValue } from '../enumPrimitives.js';
import {
  readTeamFile,
  teamRootForAgentFile,
  findAgentFiles,
  agentNameOf,
  readAgentFile,
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
function stripColon(text: string): string {
  return stripTrailingColon(text).trim();
}
import type { ApBlock, ApBlockInit } from './block.js';
import {
  type BlockCx, RuleBlock, TeamBlock, MainBlock, AgentBlock, VarBlock,type TeamScan, KIND_STRATEGIES, strategyOf, kindOfFolder, refId, namespaceOf, type RefClass,
} from './blocks.js';
import { ApDocument, type BlockProvenance } from './document.js';
import { COMPUTE_SECTIONS, executorMark, executorSpecs, returnShape } from '../executor.js';
import { DirectiveNode, RunNode, TextNode, IfNode, UntilNode, WhenNode, StepNode, EachNode, InNode, VarNode } from './nodes.js';
import { splitList } from '../lists.js';
import { parseTemplate, type Slot } from '../shapeCompiler.js';


/** Bullet-group keywords (DO, BY, WHEN, LOG, …) that group like force levels. */
const BULLET_KEYWORDS = new Set(FORCE_LEVEL_PRIMITIVES.map(primitive => primitive.keyword));

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
  /**
   * What the compilation is the document of: an agent — the default — or a
   * unit, whose root is its TEAM or MAIN block and which holds its flows, and no agent.
   */
  unit?: 'team' | 'main';
  /** The main's: the files of the standalone agents it holds, in MEMBER order. */
  memberFiles?: string[];
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
  /** The document is a unit's — a team's: its flows, and every checked condition in them, are its own. */
  private ownsFlows = false;

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
    decorators.forEach((decorator, index) => { if (this.bodyLines) this.bodyLines[index] = decorator.line; });
    this.visit(buildTree(lex(text)), sink, host ?? null, []);
    this.bodyLines = null;
  }

  /** Stamp where a node was written: the file line its body line came from. */
  private at<T extends ApNode>(node: T, token: Token): T {
    const line = this.fileLine(token);
    if (line !== null) node.pos = positionOf(this.span!, line);
    return node;
  }

  /** The file line a body token came from — null when the block has no positions. */
  private fileLine(token: Token): number | null {
    return this.span && this.bodyLines ? this.bodyLines[token.line - 1] ?? this.span.line : null;
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
    for (const decorator of this.definitionDecorators ?? []) this.decoratorProblems.push({ path: this.sourcePath, line: decorator.line, message: workless(decorator.key, block.kind.toUpperCase()) });
    this.definitionDecorators = null;
    if (this.span) block.source = { file: this.span.file, line: this.span.line, col: positionOf(this.span, this.span.line).col };
    this.span = null;
    return block;
  }

  private visit(nodes: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    let index = 0;
    while (index < nodes.length) {
      const walkNode = nodes[index];
      const token = walkNode.token;

      // Maximal run of non-structural leaves — grouped exactly like the flat pass.
      if (!isStructural(token, walkNode.children.length > 0)) {
        const run: Token[] = [];
        while (index < nodes.length && !isStructural(nodes[index].token, nodes[index].children.length > 0)) {
          run.push(nodes[index].token);
          index++;
        }
        this.leafRun(run, sink, host, steps);
        continue;
      }

      // A COMPUTE block's sections: REQUIRE and ENSURE land on the block, RETURN AS <template>
      // is its result's shape and its body the computation (src/executor.ts).
      if (token.kind === 'blockOpener' && host && (COMPUTE_SECTIONS as readonly string[]).includes(token.key)) {
        if (token.key === 'RETURN') {
          const as = returnShape(token.rest);
          if (as) host.shape = { force: 0, ref: this.templateRef(as) };
          // Where RETURN starts — the AS line renders there, and the computation after it.
          host.shapePos = sink === host.body ? host.body.length : null;
          this.visit(walkNode.children, sink, host, steps);
        } else {
          this.visit(walkNode.children, token.key === 'REQUIRE' ? (host.require ??= []) : (host.ensure ??= []), host, steps);
        }
        index++;
        continue;
      }

      // A decorator: opening a block, it decorates its own lines; above one, the block that
      // follows — through any decorators stacked between them.
      if (token.kind === 'decorator') {
        let end = index;
        if (!token.opens) {
          end = index + 1;
          while (end < nodes.length && (nodes[end].token.kind === 'blank' || (nodes[end].token.kind === 'decorator' && !(nodes[end].token as { opens: boolean }).opens))) end++;
        }
        this.decorate(token, token.opens ? walkNode.children : nodes.slice(index + 1, end + 1), sink, host, steps);
        index = token.opens ? index + 1 : end + 1;
        continue;
      }

      if (token.kind !== 'keyword') {
        // Prose (or unknown token) with an indented body: verbatim head, children flattened.
        this.pushText(sink, token);
        this.visit(walkNode.children, sink, host, steps);
        index++;
        continue;
      }

      const kw = token.keyword as string;

      // Sequence block (STEP): consecutive siblings, each a label over the lines whoever runs the flow carries out.
      if (sequencePrimitiveFor(kw)) {
        while (index < nodes.length) {
          const item = nodes[index];
          if (item.token.kind !== 'keyword' || (item.token.keyword as string) !== kw) break;
          const step = this.at(new StepNode(stripColon(restOf(item.token))), item.token);
          sink.push(step);
          this.visit(item.children, step.body, host, [...steps, step]);
          index++;
        }
        continue;
      }

      // `IN <store>:` — the steps beneath work in that store. The name resolves
      // to a Ref against the declared stores, so an unknown one is caught here
      // rather than reading as prose.
      if (kw === 'IN') {
        const name = stripTrailingColon(token.rest).trim();
        const node = this.at(new InNode(this.storeRef(name), token.indent), token);
        sink.push(node);
        this.visit(walkNode.children, node.body, host, steps);
        index++;
        continue;
      }

      if (kw === 'EACH') {
        // `EACH <item> IN {{<list>}} MAX <n>:` — a malformed head is the lint's to report; a DIMENSION's EACH line is no block.
        const each = eachHeadOf(token.rest);
        if (each) {
          const node = this.at(new EachNode({ item: each.item, list: VarBlock.ref(each.list), max: each.max }, token.indent), token);
          this.eachLists.push({ name: each.list, node, path: this.sourcePath });
          sink.push(node);
          this.eachDepth++;
          this.visit(walkNode.children, node.body, host, steps);
          this.eachDepth--;
          index++;
          continue;
        }
      }

      if (kw === 'IF') {
        const split = splitMax(stripTrailingColon(token.rest));
        const node = this.at(new IfNode(split.condition, token.indent), token);
        const bounded = this.executed('IF', node, token, host) || this.checked('IF', node, token, host, steps);
        this.roundsIssue('IF', node.condition, token, bounded, split);
        sink.push(node);
        // The IF! a `WHEN!` was desugared into: its lines are the trigger's.
        if (token === this.sugared?.token) this.when?.bodies.push(node.then);
        this.visit(walkNode.children, node.then, host, steps);
        index++;
        continue;
      }
      if (kw === 'ELSE') {
        // ELSE is the second branch of the preceding IF, not a node of its own.
        const prior = [...sink].reverse().find((candidate): candidate is ApIfNode => candidate.type === 'if');
        this.visit(walkNode.children, prior ? prior.else : sink, host, steps);
        index++;
        continue;
      }
      if (kw === 'UNTIL') {
        const split = splitMax(stripTrailingColon(token.rest));
        const node = this.at(new UntilNode(split.condition, token.indent, split.max), token);
        const bounded = this.executed('UNTIL', node, token, host) || this.checked('UNTIL', node, token, host, steps);
        this.roundsIssue('UNTIL', node.condition, token, bounded, split);
        sink.push(node);
        this.visit(walkNode.children, node.body, host, steps);
        index++;
        continue;
      }
      if (kw === 'VAR') {
        this.variable(token, walkNode.children, sink, host, steps);
        index++;
        continue;
      }

      // Bodied leaf keyword head (e.g. `WHEN <trigger>:`): open its container.
      const { base, force } = parseForce(kw);
      const rest = stripColon(token.rest);
      // `MEM <event>` with an `AS <template>` line beneath: the memory's shape.
      if (base === 'MEM') {
        const node = this.at(new DirectiveNode(base, force, rest, token.indent), token);
        for (const child of walkNode.children) {
          if (child.token.kind !== 'keyword') continue;
          const as = parseForce(child.token.keyword as string);
          if (as.base === 'AS') node.shape = { force: as.force ?? 0, ref: this.templateRef(stripColon(child.token.rest)) };
        }
        sink.push(node);
        index++;
        continue;
      }
      if (base === 'WHEN') {
        const node = this.at(new WhenNode(rest, token.indent), token);
        sink.push(node);
        const first = walkNode.children.find(child => child.token.kind !== 'blank')?.token;
        const prior = this.sugared;
        const priorWhen = this.when;
        const head = first?.kind === 'keyword' && first.keyword === 'IF'
          ? sugaredHead({ keyword: 'WHEN', condition: rest }, true, first.level ?? 0, stripTrailingColon(first.rest)) : null;
        this.sugared = head && first ? { token: first, head } : null;
        this.when = { node, bodies: [node.body] };
        this.visit(walkNode.children, node.body, host, steps);
        this.sugared = prior;
        this.when = priorWhen;
      } else if (isDelegationVerb(base)) {
        // `DELEGATE … BY x:` — its DO lines are what the one it goes to is told; a checked condition among them is its.
        const node = this.at(this.directive(base, force, token.rest, token.indent, token, host), token);
        node.body = [];
        sink.push(node);
        const prior = this.delegatedTo;
        this.delegatedTo = node.by ?? null;
        this.visit(walkNode.children, node.body, host, steps);
        this.delegatedTo = prior;
      } else {
        const node = this.at(new DirectiveNode(base, force, rest, token.indent, []), token);
        sink.push(node);
        this.visit(walkNode.children, node.body!, host, steps);
      }
      index++;
    }
  }

  /**
   * An `IF*`/`IF**`/`UNTIL*`/`UNTIL**` head: a delegate or a program decides the
   * condition, which reads at least one variable — its only input. A star with a
   * `!` is the vocabulary check's error: the head is never also checked.
   */
  private executed(kind: CheckKind, node: IfNode | UntilNode, token: Token & { kind: 'keyword' }, host: ApBlock | null): boolean {
    // Unmarked inside a PROCEDURE* / PROCEDURE**, the condition is its executor's too (src/executor.ts).
    const executor = token.executor ?? ((token.level ?? 0) === 0 ? host?.executor ?? 0 : 0);
    if (!executor) return false;
    node.executor = executor;
    if (readsOf(node.condition).length === 0) {
      this.checkIssues.push({ path: this.sourcePath, name: node.condition, line: this.fileLine(token),
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
  private checked(kind: CheckKind, node: IfNode | UntilNode, token: Token & { kind: 'keyword' }, host: ApBlock | null, steps: ApStepNode[]): boolean {
    const judged = (token.level ?? 0) > 0;
    // Inside a PROCEDURE* / PROCEDURE** its executor decides the conditions: a judge cannot stand there.
    if (host?.executor && judged) {
      this.checkIssues.push({ path: this.sourcePath, name: node.condition, line: this.fileLine(token),
        message: `${kind}${'!'.repeat(token.level!)} is not allowed under PROCEDURE${executorMark(host.executor)} \`${host.name}\` — its executor decides its conditions: write ${kind} or ${kind}${executorMark(host.executor)}` });
      return judged;
    }
    // In a flow, the one a DELEGATE block goes to checks the conditions among its lines; whoever runs the flow checks none yet.
    const step = steps[steps.length - 1];
    const by = this.delegatedTo;
    // A role names the member bound to it, as AGENTS.md resolves it.
    const agent = by ? (this.roles && resolveRole(this.roles, by)?.name) ?? by : null;
    const site: CheckSite = agent && host?.kind === 'flow' ? { at: 'step', agent: this.agents.has(agent) ? agent : null }
      : host?.kind === 'flow' ? { at: 'flow' } : { at: 'agent', agent: this.ctx!.agentName };
    const head = token === this.sugared?.token ? this.sugared.head : checkedKeyword(kind, token.level ?? 0);
    const rounds = node.type === 'until' ? node.max : undefined;
    const { check, issue } = condCheckOf(kind, token.level ?? 0, node.condition, site, this.ctx?.checks, head, rounds);
    const at = { path: this.sourcePath, name: node.condition, line: this.fileLine(token) };
    if (issue) this.checkIssues.push({ ...at, ...issue });
    if (!check) return judged;
    node.check = check;
    // An agent answers for its own body's conditions; a unit's document holds every condition of its flows.
    if (this.ownsFlows || check.agent === this.ctx?.agentName) this.checkSites.push({ ...at, id: check.id, kind, level: check.level, head, condition: node.condition, inStep: !!step || !!by, ...(rounds ? { rounds } : {}) });
    if (check.level === 2) node.condition = '';
    return judged;
  }

  /** The MAX of an IF/UNTIL head judged where it stands (src/check.ts maxIssue): `bounded` when someone other than the agent ends the loop. */
  private roundsIssue(kind: CheckKind, condition: string, token: Token & { kind: 'keyword' }, bounded: boolean, split: { max?: number; bad?: string }): void {
    const head = `${kind}${'!'.repeat(Math.max(token.level ?? 0, 0))}${executorMark(token.executor ?? 0)}`;
    const message = maxIssue(kind, head, bounded, split);
    if (message) this.checkIssues.push({ path: this.sourcePath, name: condition, line: this.fileLine(token), message });
  }

  /**
   * The checked conditions this agent answers for, into `meta.checks`: each
   * reads at least one variable the agent sees — the judge decides on the
   * state they hold — and its question is built now, from the source: a
   * constant's value written in, a shaped read's template fields as guidance.
   */
  private checkSpecs(doc: ApDocument, constants: Record<string, string>): void {
    const visible = new Set(doc.byKind('var').map(block => block.name));
    const isConstant = (name: string) => constantOf(constants, name) !== undefined;
    const fields = (template: string) => doc.templateNamed(template)?.slots
      ?.map(slot => ({ name: slot.name, ...(slot.description ? { description: slot.description } : {}) })) ?? null;
    const checks: Record<string, ApCheckSpec> = {};
    for (const site of this.checkSites) {
      const issue = (message: string) => { this.checkIssues.push({ path: site.path, name: site.condition, line: site.line, message }); };
      const { head } = site;
      const vars = checkedVars(site.condition, isConstant);
      const unseen = vars.filter(variable => !visible.has(variable));
      // A step's reads are checked here: a flow file's reads are no other check's.
      if (site.inStep) for (const variable of unseen) issue(`${head}: \`{{${variable}}}\` is no variable the team sees — export it as a SESSION VAR and IMPORT it in the team's file`);
      if (unseen.length === 0 && vars.length === 0) {
        issue(`${head}: a checked condition reads at least one variable — \`{{name}}\`: the judge decides on the state the variables hold, never on the agent's word`);
      }
      checks[site.id] = { kind: site.kind, level: site.level, question: questionOf(site.condition, name => constantOf(constants, name), fields), vars, ...(site.rounds ? { rounds: site.rounds } : {}) };
    }
    if (Object.keys(checks).length > 0) doc.meta.checks = checks;
  }

  /** A leaf run: group consecutive same-keyword lines, emit typed nodes. */
  private leafRun(tokens: Token[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.kind !== 'keyword') {
        if (token.kind !== 'blank' && token.kind !== 'comment') this.pushText(sink, token);
        index++;
        continue;
      }
      const keyword = token.keyword as string;
      const indent = token.indent;
      const actions: string[] = [token.rest];
      let end = index + 1;
      while (end < tokens.length) {
        const tt = tokens[end];
        if (tt.kind !== 'keyword' || (tt.keyword as string) !== keyword || tt.indent !== indent) break;
        actions.push(tt.rest);
        end++;
      }

      const { base, force } = parseForce(keyword);
      if (base === 'RUN') {
        // The Ref resolves on the builder's own symbol table.
        actions.forEach((raw, offset) => {
          const into = splitInto(raw.trim());
          const name = into ? into.text : raw.trim();
          const node = this.at(new RunNode(this.ref(this.runnables.get(name), name, 'procedure'), indent), tokens[index + offset]);
          if (into) {
            node.into = VarBlock.ref(into.name);
            this.varWrites.push({ name: into.name, node, path: this.sourcePath });
          }
          sink.push(node);
        });
      } else if (base === 'VAR') {
        for (let position = index; position < end; position++) this.variable(tokens[position] as Token & { kind: 'keyword' }, [], sink, host, steps);
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
        actions.forEach((action, offset) => sink.push(this.at(this.directive(base, force, action, indent, tokens[index + offset], host), tokens[index + offset])));
      } else {
        // Unclaimed keyword lines pass through verbatim (the legacy raw path).
        for (let position = index; position < end; position++) this.pushText(sink, tokens[position]);
      }
      index = end;
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
      const delegation = parseDelegation(base, text);
      const node = new DirectiveNode(base, force, delegation.task, indent);
      // In a flow, BY names a member, a role bound to one, or a team — resolved as the flow's own reference, which it uses.
      // `BY <harness>:<agent>`: an agent of the project as another harness runs it — no member, role or team of this one (D66).
      const other = delegation.by ? splitHarness(delegation.by) : null;
      if (other) {
        node.harness = other.harness;
        node.by = other.agent;
      } else if (delegation.by && host?.kind === 'flow') {
        const ref = this.byRef(delegation.by);
        node.by = refName(ref);
        node.uses = [ref];
      } else if (delegation.by) node.by = delegation.by;
      if (delegation.as) node.as = { force: delegation.as.force, ref: this.templateRef(delegation.as.name) };
      if (token?.kind === 'keyword' && token.async) node.async = true;
      // `DELEGATE <list> BY <agent>`: the contracts a MARK of this flow filled the list with.
      const list = host?.kind === 'flow' && base === 'DELEGATE' ? contractListOf(delegation.task) : null;
      if (list && this.markedLists.has(list)) node.list = list;
      else if (list) this.bareDelegations.push({ name: list, path: this.sourcePath, line: token ? this.fileLine(token) : null });
      if (delegation.into) {
        node.into = VarBlock.ref(delegation.into);
        this.varWrites.push({ name: delegation.into, node, path: this.sourcePath });
        if (this.eachDepth > 0) this.eachInto.push({ name: delegation.into, node, path: this.sourcePath });
      }
      if (delegation.by && !other) this.delegationScopes.push({ by: delegation.by, scope: this.scope, path: this.sourcePath, line: token ? this.fileLine(token) : null });
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
    const parsed = parseMark(text);
    const node = new DirectiveNode(MARK_VERB, force, text, indent);
    if (parsed.spec) node.as = { force: 0, ref: this.templateRef(parsed.spec) };
    if (parsed.max) node.max = parsed.max;
    if (parsed.into) {
      node.into = VarBlock.ref(parsed.into);
      this.varWrites.push({ name: parsed.into, node, path: this.sourcePath });
      this.markedLists.add(parsed.into);
    }
    if (parsed.within) {
      node.within = parsed.within;
      const line = token ? this.fileLine(token) : null;
      const known = this.ctx ? lookupIn(this.ctx)('domain').some(domain => domain.name === parsed.within) : true;
      const enclosing = this.scope.get('WITHIN');
      if (!known) this.decoratorProblems.push({ path: this.sourcePath, line, message: `MARK … WITHIN ${parsed.within}: no imported domain is called \`${parsed.within}\` — IMPORT it, or declare it here` });
      else if (enclosing && !enclosing.some(use => use.name === parsed.within)) {
        this.decoratorProblems.push({ path: this.sourcePath, line, message: `MARK … WITHIN ${parsed.within}: the work here is within ${enclosing.map(use => `\`${use.name}\``).join(', ')} — a contract's domain stays inside it` });
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
  private decorate(token: Token & { kind: 'decorator' }, decorated: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    const read = this.ctx ? readDecorator(token, this.ctx) : null;
    if (!read) { this.visit(decorated, sink, host, steps); return; }
    const outside = this.scope.outside(read.spec, read.uses);
    const problems = outside.length ? [...read.problems, escapeMessage(read.spec, outside, this.scope.get(read.spec.key) ?? [])] : read.problems;
    for (const message of problems) this.decoratorProblems.push({ path: this.sourcePath, line: this.fileLine(token), message });
    const refs = read.uses.map(use => this.ref({ kind: use.kind, name: use.name, namespace: this.nsOf(use) }, use.name, use.kind));
    const shape = read.template ? { force: 0, ref: this.templateRef(read.template.name, false) } : null;
    const phrase = decoratorPhrase(read.spec, read.uses.map((use, index) => ({ kind: use.kind, name: use.name, ref: refSuffix(refs[index].id) })),
      shape ? { name: read.template!.name, ref: refSuffix(shape.ref.id) } : undefined);
    const node = this.at(new DirectiveNode(`${DECORATOR_MARK}${read.spec.key}`, null, phrase, token.indent, []), token);
    node.uses = refs;
    if (shape) node.shape = shape;
    for (const use of read.uses) this.decoratorNamed.add(use.name);
    sink.push(node);
    const prior = this.scope;
    this.scope = prior.enter(read.spec, read.uses.map(use => ({ kind: use.kind, name: use.name })));
    this.decoratorTrail.push({ path: this.sourcePath, line: this.fileLine(token), key: read.spec.key, names: (this.scope.get(read.spec.key) ?? []).map(use => use.name) });
    this.visit(decorated, node.body!, host, steps);
    this.scope = prior;
  }

  /**
   * A `VAR` line of a body: it declares a private variable and, with a block
   * beneath (`VAR x:`), assigns it the block's outcome — a node holding that
   * block; a block naming a variable the agent imports only assigns it. A
   * malformed line, a constant or a scope word is the lint's to report.
   */
  private variable(token: Token & { kind: 'keyword' }, children: WalkNode[], sink: ApNode[], host: ApBlock | null, steps: ApStepNode[]): void {
    const decl = parseVarLine(token.keyword as string, token.rest);
    if (!decl || 'error' in decl || decl.form === 'constant') return;
    const where = host ? `${host.kind} ${host.name}` : basename(this.sourcePath);
    this.varSites.push({ name: decl.name, scope: decl.scope, type: decl.type, block: decl.block, where, path: this.sourcePath, line: this.fileLine(token), inBody: true });
    if (!decl.block) return;
    const node = this.at(new VarNode(VarBlock.ref(decl.name), token.indent), token);
    sink.push(node);
    this.visit(children, node.body, host, steps);
    this.varWrites.push({ name: decl.name, node, path: this.sourcePath });
  }

  private pushText(sink: ApNode[], token: Token): void {
    const raw = rawOf(token);
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
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
        const type: ApSlotType = { kind: 'text' };
        if (spec.minWords !== undefined) type.minWords = spec.minWords;
        if (spec.maxWords !== undefined) type.maxWords = spec.maxWords;
        if (spec.regex) type.regex = spec.regex.source;
        return type;
      }
      case 'number': {
        const type: ApSlotType = { kind: 'number' };
        if (spec.min !== undefined) type.min = spec.min;
        if (spec.max !== undefined) type.max = spec.max;
        return type;
      }
      case 'enum':
        return { kind: 'enum', values: spec.values };
      case 'shape':
        return { kind: 'shape', ref: this.templateRef(spec.ref) };
      case 'list': {
        const type: ApSlotType = { kind: 'list', ref: this.templateRef(spec.ref) };
        if (spec.min !== undefined) type.min = spec.min;
        if (spec.max !== undefined) type.max = spec.max;
        return type;
      }
      case 'any':
        return { kind: 'any', raw: spec.raw };
    }
  }

  // ------------------------------------------------------------- references

  private ref(entry: IndexedBlock | undefined, rawName: string, expectedKind: string, report = true): ApRef {
    if (!entry) {
      if (report && !this.unresolved.some(unresolvedEntry => unresolvedEntry.path === this.sourcePath && unresolvedEntry.name === rawName)) {
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

  /** A store by name: `IN <store>`, a dimension's `STORE <store>`. */
  storeRef(name: string): ApRef {
    return this.ref(this.stores.get(name), name, 'store');
  }

  /** The SLOTS of a template the compilation holds, read with the template grammar — null when it holds no such template. */
  templateSlots(name: string): Slot[] | null {
    const def = this.ctx?.templates.find(template => template.name === name);
    return def ? parseTemplate(def.body)?.slots ?? [] : null;
  }

  /** A flow delegation's BY: an agent, a role bound to one — or a team, which takes the work by its own routing. */
  private byRef(name: string): ApRef {
    const agent = (this.roles && resolveRole(this.roles, name)?.name) ?? name;
    const team = this.agents.has(agent) ? undefined : this.projectTeams.find(teamName => teamName === name);
    if (team) return this.ref({ kind: 'team', name: team, namespace: TeamBlock.NAMESPACE }, name, 'team');
    return this.ref(this.agents.get(agent), agent, 'agent');
  }

  agentRef(name: string): ApRef {
    return this.ref(this.agents.get(name), name, 'agent');
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
      tags: def.tags.map(tag => tag.replace(/^#/, '')),
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
      const match = line.match(/^IMPORT\s+(.+?)\s+FROM\s+(\S+)\s*$/);
      if (!match) continue;
      const ns = match[2];
      const kind = kindOfFolder(ns.split('.')[1] ?? '');
      const ref = kind ? strategyOf(kind)?.ref : null;
      if (!kind || !ref) continue;
      for (const name of splitList(match[1])) {
        this.refIndex(ref).set(name, { kind, name, namespace: ns });
      }
    }
  }

  /** Read the agent's team — or, compiling the main, the main — ONCE: its file, the blocks of its block, its flow slices. */
  private scanUnit(opts: RecorderFinishOpts): TeamScan | null {
    const sources = this.ctx?.sources;
    if (!sources) return null;
    if (opts.unit === 'main') {
      const main = readMainFile(dirname(opts.agentFilePath), sources);
      return main ? unitScan(sources, { kind: 'main', root: dirname(main.path), file: main, members: main.members.map(member => member.name), teams: main.teams.map(team => team.name), memberFiles: opts.memberFiles ?? [] }) : null;
    }
    const root = teamRootForAgentFile(opts.agentFilePath);
    const file = root ? readTeamFile(root, sources) : null;
    if (!root || !file) return null;
    const members = file.members.map(member => member.name);
    const files = findAgentFiles(root);
    const memberFiles = members.flatMap(name => files.filter(agentFile => agentNameOf(agentFile) === name));
    return unitScan(sources, { kind: 'team', root, file, members, teams: [], memberFiles });
  }

  private buildRefIndex(ctx: BundleContext, opts: RecorderFinishOpts): void {
    for (const strategy of KIND_STRATEGIES) {
      for (const def of strategy.entries?.(ctx, opts) ?? []) this.indexDefinition(def);
    }
    if (opts.unit !== 'team') this.agents.set(ctx.agentName, { kind: 'agent', name: ctx.agentName, namespace: AgentBlock.NAMESPACE });

    if (this.team) {
      const members = this.team.memberFiles.map(memberFile => readAgentFile(memberFile, ctx.sources).info);
      for (const member of members) {
        this.agents.set(member.name, { kind: 'agent', name: member.name, namespace: AgentBlock.NAMESPACE });
      }
      // The same role index the orchestration resolves `BY <role>` with: the team's inline blocks and its members' bindings.
      this.roles = buildRoleIndex({ blocks: this.team.blocks, anchor: 'directory' },
        { bindings: members.filter(member => member.roles.length > 0).map(member => ({ name: member.name, roles: member.roles })), anchor: 'directory' });
      // The flows, and what the unit's file imports for them, are the unit's own document's.
      if (opts.unit) {
        this.indexImportLines(this.team.file.source);
        for (const flow of this.team.flows) {
          this.runnables.set(flow.name, { kind: 'flow', name: flow.name, namespace: TeamBlock.flowsNamespace(this.team.name) });
        }
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

  /**
   * The unit's block (built by its class from the scan) + its flow blocks — in
   * the unit's own document, and nowhere else: one id, one block, one
   * definition. A member's document holds none of them; who its team is and
   * its fellows is its bootstrap's to say (src/services/teamMembership.ts).
   */
  private teamBlocks(ownDocument: boolean): ApBlock[] {
    if (!this.team || !ownDocument) return [];
    const team = this.team;
    const sources = this.ctx!.sources;
    const path = team.file.path;
    this.sourcePath = path;
    const flowsNs = TeamBlock.flowsNamespace(team.name);
    // The decorators above the team decorate its work — its flows, each inside them, then in its own.
    const around = team.file.block.decorators ?? [];
    return [
      ...team.flows.map(flow => {
        const span = flow.block ? sources.nestedSpan(path, team.file.block, flow.block) : null;
        return this.fromSource(span, () => RuleBlock.fromBody('flow', { name: flow.name, namespace: flowsNs }, flow.body, this), [...around, ...(span?.decorators ?? [])]);
      }),
      // The unit is its block: EXPORT TEAM, or MAIN.
      this.fromSource(sources.blockSpan(path, team.file.block), () => (team.kind === 'main' ? MainBlock.fromScan(team, this) : TeamBlock.fromScan(team, this)), []),
    ];
  }

  /** The agent root block — built by its class from the pipeline's state. */
  private agentBlock(ctx: BundleContext, opts: RecorderFinishOpts): ApBlock {
    this.sourcePath = opts.agentFilePath;
    const team = this.team?.name;
    // A member refers to its team: the team's block is the team's own document's.
    return this.fromSource(opts.agentSpan, () => Object.assign(AgentBlock.fromContext({ agentName: ctx.agentName, ...opts }, this), team ? { team: AgentBlock.teamRef(team) } : {}));
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
    const sites: VarSite[] = [...opts.declaredVars.map(declaration => ({ ...declaration, block: false, path: declaration.file, inBody: false })), ...this.varSites];
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
    for (const write of this.varWrites) {
      if (table.has(write.name)) continue;
      fail(write.path, write.name, write.node.pos?.line ?? null, constantOf(opts.vars, write.name) !== undefined
        ? `INTO ${write.name}: \`${write.name}\` is a constant — only a variable takes a value while the agent works`
        : `INTO ${write.name}: no variable \`${write.name}\` — declare it with \`VAR ${write.name}\` in the agent's body, or IMPORT the module that exports it`);
    }
    const types = new Map<string, ApRef | null>();
    const blocks = [...table.values()].map(site => {
      const writes = this.varWrites.filter(write => write.name === site.name);
      this.sourcePath = site.path;
      // A shared declaration nobody here fills needs no template here; one this agent fills, or declares, does.
      let type = site.type ? this.templateRef(site.type, site.inBody || writes.length > 0) : null;
      for (const write of writes) {
        if (write.node.type === 'directive') continue;
        const line = write.node.pos?.line ?? null;
        const yielded = this.yieldOf(write.node.type === 'var' ? write.node.body : [write.node], doc, (thenType, elseType) =>
          fail(write.path, site.name, line, `\`${site.name}\`: the IF and ELSE branches yield different types — \`${refName(thenType)}\` and \`${refName(elseType)}\``));
        if (!yielded) continue;
        if (!type) type = yielded;
        else if (yielded.target !== type.target) {
          fail(write.path, site.name, line, `\`${site.name}\` is a \`${refName(type)}\`, but this ${write.node.type === 'var' ? 'block' : 'procedure'} yields a \`${refName(yielded)}\` — a variable keeps one type for its whole life`);
        }
      }
      // A run of an EACH answers one element, not the list its INTO collects.
      if (type) for (const write of writes) if (!this.eachInto.some(entry => entry.node === write.node)) write.node.shape = { force: 1, ref: type };
      types.set(site.name, type);
      return VarBlock.fromDeclaration(site.name, site.scope, type, site.where);
    });
    // `EACH … IN {{<list>}}`: the list is a variable whose template holds one LIST slot — the elements.
    const oneList = (type: ApRef) => (doc.slotsOf(type) ?? []).filter(slot => slot.spec.kind === 'list').length;
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
        const thenType = this.yieldOf(last.then, doc, conflict);
        const elseType = this.yieldOf(last.else, doc, conflict);
        if (thenType && elseType && thenType.target !== elseType.target) conflict(thenType, elseType);
        return thenType ?? elseType;
      }
      case 'until':
      case 'in': return this.yieldOf(last.body, doc, conflict);
      default: return null;
    }
  }

  // -------------------------------------------------------------------- meta

  private buildMeta(ctx: BundleContext, root: string | null): ApDocumentMeta {
    // Each family's phrases, with the active adapter's renderings over them.
    const forceLevels: Record<string, Record<string, string>> = {};
    for (const family of forceLevelFamilies()) forceLevels[family.name] = { ...family.levels, ...ctx.renderings?.[family.name] };

    const enums: Record<string, Record<string, string>> = {};
    for (const prim of ENUM_PRIMITIVES) {
      enums[prim.keyword] = Object.fromEntries(
        Object.entries(prim.values).map(([valueName, fn]) => [valueName, ctx.renderings?.[prim.keyword]?.[valueName] ?? fn()]),
      );
    }

    const flowRun = ctx.renderings?.FLOW?.run;
    const phrases = delegationPhrases(ctx.renderings);
    return {
      root: root ?? `${AgentBlock.NAMESPACE}/${ctx.agentName}`,
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
    for (const kind of new Set(doc.all().map(block => block.kind))) {
      const text = renderedIntro(kind) || (pluginOf(kind)?.about ?? '');
      if (text) intros[kind] = text;
    }

    const shapePos: Record<string, number> = {};
    for (const prov of ['definition', 'agent'] as const) {
      for (const block of doc.byProvenance(prov)) {
        if (block.shapePos !== null && block.shape) shapePos[block.address] = block.shapePos;
      }
    }

    return {
      // RAW block delimiters are lexer syntax — cleaned at the source.
      bootstrap: opts.bootstrap.split('\n').filter(line => !/^\s*(RAW:|:RAW)\s*$/.test(line)).join('\n'),
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
    this.team = this.scanUnit(opts);
    this.buildRefIndex(ctx, opts);

    const unit = opts.unit && this.team ? this.team : null;
    this.ownsFlows = unit !== null;
    const doc = new ApDocument(this.buildMeta(ctx, unit ? `${unit.kind === 'main' ? MainBlock.NAMESPACE : TeamBlock.NAMESPACE}/${unit.name}` : null));
    const producers: [BlockProvenance, () => ApBlock[]][] = [
      ['definition', () => this.definitionBlocks(ctx, opts)],
      // A unit's flows are its own definition — a chapter of its document, as an agent's procedures are of its own.
      ['definition', () => this.teamBlocks(unit !== null)],
      // A unit's document has no agent: its root is the TEAM block.
      ['agent',      () => (unit ? [] : [this.agentBlock(ctx, opts)])],
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
    const variables = new Set(doc.byKind('var').map(block => block.name));
    for (const delegation of this.bareDelegations.filter(candidate => variables.has(candidate.name))) {
      this.varErrors.push({ path: delegation.path, name: delegation.name, line: delegation.line, message: `DELEGATE ${delegation.name}: \`${delegation.name}\` is a variable no MARK above it fills — a DELEGATE of a variable hands out the contracts a MARK made; MARK it first, or say the task in words` });
    }
    const executors = executorSpecs(doc, opts.vars ?? {}, this.ctx!.agentName, name => templateClosure(name, this.ctx?.templates ?? []));
    if (Object.keys(executors).length > 0) doc.meta.executors = executors;
    // What the flows start in the background: an id for each, and on each WAIT the ids it takes back.
    // And what their MARKs bind: an id for each, the list it fills, its spec, its limit and its domain.
    const marks: Record<string, ApMark> = {};
    const markOf = (node: { text?: string; as?: ApShape; max?: number; within?: string }, step: string, flow: string): ApMark | null => {
      const parsed = parseMark(node.text ?? '');
      return parsed.into && node.as ? { flow, step, list: parsed.into, spec: refName(node.as.ref), max: node.max ?? 0, within: node.within ?? null } : null;
    };
    // The agent's own body too: a delegation to another harness there is a piece of the registry (D66).
    const root = doc.root();
    const bodies = [...doc.byKind('flow'), ...(root ? [root] : [])];
    const background = Object.assign({}, ...bodies.map(block => bindBackgroundWork(block as unknown as { address: string; name: string; body: unknown[] },
      (text, prefix) => shortId(prefix, text), marks, (node, step) => markOf(node, step, block.name))));
    if (Object.keys(background).length > 0) doc.meta.background = background;
    if (Object.keys(marks).length > 0) doc.meta.marks = marks;
    const used = Object.fromEntries(plugins().filter(plugin => doc.byKind(plugin.name).length > 0).map(plugin => [plugin.name, plugin]));
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

/**
 * A unit's scan, from its file: the blocks of its TEAM or MAIN block and its
 * flows — a FLOW's body runs from the line after its header to its next
 * sibling in the block (a WHEN can sit between two FLOWs), de-indented by the
 * block's indent: the text a flow file would hold.
 */
function unitScan(sources: SourceRegistry, unit: Omit<TeamScan, 'name' | 'blocks' | 'flows' | 'routing'>): TeamScan {
  const { file } = unit;
  const written = file.block.children.filter((child): child is Block => child.type === 'block');
  const lines = (block: Block) => sources.nestedSpan(file.path, file.block, block).lines.map(line => line.text.slice(file.childIndent));
  const flows: TeamScan['flows'] = written
    .filter((block): block is Block & { name: string } => block.key === 'FLOW' && block.name !== null)
    .map(block => ({ name: block.name, block, body: lines(block).slice(1).join('\n') }));
  const routing = written.filter(block => block.key === 'WHEN').flatMap(lines).join('\n');
  return { ...unit, name: file.name, blocks: written, flows, routing };
}

/** A definition's body nested in the decorators above it, outermost first — each opening the block the next one, then the body, stands in. */
function wrapped(decorators: readonly DecoratorLine[], body: string): string {
  const pad = (depth: number) => '    '.repeat(depth);
  const heads = decorators.map((decorator, depth) => `${pad(depth)}${DECORATOR_MARK}${decorator.key}${decorator.rest ? ` ${decorator.rest}` : ''}:`);
  return [...heads, ...body.split(/\r?\n/).map(line => (line.trim() ? `${pad(decorators.length)}${line}` : line))].join('\n');
}
