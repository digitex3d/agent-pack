// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Recursive body renderer — the single, centralized pass that turns a `.ap`
 * body (after substitutions) into final markdown.
 *
 * Every construct is rendered uniformly as "a line, optionally with a recursive
 * sub-render of its children":
 *
 *   - leaf groups   (force-levels MUST/…, bullet-groups DO/DELEGATE/RUN/WHEN) and
 *                   enums (BUDGET) reuse the existing primitive renderers, so
 *                   their output is byte-identical to the prior flat pipeline;
 *   - sequence blocks (STEP, via SEQUENCE_PRIMITIVES) collapse consecutive
 *                   siblings into an ordered/unordered list whose items each
 *                   recurse into their own body;
 *   - EACH renders its head, then its delegation lines ("container forces
 *                   order");
 *   - control heads (IF/ELSE/UNTIL) render the head and recurse the body,
 *                   keeping it at its original indentation.
 *
 * The indent-tree is built once from the lexer token stream; the recursion is
 * bounded by the block contracts (STEP cannot nest STEP), so depth is shallow.
 */
import { readDecorator, decoratorPhrase } from '../decoratorUse.js';
import { lex, type Token } from '../lexer.js';
import { applyForceLevels } from '../forceLevel.js';
import { applyEnumPrimitives } from '../enumPrimitives.js';
import { sequencePrimitiveFor } from '../sequencePrimitives.js';
import { definitionArgsFor } from '../definitionArgs.js';
import type { BundleContext } from '../dispatch/types.js';
import { forceLevelBaseOf } from '../forceLevelConfig.js';
import { FORMULAS, fill, refSuffix } from '../formulas.js';
import { checkHead, condCheckOf, type CheckKind } from '../check.js';
import { apxCommand } from '../apx/paths.js';
import { executorHead, eachHead } from '../../adapters/md/phrases.js';
import { eachHeadOf } from '../vars.js';
import { WAIT_VERB, MARK_VERB, isDelegationVerb, parseDelegation, delegationText, splitHarness } from '../delegation.js';

const CONTROL_HEADS: Record<string, string> = { IF: 'If', ELSE: 'Else', UNTIL: 'Until' };

/**
 * Render a control-head line (the text before the trailing colon): `Until <condition>`.
 * A checked head (`IF!`, `IF!!`) in a flow's DELEGATE block is checked by the
 * agent it goes to, through its own apx — `condCheckOf` decides, as for the document
 * builder. Anywhere else this pass renders (a standalone file, a team's routing) no
 * executable checks it: it reads as the plain head — the source scan
 * (`checkedHeadIssues`) has warned, or failed the build of an `IF!!`.
 */
function renderControlHead(kw: string, rawRest: string, level: number, by: string | undefined, ctx: BundleContext | undefined, executor = 0): string {
  const condition = stripTrailingColon(rawRest);
  // `IF*` / `IF**`: a delegate or a program decides — the same head the document renders.
  if (executor) return executorHead(`${CONTROL_HEADS[kw]} ${condition}`, executor);
  if (kw === 'IF' || kw === 'UNTIL') {
    const { check } = condCheckOf(kw as CheckKind, level, condition, by ? { at: 'step', agent: by } : { at: 'none' }, ctx?.checks);
    // In a flow, the condition is a block of the unit that holds the flow: reached through its apx.
    if (check) return checkHead(kw as CheckKind, check, check.level === 2 ? '' : condition, apxCommand(ctx?.unitOf?.(check.agent) ?? check.agent));
  }
  const rest = condition ? ` ${condition}` : '';
  return `${CONTROL_HEADS[kw]}${rest}`;
}

export interface Node {
  token: Token;
  children: Node[];
}

export function rawOf(token: Token): string {
  if (token.kind === 'blank') return '';
  return 'raw' in token ? token.raw : '';
}


/** Leading-space count of a rendered line. */
function leadingSpaces(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

export function stripTrailingColon(rest: string): string {
  const trimmed = rest.trimEnd();
  return trimmed.endsWith(':') ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

export function restOf(token: Token): string {
  return 'rest' in token ? token.rest.trim() : '';
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
  for (const child of children) {
    const kw = child.token.kind === 'keyword' ? (child.token.keyword as string) : null;
    const spec = kw ? specs.find(candidate => candidate.keyword === kw) : undefined;
    if (kw && spec && child.children.length === 0 && !argValue.has(kw)) {
      const { value, line } = spec.split ? spec.split(restOf(child.token)) : { value: restOf(child.token), line: null };
      argValue.set(kw, value);
      // The line the argument also stands for joins the body where it was written.
      if (line) body.push({ token: { ...lex(`${' '.repeat(child.token.indent)}${line}`)[0], line: child.token.line }, children: [] });
    } else {
      body.push(child);
    }
  }

  const frags = specs.filter(spec => argValue.has(spec.keyword)).map(spec => spec.inline(argValue.get(spec.keyword)!));
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
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (tokens[index].kind === 'blank') eff[index] = nextIndent;
    else { eff[index] = tokens[index].indent; nextIndent = tokens[index].indent; }
  }

  const root: Node = { token: null as unknown as Token, children: [] };
  const stack: { node: Node; indent: number }[] = [{ node: root, indent: -1 }];

  tokens.forEach((token, index) => {
    const ind = eff[index];
    while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
    const node: Node = { token, children: [] };
    stack[stack.length - 1].node.children.push(node);
    if (token.kind !== 'blank') stack.push({ node, indent: ind });
  });

  return root.children;
}

/** Shift every non-blank line from base indent `from` to base indent `to`. */
function reindent(lines: string[], from: number, to: number): string[] {
  const delta = to - from;
  if (delta === 0) return lines;
  return lines.map(line => {
    if (line.trim() === '') return '';
    if (delta > 0) return ' '.repeat(delta) + line;
    return line.slice(Math.min(-delta, leadingSpaces(line)));
  });
}

/** Min indentation among non-blank lines (0 when none). */
function minIndent(lines: string[]): number {
  const indents = lines.filter(line => line.trim() !== '').map(leadingSpaces);
  return indents.length ? Math.min(...indents) : 0;
}

/** Render a maximal run of leaf nodes through the existing flat primitive passes. */
function renderLeafRun(nodes: Node[], ctx?: BundleContext): string[] {
  const text = nodes.map(node => delegationLine(node.token, ctx) ?? rawOf(node.token)).join('\n');
  const rendered = applyEnumPrimitives(applyForceLevels(text, ctx), ctx);
  return rendered.split('\n');
}

/**
 * A DELEGATE, FORK or WAIT line as rendered — who it goes to, with what
 * context, the way the document says it (src/delegation.ts); null for any
 * other line. Its keyword stays, for the group's intro; a block's colon too.
 */
function delegationLine(token: Token, ctx?: BundleContext): string | null {
  if (token.kind !== 'keyword') return null;
  const keyword = token.keyword as string;
  const indent = ' '.repeat(token.indent);
  if (keyword === WAIT_VERB || keyword === MARK_VERB) return `${indent}${keyword} ${delegationText({ keyword, text: token.rest })}`;
  if (!isDelegationVerb(keyword)) return null;
  const delegation = parseDelegation(keyword, token.rest);
  const template = delegation.as ? ctx?.templates.find(tp => tp.name === delegation.as!.name.replace(/`/g, '')) : undefined;
  const shaped = delegation.as ? { name: delegation.as.name.replace(/`/g, '').replace(/\s+\(.*\)$/, ''), ref: template ? refSuffix(template.refId) : '' } : undefined;
  // Its INTO stays as written: no store line follows it here.
  const other = delegation.by ? splitHarness(delegation.by) : null;
  const text = delegationText({ keyword, text: delegation.into ? `${delegation.task} INTO ${delegation.into}` : delegation.task, agent: other?.agent ?? delegation.by ?? undefined, harness: other?.harness, async: token.async, shaped,
    phrases: ctx?.renderings, ...(keyword === 'FORK' && delegation.by ? { definition: `\`${apxCommand(delegation.by, 'scope')}\`` } : {}) });
  return `${indent}${keyword} ${text}${delegation.opens ? ':' : ''}`;
}

/** A decorator line as rendered — its sentence, each block it names with its id (src/decoratorUse.ts, shared with the builder). */
function decoratorLine(token: Token & { kind: 'decorator' }, ctx?: BundleContext): string {
  const read = ctx ? readDecorator(token, ctx) : null;
  const phrase = read
    ? decoratorPhrase(read.spec, read.uses.map(use => ({ kind: use.kind, name: use.name, ref: refSuffix(use.refId) })),
      read.template ? { name: read.template.name, ref: refSuffix(read.template.refId) } : undefined)
    : token.raw.trim().replace(/:$/, '');
  return `${' '.repeat(token.indent)}${phrase}:`;
}

export function isStructural(token: Token, hasChildren: boolean): boolean {
  // Any node with an indented body is structural — even prose or an `unknown`
  // token (e.g. `ON-INVOKE:` which the lexer classifies as
  // unknown): its children must be recursed, not dropped.
  if (hasChildren) return true;
  // A decorator stands for the block below it, never in a run of lines (src/decorators.ts).
  if (token.kind === 'decorator') return true;
  if (token.kind !== 'keyword') return false;
  const kw = token.keyword as string;
  return !!sequencePrimitiveFor(kw) || (kw === 'EACH' && !!eachHeadOf(token.rest)) || !!CONTROL_HEADS[kw];
}

/** `by`: the agent of the DELEGATE block being rendered — who checks a checked condition in it. */
function renderNodes(nodes: Node[], ctx: BundleContext | undefined, ordered: boolean, by?: string): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    const token = node.token;

    // Non-structural leaf or prose: gather the maximal run and flat-render it,
    // so consecutive same-keyword grouping is identical to the prior pipeline.
    if (!isStructural(token, node.children.length > 0)) {
      const run: Node[] = [];
      while (index < nodes.length && !isStructural(nodes[index].token, nodes[index].children.length > 0)) {
        run.push(nodes[index]); index++;
      }
      out.push(...renderLeafRun(run, ctx));
      continue;
    }

    // A decorator: its sentence, then the lines it opens — above a block, the block follows as written.
    if (token.kind === 'decorator') {
      out.push(decoratorLine(token, ctx));
      out.push(...renderNodes(node.children, ctx, ordered, by));
      index++;
      continue;
    }

    // Non-keyword node that is structural only because it has a body (prose or
    // `unknown` token): emit its head verbatim, then recurse the body at its
    // own indent. The remaining branches need `token` narrowed to a keyword token.
    if (token.kind !== 'keyword') {
      out.push(rawOf(token));
      out.push(...renderNodes(node.children, ctx, ordered, by));
      index++;
      continue;
    }
    const kw = token.keyword as string;
    const baseIndent = token.indent;

    // Sequence block (STEP): collapse consecutive siblings into a list.
    const seq = sequencePrimitiveFor(kw);
    if (seq) {
      const run: Node[] = [];
      while (index < nodes.length && nodes[index].token.kind === 'keyword' && (nodes[index].token as { keyword: string }).keyword === kw) {
        run.push(nodes[index]); index++;
      }
      out.push(`${' '.repeat(baseIndent)}${seq.header}:`);
      run.forEach((item, idx) => {
        const marker = ordered ? `${idx + 1}. ` : '- ';
        const label = stripTrailingColon('rest' in item.token ? item.token.rest : '');
        out.push(`${' '.repeat(baseIndent)}${marker}${label}`);
        if (item.children.length) {
          const lines = renderNodes(item.children, ctx, true);
          out.push(...reindent(lines, minIndent(lines), baseIndent + marker.length));
        }
      });
      continue;
    }

    // EACH block: its head says how the runs go; its delegation lines render as any. The list's read resolves with the flow's reads.
    const each = kw === 'EACH' ? eachHeadOf(token.rest) : null;
    if (each) {
      const waited = node.children.some(child => child.token.kind === 'keyword' && isDelegationVerb(child.token.keyword as string) && !child.token.async);
      out.push(`${' '.repeat(baseIndent)}${eachHead(each, waited)}`);
      out.push(...renderNodes(node.children, ctx, ordered, by));
      index++;
      continue;
    }

    // Control head (IF/ELSE/UNTIL): render head, recurse body at its own indent.
    if (CONTROL_HEADS[kw]) {
      out.push(`${' '.repeat(baseIndent)}${renderControlHead(kw, token.rest, token.level ?? 0, by, ctx, token.executor ?? 0)}:`);
      out.push(...renderNodes(node.children, ctx, ordered, by));
      index++;
      continue;
    }

    // `MEM <event>` with an `AS <template>` line beneath: one line, the
    // memory's shape folded in — the AS is the memory's, never the answer's.
    const memLine = memWithShape(token, node.children);
    if (memLine !== null) {
      out.push(...applyEnumPrimitives(applyForceLevels(memLine, ctx), ctx).split('\n'));
      index++;
      continue;
    }

    // Block-bearing leaf keyword (e.g. WHEN with an indented body): render its
    // head as a one-line leaf group, then recurse the body at its own indent —
    // a DELEGATE block's under the agent it goes to, who checks its conditions.
    out.push(...renderLeafRun([{ token, children: [] }], ctx));
    const delegated = isDelegationVerb(kw) ? parseDelegation(kw, token.rest).by ?? undefined : by;
    out.push(...renderNodes(node.children, ctx, ordered, delegated));
    index++;
  }

  return out;
}

