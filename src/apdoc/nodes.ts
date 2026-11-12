// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The node classes — the block axis applied one level down: each node kind is
 * a class that OWNS its serialization (`toJSON`, canonical field order) and
 * its md rendering (`asMdLines` / `asMdItem`), plus a revive registry so the
 * decompiler rehydrates typed nodes from plain JSON.
 *
 * The data contracts stay in types.ts (Ap*Node interfaces — the serialized
 * shapes); every class implements its contract, so consumers keep typing
 * against plain data while runtime nodes carry behaviour.
 *
 * What stays OUTSIDE the classes, by nature: cross-node concerns — grouping
 * of consecutive directive/run lines and the numbered STEP list — live in the
 * md toolkit's sequence renderer, which delegates every single-node render
 * back here.
 */
import type {
  ApNode, ApRef, ApShape,
  ApDirectiveNode, ApRunNode, ApTextNode,
  ApIfNode, ApUntilNode, ApWhenNode, ApStepNode, ApEachNode, ApEachHead, ApInNode, ApVarNode,
  ApPos, ApLine,
} from './types.js';
import { checkHead, type ApCondCheck, type CheckKind } from '../check.js';
import { FORMULAS, fill } from '../formulas.js';
import {
  type MdEnv, renderNodes, renderDirectiveGroup, directiveText, executorHow, indentLines, runIntoLines, shapeLine, storeVarLine,
} from '../../adapters/md/toolkit.js';
import {
  controlHead, executorHead, executorRounds, refName, runLine, unresolvedRun,
  eachHead, stepsHeader, storeScopeLine, varBlockHead,
} from '../../adapters/md/phrases.js';

/** What a node answers as a line: its primitive and the text after it. */
export type LineHead = Pick<ApLine, 'primitive' | 'text' | 'executor'>;

/** Common base: chars stamped by measure, optional source indent, source position. */
abstract class NodeBase {
  chars = 0;
  indent?: number;
  /** Where the node was written — provenance, stamped by the builder, never serialized. */
  pos?: ApPos;

  constructor(indent?: number) {
    if (indent) this.indent = indent;
  }

  /** The md lines of THIS node alone (grouping is the sequence renderer's job). */
  abstract asMdLines(env: MdEnv, ordered: boolean): string[];

  /** This node as a keyword line (primitive + its text), or null when it is none. */
  abstract asLine(): LineHead | null;
}

export class DirectiveNode extends NodeBase implements ApDirectiveNode {
  readonly type = 'directive';
  body?: ApNode[];
  shape?: ApShape;
  into?: ApRef;
  uses?: ApRef[];
  by?: string;
  harness?: string;
  as?: ApShape;
  async?: true;
  exe?: string;
  work?: string;
  element?: true;
  waits?: string[];
  mark?: string;
  list?: string;
  max?: number;
  within?: string;

  constructor(
    public keyword: string,
    public force: number | null,
    public text: string,
    indent?: number,
    body?: ApNode[],
  ) {
    super(indent);
    if (body) this.body = body;
  }

