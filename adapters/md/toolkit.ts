// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Md rendering toolkit — node-level primitives of the md ADAPTER backend.
 *
 * Generic over nodes (the prose twin of measure): the blocks' `asMdBody`
 * hooks call `renderNodes`; the document-level composition lives in
 * adapters/md/index.ts (`renderMd`). `MdEnv` is what rendering needs from
 * the document — the md twin of BlockCx.
 */
import { renderKeywordBlock } from '../../src/services/text.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import { FORCE_LEVEL_PRIMITIVES } from '../../src/primitives.js';
import type { ApNode, ApRef, ApShape, ApSlotType } from '../../src/apdoc/types.js';
import type { StepNode } from '../../src/apdoc/nodes.js';
import { executorKey, verbRank } from '../../src/executor.js';
import {
  stepsHeader, refName, runLine, unresolvedRun, SHAPE_INTRO_FALLBACK,
  rangePhrase, textTypePhrase, numberTypePhrase, enumTypePhrase,
  shapeRefPhrase as shapeRefPhraseOf, listTypePhrase,
  minWordsHint, maxWordsHint, regexHint, varCommand,
} from './phrases.js';

export interface MdEnv {
  /** Resolved force-level intros: family → level (string) → phrase. */
  forceLevels: Record<string, Record<string, string>>;
  /** The reference suffix of a block address in this projection (md ` (tpl-…)`), '' when unknown. */
  refOf(target: string): string;
  /** `{{var}}` → value — the body substitution. */
  substitute(text: string): string;
  /** The command that launches an agent's apx (null = the document's own agent). */
  apxOf(agent: string | null): string;
  /** The document's own agent. */
  agent: string;
  /** The agent an ASK without BY is handed to (`meta.delegate`). */
  delegate?: string;
  /** A procedure carried out by a delegate or a program: its contract id and executor — else undefined. */
  exeOf?(target: string): { exe: string; executor: number } | undefined;
  /** An UNTIL condition's contract: the rounds its loop runs at most — else undefined. */
  roundsOf?(exe: string): number | undefined;
}

/** Bullet-group primitives by keyword (DO, BY, WHEN, LOG, …) — RUN excluded. */
const BULLETS = new Map(FORCE_LEVEL_PRIMITIVES.filter(p => p.keyword !== 'RUN').map(p => [p.keyword, p]));

/** The force intro of (keyword, force), or null for plain bullet keywords. */
export function forceIntro(env: MdEnv, keyword: string, force: number | null): string | null {
  if (force === null) return null;
  return env.forceLevels[keyword]?.[String(force)] ?? null;
}

/** `AS`-family binding line: calibrated intro + `name` + its reference. */
export function shapeLine(env: MdEnv, shape: ApShape): string {
  const intro = env.forceLevels['AS']?.[String(shape.force)] ?? SHAPE_INTRO_FALLBACK;
  return fill(FORMULAS.keywords.AS.line, { intro, name: refName(shape.ref), ref: env.refOf(shape.ref.target) });
}

/**
 * How the result of a step is stored in a variable: through the apx,
 * the value on stdin — as JSON with the fields of its template when the
 * variable is typed (the shape line above names it; the apx refuses a value
 * outside it).
 */
export function storeVarLine(env: MdEnv, ref: ApRef, typed: boolean): string {
  const V = FORMULAS.keywords.VAR;
  const name = refName(ref);
  return fill(typed ? V.storeTyped : V.store, { name, command: varCommand(env.apxOf(null), 'set', name) });
}

/** One RUN line, resolved or not — formulations from phrases. */
function runNodeLine(env: MdEnv, ref: ApRef): string {
  if (ref.resolved === false) return unresolvedRun(ref.target);
  return runLine(ref.kind, refName(ref), env.refOf(ref.target));
}

/**
 * A RUN whose result fills a variable (`RUN p INTO x`, or the lone RUN of a
 * `VAR x:`). A procedure a delegate or a program carries out: `answer` / `run`
 * with `--into` stores the result — no `set` to tell. Else the agent stores it.
 */
export function runIntoLines(env: MdEnv, ref: ApRef, into: ApRef, shape: ApShape | undefined, indent: number): string[] {
  const how = ref.resolved === false ? undefined : env.exeOf?.(ref.target);
  const name = refName(into);
  if (how) {
    const how2 = FORMULAS.keywords.EXECUTOR.into[executorKey(how.executor)];
    return indentLines([runNodeLine(env, ref) + fill(how2, { apx: env.apxOf(null), id: how.exe, name })], indent);
  }
  return [
    ...indentLines([runNodeLine(env, ref)], indent),
    ...indentLines([...(shape ? [shapeLine(env, shape)] : []), storeVarLine(env, into, !!shape)], indent + 2),
  ];
}

export function indentLines(lines: string[], indent: number): string[] {
  if (indent === 0) return lines;
  const pad = ' '.repeat(indent);
  return lines.map(l => (l === '' ? '' : pad + l));
}