/**
 * The source line of a `MEM` head whose body is an `AS <template>` line, with
 * the shape folded into its text — the same formula the document renderer
 * uses. The AS line arrives already resolved to `` `name` (id) ``.
 */
function memWithShape(token: Token & { kind: 'keyword' }, children: Node[]): string | null {
  const kw = token.keyword as string;
  if (forceLevelBaseOf(kw) !== 'MEM') return null;
  const as = children.find(child => child.token.kind === 'keyword' && forceLevelBaseOf(child.token.keyword as string) === 'AS');
  if (!as || as.token.kind !== 'keyword') return null;
  const target = as.token.rest.trim();
  const match = /^`([^`]+)`(.*)$/.exec(target);
  const text = fill(FORMULAS.keywords.AS.shaped, { text: stripTrailingColon(token.rest).trim(), name: match ? match[1] : target, ref: match ? match[2] : '' });
  return `${' '.repeat(token.indent)}${kw}  ${text}`;
}

/**
 * Render a body fragment. Replaces the prior `applyForceLevels → enum →
 * renderControlFlow` chain in `postProcessBody`.
 */
export function renderTree(text: string, ctx?: BundleContext): string {
  const tokens = lex(text);
  return renderNodes(buildTree(tokens), ctx, true).join('\n');
}