  toJSON(): ApDirectiveNode {
    return {
      type: this.type, keyword: this.keyword, force: this.force,
      text: this.text, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      ...(this.body ? { body: this.body } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      ...(this.into ? { into: this.into } : {}),
      ...(this.uses ? { uses: this.uses } : {}),
      ...(this.by ? { by: this.by } : {}),
      ...(this.harness ? { harness: this.harness } : {}),
      ...(this.as ? { as: this.as } : {}),
      ...(this.async ? { async: this.async } : {}),
      ...(this.exe ? { exe: this.exe } : {}),
      ...(this.work ? { work: this.work } : {}),
      ...(this.element ? { element: this.element } : {}),
      ...(this.waits ? { waits: this.waits } : {}),
      ...(this.mark ? { mark: this.mark } : {}),
      ...(this.list ? { list: this.list } : {}),
      ...(this.max ? { max: this.max } : {}),
      ...(this.within ? { within: this.within } : {}),
    };
  }

  static fromData(n: ApDirectiveNode): DirectiveNode {
    const node = new DirectiveNode(n.keyword, n.force, n.text, n.indent, n.body ? reviveNodes(n.body) : undefined);
    if (n.shape) node.shape = n.shape;
    if (n.into) node.into = n.into;
    if (n.uses) node.uses = n.uses;
    if (n.by) node.by = n.by;
    if (n.harness) node.harness = n.harness;
    if (n.as) node.as = n.as;
    if (n.async) node.async = n.async;
    if (n.exe) node.exe = n.exe;
    if (n.work) node.work = n.work;
    if (n.element) node.element = n.element;
    if (n.waits) node.waits = n.waits;
    if (n.mark) node.mark = n.mark;
    if (n.list) node.list = n.list;
    if (n.max) node.max = n.max;
    if (n.within) node.within = n.within;
    node.chars = n.chars;
    return node;
  }

  /**
   * A bodied keyword head, or a line whose result fills a variable (`DO … INTO`)
   * — a line of its own, told how to store it; plain directives render grouped
   * by the sequence renderer.
   */
  asMdLines(env: MdEnv, ordered: boolean): string[] {
    // A delegated or computed line: `answer` / `run` stores its result — no `set` to tell; a background piece's `delegate deliver` alike.
    // A MARK's list is filled by `contract mark` alike.
    if (this.into && (this.exe || this.work || this.keyword === 'MARK')) return indentLines(renderDirectiveGroup(env, this.keyword, this.force, [directiveText(this, env)]), this.indent ?? 0);
    if (this.into) {
      return [
        ...indentLines(renderDirectiveGroup(env, this.keyword, this.force, [directiveText(this, env)]), this.indent ?? 0),
        ...indentLines([...(this.shape ? [shapeLine(env, this.shape)] : []), storeVarLine(env, this.into, !!this.shape)], (this.indent ?? 0) + 2),
      ];
    }
    return [
      ...indentLines(renderDirectiveGroup(env, this.keyword, this.force, [`${directiveText(this, env)}:`]), this.indent ?? 0),
      ...renderNodes(env, this.body ?? [], ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: this.keyword, text: this.text };
  }
}

export class RunNode extends NodeBase implements ApRunNode {
  readonly type = 'run';
  into?: ApRef;
  shape?: ApShape;

  constructor(public ref: ApRef, indent?: number) {
    super(indent);
  }

  static fromData(n: ApRunNode): RunNode {
    const node = new RunNode(n.ref, n.indent);
    if (n.into) node.into = n.into;
    if (n.shape) node.shape = n.shape;
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApRunNode {
    return {
      type: this.type, ref: this.ref, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      ...(this.into ? { into: this.into } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
    };
  }

  asMdLines(env: MdEnv): string[] {
    if (this.into) return runIntoLines(env, this.ref, this.into, this.shape, this.indent ?? 0);
    const line = this.ref.resolved === false
      ? unresolvedRun(this.ref.target)
      : runLine(this.ref.kind, refName(this.ref), env.refOf(this.ref.target));
    return indentLines([line], this.indent ?? 0);
  }

  asLine(): LineHead {
    return { primitive: 'RUN', text: refName(this.ref) };
  }
}

export class TextNode extends NodeBase implements ApTextNode {
  readonly type = 'text';

  constructor(public raw: string) {
    super();
  }

  static fromData(n: ApTextNode): TextNode {
    const node = new TextNode(n.raw);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApTextNode {
    return { type: this.type, raw: this.raw, chars: this.chars };
  }

  asMdLines(env: MdEnv): string[] {
    return [env.substitute(this.raw)]; // verbatim, indentation included in raw
  }

  /** Prose is no keyword line. */
  asLine(): null {
    return null;
  }
}

/**
 * The head line of an IF/UNTIL: `If <condition>` — or, checked, the condition
 * (unless sealed) and the command of the apx whose answer decides it.
 */
function conditionHead(kind: CheckKind, n: { condition: string; check?: ApCondCheck; executor?: number; exe?: string }, env: MdEnv): string {
  if (n.executor) {
    const rounds = n.exe ? env.roundsOf?.(n.exe) : undefined;
    return executorHead(`${controlHead(kind)} ${env.substitute(n.condition)}`, n.executor) + executorHow(env, n.exe, n.executor)
      + (rounds ? executorRounds(rounds) : '');
  }
  if (!n.check) return `${controlHead(kind)} ${env.substitute(n.condition)}`;
  // A checked condition is a block of the document that holds it — an agent's body, or a unit's flow: reached by its id there.
  return checkHead(kind, n.check, env.substitute(n.condition), env.apxOf(null));
}

export class IfNode extends NodeBase implements ApIfNode {
  readonly type = 'if';
  then: ApNode[] = [];
  else: ApNode[] = [];
  check?: ApCondCheck;
  executor?: number;
  exe?: string;

  constructor(public condition: string, indent?: number) {
    super(indent);
  }

  static fromData(n: ApIfNode): IfNode {
    const node = new IfNode(n.condition, n.indent);
    if (n.check) node.check = n.check;
    if (n.executor) node.executor = n.executor;
    if (n.exe) node.exe = n.exe;
    node.then = reviveNodes(n.then);
    node.else = reviveNodes(n.else);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApIfNode {
    return {
      type: this.type, condition: this.condition,
      ...(this.check ? { check: this.check } : {}),
      ...(this.executor ? { executor: this.executor } : {}),
      ...(this.exe ? { exe: this.exe } : {}),
      chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      then: this.then, else: this.else,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    const out = [
      ...indentLines([`${conditionHead('IF', this, env)}:`], this.indent ?? 0),
      ...renderNodes(env, this.then, ordered),
    ];
    if (this.else.length > 0) {
      out.push(...indentLines([`${controlHead('ELSE')}:`], this.indent ?? 0));
      out.push(...renderNodes(env, this.else, ordered));
    }
    return out;
  }

  asLine(): LineHead {
    return { primitive: 'IF', text: this.condition, ...(this.executor ? { executor: this.executor } : {}) };
  }
}

export class UntilNode extends NodeBase implements ApUntilNode {
  readonly type = 'until';
  body: ApNode[] = [];
  max?: number;
  check?: ApCondCheck;
  executor?: number;
  exe?: string;

  constructor(public condition: string, indent?: number, max?: number) {
    super(indent);
    if (max) this.max = max;
  }

  static fromData(n: ApUntilNode): UntilNode {
    const node = new UntilNode(n.condition, n.indent, n.max);
    if (n.check) node.check = n.check;
    if (n.executor) node.executor = n.executor;
    if (n.exe) node.exe = n.exe;
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApUntilNode {
    return {
      type: this.type, condition: this.condition,
      ...(this.max ? { max: this.max } : {}),
      ...(this.check ? { check: this.check } : {}),
      ...(this.executor ? { executor: this.executor } : {}),
      ...(this.exe ? { exe: this.exe } : {}),
      chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    return [
      ...indentLines([`${conditionHead('UNTIL', this, env)}:`], this.indent ?? 0),
      ...renderNodes(env, this.body, ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'UNTIL', text: this.condition, ...(this.executor ? { executor: this.executor } : {}) };
  }
}

/**
 * `VAR <name>:` — the lines beneath fill a session variable: the head names it,
 * the variable's type (when it has one) shapes the work, and the closing line
 * says how to store the outcome.
 */
export class VarNode extends NodeBase implements ApVarNode {
  readonly type = 'var';
  shape?: ApShape;
  body: ApNode[] = [];

  var: ApRef;

  constructor(ref: ApRef, indent?: number) {
    super(indent);
    this.var = ref;
  }

  static fromData(n: ApVarNode): VarNode {
    const node = new VarNode(n.var, n.indent);
    if (n.shape) node.shape = n.shape;
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApVarNode {
    return {
      type: this.type, var: this.var, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    // The added lines sit with the body's own: at its first node's indent.
    const inner = (this.body.find(n => 'indent' in n) as { indent?: number } | undefined)?.indent ?? (this.indent ?? 0) + 2;
    // A lone RUN of a procedure a delegate or a program carries out: `answer` / `run` stores the value itself.
    const [only] = this.body;
    if (this.body.length === 1 && only.type === 'run' && !only.into && only.ref.resolved !== false && env.exeOf?.(only.ref.target)) {
      return [
        ...indentLines([varBlockHead(refName(this.var))], this.indent ?? 0),
        ...runIntoLines(env, only.ref, this.var, this.shape, only.indent ?? inner),
      ];
    }
    return [
      ...indentLines([varBlockHead(refName(this.var))], this.indent ?? 0),
      ...indentLines(this.shape ? [shapeLine(env, this.shape)] : [], inner),
      ...renderNodes(env, this.body, ordered),
      ...indentLines([storeVarLine(env, this.var, !!this.shape)], inner),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'VAR', text: refName(this.var) };
  }
}

export class WhenNode extends NodeBase implements ApWhenNode {
  readonly type = 'when';
  shape?: ApShape;
  input?: ApRef;
  body: ApNode[] = [];

  constructor(public condition: string, indent?: number) {
    super(indent);
  }

  static fromData(n: ApWhenNode): WhenNode {
    const node = new WhenNode(n.condition, n.indent);
    if (n.shape) node.shape = n.shape;
    if (n.input) node.input = n.input;
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApWhenNode {
    return {
      type: this.type, condition: this.condition, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      ...(this.shape ? { shape: this.shape } : {}),
      ...(this.input ? { input: this.input } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    const body = renderNodes(env, this.body, ordered);
    // The input and shape lines open the body, at the body's own indent.
    const inner = body.find(l => l.trim() !== '')?.match(/^ */)?.[0].length ?? (this.indent ?? 0) + 4;
    return [
      ...indentLines([`${controlHead('WHEN')} ${env.substitute(this.condition)}:`], this.indent ?? 0),
      ...(this.input ? indentLines([fill(FORMULAS.keywords.WHEN.handed, { name: refName(this.input), ref: env.refOf(this.input.target) })], inner) : []),
      ...(this.shape ? indentLines([shapeLine(env, this.shape)], inner) : []),
      ...body,
    ];
  }

  asLine(): LineHead {
    return { primitive: 'WHEN', text: this.condition };
  }
}

export class StepNode extends NodeBase implements ApStepNode {
  readonly type = 'step';
  body: ApNode[] = [];

  constructor(public title: string) {
    super();
  }

  static fromData(n: ApStepNode): StepNode {
    const node = new StepNode(n.title);
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApStepNode {
    return { type: this.type, title: this.title, chars: this.chars, body: this.body };
  }

  /** One item of a STEP list — marker, title, reindented body. */
  asMdItem(env: MdEnv, index: number, ordered: boolean): string[] {
    const marker = ordered ? `${index + 1}. ` : '- ';
    const out = [`${marker}${env.substitute(this.title)}`];
    const body = this.bodyLines(env);
    if (body.length) out.push(...indentLines(body, marker.length));
    return out;
  }

  /** The step's lines, as whoever runs the flow carries them out. */
  bodyLines(env: MdEnv): string[] {
    // The body keeps its source indent — aligned to the item.
    return dedentLines(renderNodes(env, this.body, true));
  }

  /** Steps never render alone — the sequence renderer opens the list. */
  asMdLines(env: MdEnv, ordered: boolean): string[] {
    return [stepsHeader(), ...this.asMdItem(env, 0, ordered)];
  }

  asLine(): LineHead {
    return { primitive: 'STEP', text: this.title };
  }
}

/**
 * `IN <store>:` — the steps under it work in that store.
 *
 * The store is a Ref, so the link is checkable like every other cross-block
 * reference: a name that resolves to nothing is caught at compile time instead
 * of reading as prose that happens to be a table name.
 */
export class InNode extends NodeBase implements ApInNode {
  readonly type = 'in';
  body: ApNode[] = [];

  constructor(public store: ApRef, indent?: number) {
    super(indent);
  }

  static fromData(n: ApInNode): InNode {
    const node = new InNode(n.store, n.indent);
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApInNode {
    return {
      type: this.type, store: this.store, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    return [
      ...indentLines([storeScopeLine(env, this.store)], this.indent ?? 0),
      ...renderNodes(env, this.body, ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'IN', text: refName(this.store) };
  }
}

export class EachNode extends NodeBase implements ApEachNode {
  readonly type = 'each';
  body: ApNode[] = [];

  constructor(public each: ApEachHead, indent?: number) {
    super(indent);
  }

  static fromData(n: ApEachNode): EachNode {
    const node = new EachNode(n.each, n.indent);
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApEachNode {
    return { type: this.type, chars: this.chars, ...(this.indent ? { indent: this.indent } : {}), each: this.each, body: this.body };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    const waited = this.body.some(n => n.type === 'directive' && !n.async);
    return [
      ...indentLines([eachHead({ ...this.each, list: refName(this.each.list) }, waited, t => env.substitute(t))], this.indent ?? 0),
      ...renderNodes(env, this.body, ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'EACH', text: `${this.each.item} IN {{${refName(this.each.list)}}} MAX ${this.each.max}` };
  }
}

// ---------------------------------------------------------------------------
// Revive registry — the decompiler side, one strategy per node type.
// ---------------------------------------------------------------------------

type Reviver = (data: ApNode) => ApNode;

/** One reviver per node type — pointers to the classes' own `fromData`. */
const REVIVERS: Record<string, Reviver> = {
  directive: d => DirectiveNode.fromData(d as ApDirectiveNode),
  run:       d => RunNode.fromData(d as ApRunNode),
  text:      d => TextNode.fromData(d as ApTextNode),
  if:        d => IfNode.fromData(d as ApIfNode),
  until:     d => UntilNode.fromData(d as ApUntilNode),
  when:      d => WhenNode.fromData(d as ApWhenNode),
  step:      d => StepNode.fromData(d as ApStepNode),
  each:      d => EachNode.fromData(d as ApEachNode),
  in:        d => InNode.fromData(d as ApInNode),
  var:       d => VarNode.fromData(d as ApVarNode),
};

/** Lines shifted left by their common indentation. */
export function dedentLines(lines: string[]): string[] {
  const indents = lines.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  return base ? lines.map(l => l.slice(Math.min(base, l.length - l.trimStart().length))) : lines;
}


/**
 * Every node — at any depth: bodies, branches, steps — in source order
 * (pre-order), with the nodes containing it, outermost first. THE traversal of
 * a node tree: containers are found by shape (arrays of typed nodes), so a new
 * node kind needs no change here.
 */
export function* walk(nodes: readonly ApNode[], containers: readonly ApNode[] = []): Generator<{ node: ApNode; containers: ApNode[] }> {
  for (const node of nodes) {
    yield { node, containers: [...containers] };
    for (const v of Object.values(node)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'type' in v[0]) {
        yield* walk(v as ApNode[], [...containers, node]);
      }
    }
  }
}

/** Whether any node — at any depth — satisfies the predicate. */
export function someNode(nodes: readonly ApNode[], pred: (n: ApNode) => boolean): boolean {
  for (const { node } of walk(nodes)) if (pred(node)) return true;
  return false;
}

/** Revive an array of serialized nodes into typed node instances. */
export function reviveNodes<T extends ApNode>(data: T[]): T[] {
  return data.map(d => (REVIVERS[d.type]?.(d) ?? d) as T);
}
