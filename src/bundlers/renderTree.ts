// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Recursive body renderer — the single, centralized pass that turns a `.ap`
 * body (after substitutions) into final markdown.
 *
 * Every construct is rendered uniformly as "a line, optionally with a recursive
 * sub-render of its children":
 *
 *   - leaf groups   (force-levels MUST/…, bullet-groups DO/RUN/BY/WHEN) and
 *                   enums (CONTEXT) reuse the existing primitive renderers, so
 *                   their output is byte-identical to the prior flat pipeline;
 *   - sequence blocks (STEP, via SEQUENCE_PRIMITIVES) collapse consecutive
 *                   siblings into an ordered/unordered list whose items each
 *                   recurse into their own body;
 *   - PARALLEL      renders its STEP children as an unordered list ("container
 *                   forces order");
 *   - control heads (IF/ELSE/UNTIL) render the head and recurse the body,
 *                   keeping it at its original indentation.
 *
 * The indent-tree is built once from the lexer token stream; the recursion is
 * bounded by the block contracts (STEP cannot nest STEP), so depth is shallow.
 */
import { lex, Token } from '../lexer.js';
import { applyForceLevels } from '../forceLevel.js';
import { applyEnumPrimitives } from '../enumPrimitives.js';
import { sequencePrimitiveFor } from '../sequencePrimitives.js';
import { definitionArgsFor } from '../definitionArgs.js';
import type { BundleContext } from '../dispatch/types.js';
import { forceLevelBaseOf } from '../forceLevelConfig.js';
import { FORMULAS, fill } from '../formulas.js';
import { checkHead, condCheckOf, type CheckKind } from '../check.js';
import { apxCommand } from '../apx/paths.js';

const CONTROL_HEADS: Record<string, string> = { IF: 'If', ELSE: 'Else', UNTIL: 'Until' };

/**
 * Render a control-head line (the text before the trailing colon): `Until <condition>`.
 * A checked head (`IF!`, `IF!!`) in a flow step is checked by the step's BY
 * agent, through its own apx — `condCheckOf` decides, as for the document
 * builder. Anywhere else this pass renders (a playbook, a team's routing) no
 * executable checks it: it reads as the plain head — the source scan
 * (`checkedHeadIssues`) has warned, or failed the build of an `IF!!`.
 */
function renderControlHead(kw: string, rawRest: string, level: number, by: string | undefined, ctx: BundleContext | undefined): string {
  const condition = stripTrailingColon(rawRest);
  if (kw === 'IF' || kw === 'UNTIL') {
    const { check } = condCheckOf(kw as CheckKind, level, condition, by ? { at: 'step', agent: by } : { at: 'none' }, ctx?.checks);
    if (check) return checkHead(kw as CheckKind, check, check.level === 2 ? '' : condition, apxCommand(check.agent));
  }
  const rest = condition ? ` ${condition}` : '';
  return `${CONTROL_HEADS[kw]}${rest}`;
}

export interface Node {
  token: Token;
  children: Node[];
}

export function rawOf(t: Token): string {
  if (t.kind === 'blank') return '';
  return 'raw' in t ? t.raw : '';
}


/** Leading-space count of a rendered line. */
function leadingSpaces(line: string): number {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

export function stripTrailingColon(rest: string): string {
  const r = rest.trimEnd();
  return r.endsWith(':') ? r.slice(0, -1).trimEnd() : r;
}

export function restOf(t: Token): string {
  return 'rest' in t ? t.rest.trim() : '';
}

/**
 * Split a block's children into its signature arguments (declared in
 * DEFINITION_ARGS for the block keyword) and its body. Returns the rendered
 * inline signature suffix (e.g. ` — by \`alice\`, full context`) and the
 * remaining body nodes. Generic: a block with no declared args yields an empty
 * signature and its children unchanged.
 */
export function splitArgs(blockKeyword: string, children: Node[]): { signature: string; body: Node[]; args: Map<string, string> } {
  const specs = definitionArgsFor(blockKeyword);
  const argValue = new Map<string, string>();
  if (specs.length === 0) return { signature: '', body: children, args: argValue };

  const body: Node[] = [];
  for (const c of children) {
    const kw = c.token.kind === 'keyword' ? (c.token.keyword as string) : null;
    if (kw && c.children.length === 0 && specs.some(s => s.keyword === kw) && !argValue.has(kw)) {
      argValue.set(kw, restOf(c.token));
    } else {
      body.push(c);
    }
  }

  const frags = specs.filter(s => argValue.has(s.keyword)).map(s => s.inline(argValue.get(s.keyword)!));
  return { signature: frags.length ? ` — ${frags.join(', ')}` : '', body, args: argValue };
}

/**
 * Build the indent tree. Blanks inherit the indentation of the next non-blank
 * token so they sit as siblings at the right level (and thus break a grouped
 * run exactly as the flat pipeline did). A node is pushed as a potential parent
 * for any strictly-or-equally deeper following token; `>=` makes same-indent
 * tokens siblings.
 */
export function buildTree(tokens: Token[]): Node[] {
  const eff = new Array<number>(tokens.length);
  let nextIndent = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].kind === 'blank') eff[i] = nextIndent;
    else { eff[i] = tokens[i].indent; nextIndent = tokens[i].indent; }
  }

  const root: Node = { token: null as unknown as Token, children: [] };
  const stack: { node: Node; indent: number }[] = [{ node: root, indent: -1 }];

  tokens.forEach((t, i) => {
    const ind = eff[i];
    while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
    const node: Node = { token: t, children: [] };
    stack[stack.length - 1].node.children.push(node);
    if (t.kind !== 'blank') stack.push({ node, indent: ind });
  });

  return root.children;
}

