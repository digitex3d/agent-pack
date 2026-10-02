// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The md backend's formulation helpers — every one a thin fill of a formula
 * from src/config/formulas.json (FORMULAS), the single source of md prose.
 * No module of the md backend types prose: it asks one of these, and these
 * ask the table.
 */
import { FORMULAS, fill, qualified } from '../../src/formulas.js';
import type { ApRef } from '../../src/apdoc/types.js';

const K = FORMULAS.keywords;
const T = FORMULAS.blocks.template;
const S = FORMULAS.blocks.store;
const TY = FORMULAS.types;

/** Head label of a control keyword (`If`, `Else`, `Until`, `In parallel`). */
export function controlHead(keyword: string): string {
  return (K as Record<string, { head?: string }>)[keyword]?.head ?? keyword;
}

/** The STEP list header (`Steps:`). */
export function stepsHeader(): string {
  return `${K.STEP.list}:`;
}

/** A STEP's inline signature (` — by \`x\`, full context`), in the order the formulas declare. */
export function stepSignature(args: ReadonlyMap<string, string>): string {
  const frags = K.STEP.args
    .filter(a => args.has(a.keyword))
    .map(a => fill(a.formula, { value: args.get(a.keyword)! }));
  return frags.length ? fill(K.STEP.signature, { args: frags.join(', ') }) : '';
}

/** The short name a Ref renders with. */
export function refName(ref: ApRef): string {
  return ref.target.split('/').pop() ?? ref.target;
}

/** A resolved RUN line. */
export function runLine(kind: string, name: string, ref: string): string {
  return fill(K.RUN.line, { kind, name, ref });
}

/** An unresolved RUN marker. */
export function unresolvedRun(target: string): string {
  return fill(K.RUN.unresolved, { target });
}

/** Fallback shape intro when the force table lacks the level. */
export const SHAPE_INTRO_FALLBACK = K.AS.fallback;


/** The LENS-IN contract line, right after Identity. */
export function lensInLine(name: string, ref: string): string {
  return fill(K['LENS-IN'].line, { name, ref });
}

/** The LENS-IN → LENS-OUT bridge line. */
export function lensBridgeLine(name: string, ref: string): string {
  return fill(K['LENS-OUT'].bridge, { name, ref });
}


// --------------------------------------------------------------- templates

/** The template scaffold opener. */
export function templateScaffoldIntro(name: string): string {
  return fill(T.scaffold, { name });
}

export const FIELDS_LABEL = T.fields;

/**
 * The head of an `IN <store>:` block — the steps beneath it work in that store.
 * Carries the store's reference so the agent can jump to its commands
 * instead of holding them in mind. An unresolved store is called out the way
 * an unresolved RUN is: nobody is left thinking the table exists.
 */
export const storeScopeLine = (env: { refOf(target: string): string }, store: ApRef): string =>
  store.resolved === false
    ? fill(K.IN.unresolved, { head: K.IN.head, name: refName(store) })
    : fill(K.IN.store, { head: K.IN.head, name: refName(store), ref: env.refOf(store.target) });

/** The apx command that reads a variable (`get`), or stores it with the value on stdin (`set`). */
export const varCommand = (apx: string, verb: 'get' | 'set', name: string): string =>
  verb === 'get' ? `${apx} get ${name}` : `${apx} set ${name} -`;

/** The head of a `VAR <name>:` block — the lines beneath work out its value. */
export const varBlockHead = (name: string): string => fill(K.VAR.block, { name });

/** Where a store's data lives, and whether it outlives the session. */
export const storeHomeLine = (file: string, lasts: string): string =>
  fill(S.home, { file, lasts: lasts === 'project' ? S.lasts.project : S.lasts.session });

/** Label above the concrete commands a store's type renders. */
export const storeUsageLabel = (typeName: string): string => fill(S.usage, { type: typeName });

/** A slot this store's backing cannot represent — a nested bullet under the field. */
export const storeRejectLine = (typeName: string, reason: string): string =>
  fill(S.reject, { type: typeName, reason });

/** A store whose TYPE resolves to nothing registered. */
export const storeUnknownTypeLine = (name: string, declared: string, available: string[]): string =>
  fill(S.unknownType, { name, declared: declared || S.noType, available: available.join(', ') });

export const OPTIONAL_MARK = T.optional;
export const EXAMPLE_OPEN = T.exampleOpen;
export const EXAMPLE_CLOSE = T.exampleClose;

/** A scalar template line. */
export function scalarTemplateLine(name: string, typePhrase: string, description?: string): string {
  return fill(T.scalar, { name, type: typePhrase, description: description ? fill(T.description, { description }) : '' });
}

// -------------------------------------------------------------- slot types

/** Numeric range phrase (`0–100`, `≥2`, `≤5`). */
export function rangePhrase(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return fill(TY.range, { min, max });
  if (min !== undefined) return fill(TY.atLeast, { min });
  if (max !== undefined) return fill(TY.atMost, { max });
  return '';
}

export function textTypePhrase(hints: string[]): string {
  return qualified(TY.text, hints);
}

export function numberTypePhrase(range: string): string {
  return qualified(TY.number, range ? [range] : []);
}

export function enumTypePhrase(values: string[]): string {
  return fill(TY.enum, { values: values.join(', ') });
}

export function shapeRefPhrase(name: string, ref: string): string {
  return fill(TY.shape, { name, ref });
}

export function listTypePhrase(refPhrase: string, cardinality: string): string {
  return qualified(fill(TY.list, { ref: refPhrase }), cardinality ? [cardinality] : []);
}

export function minWordsHint(n: number): string { return fill(TY.minWords, { n }); }
export function maxWordsHint(n: number): string { return fill(TY.maxWords, { n }); }
export function regexHint(source: string): string { return fill(TY.regex, { source }); }