/**
 * How the agent gets a piece carried out by its contract (`exe-…`): a delegate's —
 * hand its input over and store its answer; a program's — run it. '' with no contract.
 */
export function executorHow(env: MdEnv | undefined, exe: string | undefined, executor: number): string {
  if (!env || !exe) return '';
  const E = FORMULAS.keywords.EXECUTOR;
  return fill(executorKey(executor) === '2' ? E.run : E.ask, { apx: env.apxOf(null), id: exe });
}

/**
 * A directive's text as rendered — an `ASK … BY <agent>` line names the agent it
 * is handed to, and a line with a contract says how to have it carried out.
 */
export function directiveText(n: { text: string; by?: string; keyword?: string; exe?: string }, env?: MdEnv): string {
  // An ASK without BY goes to the default delegate: the prompt names it.
  const by = n.by ?? (n.keyword === 'ASK' && n.exe ? env?.delegate : undefined);
  const text = by ? fill(FORMULAS.keywords.ASK.by, { text: n.text, agent: by }) : n.text;
  return text + executorHow(env, n.exe, verbRank(n.keyword ?? '') ?? 1);
}

/** Render a run of same-keyword directives — grouped exactly like the flat pipeline. */
export function renderDirectiveGroup(env: MdEnv, keyword: string, force: number | null, texts: string[]): string[] {
  const substituted = texts.map(t => env.substitute(t));
  const intro = forceIntro(env, keyword, force);
  if (intro !== null) return renderKeywordBlock(intro, substituted).split('\n');
  const bullet = BULLETS.get(keyword);
  if (bullet) return bullet.renderNeutral(substituted).trimEnd().split('\n');
  // Unknown keyword — emit raw-ish (keyword + text), matching pass-through.
  return substituted.map(t => `${keyword} ${t}`);
}

/**
 * Nodes → md lines, mirroring the legacy renderTree walk: maximal runs of
 * same-keyword directives group; control heads recurse at +2 indent.
 */
export function renderNodes(env: MdEnv, nodes: ApNode[], ordered = true): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];

    if (n.type === 'directive' && !n.body && !n.into) {
      const texts: string[] = [];
      const { keyword, force } = n;
      const indent = n.indent ?? 0;
      while (i < nodes.length) {
        const c = nodes[i];
        if (c.type !== 'directive' || c.body || c.into || c.keyword !== keyword || c.force !== force || (c.indent ?? 0) !== indent) break;
        texts.push(c.shape ? fill(FORMULAS.keywords.AS.shaped, { text: c.text, name: refName(c.shape.ref), ref: env.refOf(c.shape.ref.target) }) : directiveText(c, env));
        i++;
      }
      out.push(...indentLines(renderDirectiveGroup(env, keyword, force, texts), indent));
      continue;
    }

    if (n.type === 'run' && !n.into) {
      const lines: string[] = [];
      const indent = n.indent ?? 0;
      while (i < nodes.length && nodes[i].type === 'run' && !(nodes[i] as { into?: ApRef }).into) {
        lines.push(runNodeLine(env, (nodes[i] as { ref: ApRef }).ref));
        i++;
      }
      out.push(...indentLines(lines, indent));
      continue;
    }

    // A run of consecutive steps renders as ONE list — a cross-node concern,
    // so the sequence renderer opens the list and asks each step for its item.
    if (n.type === 'step') {
      out.push(stepsHeader());
      let idx = 0;
      while (i < nodes.length && nodes[i].type === 'step') {
        out.push(...(nodes[i] as StepNode).asMdItem(env, idx, ordered));
        idx++;
        i++;
      }
      continue;
    }

    // Every other node renders itself — the node classes own their md.
    out.push(...(n as unknown as { asMdLines(e: MdEnv, o: boolean): string[] }).asMdLines(env, ordered));
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slot type phrases — mirror of shapeCompiler's typeToPhrase, sourced from the
// resolved ApSlotType (the document is the input, never the .ap source).
// ---------------------------------------------------------------------------

/** The human phrase of a slot type; shape refs resolve to **name** (id). */
export function slotTypePhrase(env: MdEnv, type: ApSlotType): string {
  switch (type.kind) {
    case 'text': {
      const hints: string[] = [];
      if (type.minWords !== undefined) hints.push(minWordsHint(type.minWords));
      if (type.maxWords !== undefined) hints.push(maxWordsHint(type.maxWords));
      if (type.regex !== undefined) hints.push(regexHint(type.regex));
      return textTypePhrase(hints);
    }
    case 'number':
      return numberTypePhrase(rangePhrase(type.min, type.max));
    case 'enum':
      return enumTypePhrase(type.values);
    case 'shape':
      return refPhrase(env, type.ref);
    case 'list':
      return listTypePhrase(refPhrase(env, type.ref), rangePhrase(type.min, type.max));
    case 'any':
      return type.raw;
  }
}

/** A template reference inside a slot type — mirror of resolveShapeRefs. */
function refPhrase(env: MdEnv, ref: ApRef): string {
  return shapeRefPhraseOf(refName(ref), env.refOf(ref.target));
}