/** Shift every non-blank line from base indent `from` to base indent `to`. */
function reindent(lines: string[], from: number, to: number): string[] {
  const delta = to - from;
  if (delta === 0) return lines;
  return lines.map(l => {
    if (l.trim() === '') return '';
    if (delta > 0) return ' '.repeat(delta) + l;
    return l.slice(Math.min(-delta, leadingSpaces(l)));
  });
}

/** Min indentation among non-blank lines (0 when none). */
function minIndent(lines: string[]): number {
  const indents = lines.filter(l => l.trim() !== '').map(leadingSpaces);
  return indents.length ? Math.min(...indents) : 0;
}

/** Render a maximal run of leaf nodes through the existing flat primitive passes. */
function renderLeafRun(nodes: Node[], ctx?: BundleContext): string[] {
  const text = nodes.map(n => rawOf(n.token)).join('\n');
  const rendered = applyEnumPrimitives(applyForceLevels(text, ctx), ctx);
  return rendered.split('\n');
}

export function isStructural(t: Token, hasChildren: boolean): boolean {
  // Any node with an indented body is structural — even prose or an `unknown`
  // token (e.g. `ON-INVOKE:` which the lexer classifies as
  // unknown): its children must be recursed, not dropped.
  if (hasChildren) return true;
  if (t.kind !== 'keyword') return false;
  const kw = t.keyword as string;
  return !!sequencePrimitiveFor(kw) || kw === 'PARALLEL' || !!CONTROL_HEADS[kw];
}

