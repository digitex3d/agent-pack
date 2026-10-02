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
  ApIfNode, ApUntilNode, ApWhenNode, ApStepNode, ApParallelNode, ApInNode, ApDistillNode, ApVarNode,
  ApPos, ApLine,
} from './types.js';
import { distillLines } from '../distill.js';
import {
  MdEnv, renderNodes, renderDirectiveGroup, indentLines, shapeLine, storeVarLine,
} from '../../adapters/md/toolkit.js';
import {
  controlHead, refName, runLine, unresolvedRun,
  stepSignature, stepsHeader, storeScopeLine, varBlockHead,
} from '../../adapters/md/phrases.js';

/** What a node answers as a line: its primitive and the text after it. */
export type LineHead = Pick<ApLine, 'primitive' | 'text'>;

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
    };
  }

  static fromData(n: ApDirectiveNode): DirectiveNode {
    const node = new DirectiveNode(n.keyword, n.force, n.text, n.indent, n.body ? reviveNodes(n.body) : undefined);
    if (n.shape) node.shape = n.shape;
    if (n.into) node.into = n.into;
    node.chars = n.chars;
    return node;
  }

  /**
   * A bodied keyword head, or a line whose result fills a variable (`DO … INTO`)
   * — a line of its own, told how to store it; plain directives render grouped
   * by the sequence renderer.
   */
  asMdLines(env: MdEnv, ordered: boolean): string[] {
    if (this.into) {
      return [
        ...indentLines(renderDirectiveGroup(env, this.keyword, this.force, [this.text]), this.indent ?? 0),
        ...indentLines([...(this.shape ? [shapeLine(env, this.shape)] : []), storeVarLine(env, this.into, !!this.shape)], (this.indent ?? 0) + 2),
      ];
    }
    return [
      ...indentLines(renderDirectiveGroup(env, this.keyword, this.force, [this.text + ':']), this.indent ?? 0),
      ...renderNodes(env, this.body ?? [], ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: this.keyword, text: this.text };
  }
}

export class RunNode extends NodeBase implements ApRunNode {
  readonly type = 'run';

  constructor(public ref: ApRef, indent?: number) {
    super(indent);
  }