/** `by`: the BY agent of the flow step being rendered — who checks a checked condition in it. */
function renderNodes(nodes: Node[], ctx: BundleContext | undefined, ordered: boolean, by?: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < nodes.length) {
    const n = nodes[i];
    const t = n.token;

    // Non-structural leaf or prose: gather the maximal run and flat-render it,
    // so consecutive same-keyword grouping is identical to the prior pipeline.
    if (!isStructural(t, n.children.length > 0)) {
      const run: Node[] = [];
      while (i < nodes.length && !isStructural(nodes[i].token, nodes[i].children.length > 0)) {
        run.push(nodes[i]); i++;
      }
      out.push(...renderLeafRun(run, ctx));
      continue;
    }

    // Non-keyword node that is structural only because it has a body (prose or
    // `unknown` token): emit its head verbatim, then recurse the body at its
    // own indent. The remaining branches need `t` narrowed to a keyword token.
    if (t.kind !== 'keyword') {
      out.push(rawOf(t));
      out.push(...renderNodes(n.children, ctx, ordered, by));
      i++;
      continue;
    }
    const kw = t.keyword as string;
    const S = t.indent;

    // Sequence block (STEP): collapse consecutive siblings into a list.
    const seq = sequencePrimitiveFor(kw);
    if (seq) {
      const run: Node[] = [];
      while (i < nodes.length && nodes[i].token.kind === 'keyword' && (nodes[i].token as { keyword: string }).keyword === kw) {
        run.push(nodes[i]); i++;
      }
      out.push(`${' '.repeat(S)}${seq.header}:`);
      run.forEach((item, idx) => {
        const marker = ordered ? `${idx + 1}. ` : '- ';
        const label = stripTrailingColon('rest' in item.token ? item.token.rest : '');
        const { signature, body, args } = splitArgs(kw, item.children);
        out.push(`${' '.repeat(S)}${marker}${label}${signature}`);
        if (body.length) {
          const stepBy = args.get('BY');
          const lines = renderNodes(body, ctx, true, stepBy ? stripTrailingColon(stepBy).trim() : undefined);
          out.push(...reindent(lines, minIndent(lines), S + marker.length));
        }
      });
      continue;
    }

    // PARALLEL container: its STEP children render as an unordered list.
    if (kw === 'PARALLEL') {
      out.push(`${' '.repeat(S)}In parallel:`);
      const body = renderNodes(n.children, ctx, false);
      out.push(...reindent(body, minIndent(body), S));
      i++;
      continue;
    }

    // Control head (IF/ELSE/UNTIL): render head, recurse body at its own indent.
    if (CONTROL_HEADS[kw]) {
      out.push(`${' '.repeat(S)}${renderControlHead(kw, t.rest, t.level ?? 0, by, ctx)}:`);
      out.push(...renderNodes(n.children, ctx, ordered, by));
      i++;
      continue;
    }

    // `MEM <event>` with an `AS <template>` line beneath: one line, the
    // memory's shape folded in — the AS is the memory's, never the answer's.
    const memLine = memWithShape(t, n.children);
    if (memLine !== null) {
      out.push(...applyEnumPrimitives(applyForceLevels(memLine, ctx), ctx).split('\n'));
      i++;
      continue;
    }

    // Block-bearing leaf keyword (e.g. WHEN with an indented body): render its
    // head as a one-line leaf group, then recurse the body at its own indent.
    out.push(...renderLeafRun([{ token: t, children: [] }], ctx));
    out.push(...renderNodes(n.children, ctx, ordered, by));
    i++;
  }

  return out;
}

/**
 * The source line of a `MEM` head whose body is an `AS <template>` line, with
 * the shape folded into its text — the same formula the document renderer
 * uses. The AS line arrives already resolved to `` `name` (id) ``.
 */
function memWithShape(t: Token & { kind: 'keyword' }, children: Node[]): string | null {
  const kw = t.keyword as string;
  if (forceLevelBaseOf(kw) !== 'MEM') return null;
  const as = children.find(c => c.token.kind === 'keyword' && forceLevelBaseOf(c.token.keyword as string) === 'AS');
  if (!as || as.token.kind !== 'keyword') return null;
  const target = as.token.rest.trim();
  const m = /^`([^`]+)`(.*)$/.exec(target);
  const text = fill(FORMULAS.keywords.MEM.shaped, { text: stripTrailingColon(t.rest).trim(), name: m ? m[1] : target, ref: m ? m[2] : '' });
  return `${' '.repeat(t.indent)}${kw}  ${text}`;
}

/**
 * Render a body fragment. Replaces the prior `applyForceLevels → enum →
 * renderControlFlow` chain in `postProcessBody`.
 */
export function renderTree(text: string, ctx?: BundleContext): string {
  const tokens = lex(text);
  return renderNodes(buildTree(tokens), ctx, true).join('\n');
}