  static fromData(n: ApRunNode): RunNode {
    const node = new RunNode(n.ref, n.indent);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApRunNode {
    return {
      type: this.type, ref: this.ref, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
    };
  }

  asMdLines(env: MdEnv): string[] {
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

export class IfNode extends NodeBase implements ApIfNode {
  readonly type = 'if';
  then: ApNode[] = [];
  else: ApNode[] = [];

  constructor(public condition: string, indent?: number) {
    super(indent);
  }

  static fromData(n: ApIfNode): IfNode {
    const node = new IfNode(n.condition, n.indent);
    node.then = reviveNodes(n.then);
    node.else = reviveNodes(n.else);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApIfNode {
    return {
      type: this.type, condition: this.condition, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      then: this.then, else: this.else,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    const out = [
      ...indentLines([`${controlHead('IF')} ${env.substitute(this.condition)}:`], this.indent ?? 0),
      ...renderNodes(env, this.then, ordered),
    ];
    if (this.else.length > 0) {
      out.push(...indentLines([`${controlHead('ELSE')}:`], this.indent ?? 0));
      out.push(...renderNodes(env, this.else, ordered));
    }
    return out;
  }

  asLine(): LineHead {
    return { primitive: 'IF', text: this.condition };
  }
}

export class UntilNode extends NodeBase implements ApUntilNode {
  readonly type = 'until';
  body: ApNode[] = [];

  constructor(public condition: string, indent?: number) {
    super(indent);
  }

  static fromData(n: ApUntilNode): UntilNode {
    const node = new UntilNode(n.condition, n.indent);
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApUntilNode {
    return {
      type: this.type, condition: this.condition, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    const head = `${controlHead('UNTIL')} ${env.substitute(this.condition)}`;
    return [
      ...indentLines([`${head}:`], this.indent ?? 0),
      ...renderNodes(env, this.body, ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'UNTIL', text: this.condition };
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
  body: ApNode[] = [];

  constructor(public condition: string, indent?: number) {
    super(indent);
  }

  static fromData(n: ApWhenNode): WhenNode {
    const node = new WhenNode(n.condition, n.indent);
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApWhenNode {
    return {
      type: this.type, condition: this.condition, chars: this.chars,
      ...(this.indent ? { indent: this.indent } : {}),
      body: this.body,
    };
  }

  asMdLines(env: MdEnv, ordered: boolean): string[] {
    return [
      ...indentLines([`${controlHead('WHEN')} ${env.substitute(this.condition)}:`], this.indent ?? 0),
      ...renderNodes(env, this.body, ordered),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'WHEN', text: this.condition };
  }
}

export class StepNode extends NodeBase implements ApStepNode {
  readonly type = 'step';
  shape: ApShape | null = null;
  body: ApNode[] = [];

  constructor(
    public title: string,
    public by: ApRef | null,
    public context: string | null,
  ) {
    super();
  }

  static fromData(n: ApStepNode): StepNode {
    const node = new StepNode(n.title, n.by, n.context);
    node.shape = n.shape;
    node.body = reviveNodes(n.body);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApStepNode {
    return {
      type: this.type, title: this.title, by: this.by, context: this.context,
      shape: this.shape, chars: this.chars, body: this.body,
    };
  }

  /** One item of a STEP list — marker + signature + reindented body. */
  asMdItem(env: MdEnv, index: number, ordered: boolean): string[] {
    const marker = ordered ? `${index + 1}. ` : '- ';
    const args = new Map<string, string>();
    if (this.by) args.set('BY', refName(this.by));
    if (this.context) args.set('CONTEXT', this.context);
    const out = [`${marker}${env.substitute(this.title)}${stepSignature(args)}`];
    const body = this.bodyLines(env);
    if (body.length) out.push(...indentLines(body, marker.length));
    return out;
  }

  /** What the step's executor is told: the shape its input takes, then the step's own lines. */
  bodyLines(env: MdEnv): string[] {
    const body: string[] = [];
    if (this.shape) body.push(shapeLine(env, this.shape));
    // The body keeps its source indent; the shape line has none — align them.
    body.push(...dedentLines(renderNodes(env, this.body, true)));
    return body;
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

export class ParallelNode extends NodeBase implements ApParallelNode {
  readonly type = 'parallel';
  steps: ApStepNode[] = [];

  static fromData(n: ApParallelNode): ParallelNode {
    const node = new ParallelNode();
    node.steps = reviveNodes(n.steps) as ApStepNode[];
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApParallelNode {
    return { type: this.type, chars: this.chars, steps: this.steps };
  }

  asMdLines(env: MdEnv): string[] {
    return [
      `${controlHead('PARALLEL')}:`,
      stepsHeader(),
      ...this.steps.flatMap((s, i) => (s as StepNode).asMdItem(env, i, false)),
    ];
  }

  asLine(): LineHead {
    return { primitive: 'PARALLEL', text: '' };
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
  parallel:  d => ParallelNode.fromData(d as ApParallelNode),
  in:        d => InNode.fromData(d as ApInNode),
  var:       d => VarNode.fromData(d as ApVarNode),
  distill:   d => DistillNode.fromData(d as ApDistillNode),
};

/** Lines shifted left by their common indentation. */
function dedentLines(lines: string[]): string[] {
  const indents = lines.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length);
  const base = indents.length ? Math.min(...indents) : 0;
  return base ? lines.map(l => l.slice(Math.min(base, l.length - l.trimStart().length))) : lines;
}

/** A procedure's DISTILL mark — renders the instruction to use, or write, its script. */
export class DistillNode extends NodeBase implements ApDistillNode {
  readonly type = 'distill';
  input?: ApShape;
  inputExample?: string;

  constructor(public force: number, public id: string, public shape: ApShape, public outputExample: string, input?: { shape: ApShape; example: string }) {
    super();
    if (input) { this.input = input.shape; this.inputExample = input.example; }
  }

  static fromData(n: ApDistillNode): DistillNode {
    const node = new DistillNode(n.force, n.id, n.shape, n.outputExample, n.input && n.inputExample !== undefined ? { shape: n.input, example: n.inputExample } : undefined);
    node.chars = n.chars;
    return node;
  }

  toJSON(): ApDistillNode {
    return {
      type: this.type, force: this.force, id: this.id, shape: this.shape,
      ...(this.input ? { input: this.input, inputExample: this.inputExample } : {}),
      outputExample: this.outputExample, chars: this.chars,
    };
  }

  asMdLines(env: MdEnv): string[] {
    return distillLines({
      force: this.force,
      id: this.id,
      intro: env.forceLevels['DISTILL']?.[String(this.force)] ?? '',
      run: `${env.apxOf(null)} run ${this.id}`,
      shape: { name: refName(this.shape.ref), ref: env.refOf(this.shape.ref.target) },
      outputExample: this.outputExample,
      ...(this.inputExample !== undefined ? { inputExample: this.inputExample } : {}),
    });
  }

  /** The mark is the compiler's, not a line of the source. */
  asLine(): null {
    return null;
  }
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
