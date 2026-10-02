// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Formulas — THE single source of every fixed prose formulation of the md
 * projection (config/formulas.json), keyed by the construct that owns it.
 *
 * Renderers never type prose: they pick the formula of the construct they are
 * rendering and `fill` it with that construct's data. Data in config,
 * imported (so it travels inside the apx engine bundle) and validated once.
 */
import FORMULAS_JSON from './config/formulas.json' with { type: 'json' };

type Text = string;

/** One entry-quiz question on a block kind: multiple choice, `right` is the letter. */
export interface QuizQuestion { ask: Text; options: Text[]; right: string }

/** How a block kind is used: its introduction (`.ap` lines) and its entry quiz. */
export interface KindGuide { intro: Text[]; quiz: QuizQuestion[] }

export interface Formulas {
  keywords: {
    IF: { head: Text };
    ELSE: { head: Text };
    UNTIL: { head: Text };
    WHEN: { head: Text };
    PARALLEL: { head: Text };
    IN: { head: Text; store: Text; unresolved: Text };
    /** `args` is a list: the order the signature fragments read in is data too. */
    STEP: { head: Text; list: Text; signature: Text; args: { keyword: string; formula: Text }[] };
    RUN: { line: Text; flow: Text; unresolved: Text; bare: Text; sequence: Text; name: Text };
    DO: { intro: Text };
    BY: { intro: Text; inline: Text };
    AS: { fallback: Text; line: Text; agent: Text };
    OWNS: { fence: Text[]; glob: Text };
    'LENS-IN': { line: Text; input: Text };
    'LENS-OUT': { bridge: Text };
    MANDATE: { line: Text };
    MEM: { shaped: Text };
    VAR: { read: Text; block: Text; store: Text; storeTyped: Text; about: Text; scopes: Record<'private' | 'session', Text>; typed: Text; entry: Text };
    DISTILL: { use: Text; write: Text; shape: Text; input: Text; output: Text };
  };
  blocks: {
    agent: { identity: Text; role: Text; roleAbout: Text; roleExpertise: Text; roleAboutExpertise: Text; expertise: Text } & KindGuide;
    policy: { chapter: Text } & KindGuide;
    role: { chapter: Text } & KindGuide;
    template: {
      chapter: Text; scaffold: Text; layoutSlot: Text; layoutSeparator: Text; fields: Text; field: Text;
      optional: Text; description: Text; rule: Text; exampleOpen: Text; exampleClose: Text; scalar: Text;
    } & KindGuide;
    procedure: { chapter: Text } & KindGuide;
    flow: { chapter: Text } & KindGuide;
    store: {
      chapter: Text; home: Text; lasts: Record<'project' | 'session', Text>; field: Text; key: Text;
      reject: Text; create: Text; usage: Text; noType: Text; unknownType: Text;
    } & KindGuide;
    team: { heading: Text; member: Text; handles: Text; fellows: Text; fellow: Text; undescribed: Text; closing: Text } & KindGuide;
    runtime: { heading: Text };
    tool: { chapter: Text; heading: Text } & KindGuide;
  };
  types: {
    qualified: Text; text: Text; minWords: Text; maxWords: Text; regex: Text; number: Text;
    range: Text; atLeast: Text; atMost: Text; enum: Text; shape: Text; list: Text;
    storeShape: Text; storeList: Text;
  };
  document: {
    ref: Text; heading: Text; entry: Text; about: Text;
    crossReferences: { chapter: Text; row: Text; entry: Text };
  };
}

/** Every leaf must be a non-empty string (or a list of them): drift fails loud at load. */
function validate(node: unknown, path: string): void {
  if (typeof node === 'string') {
    if (node.length === 0) throw new Error(`formulas.json: ${path} is empty`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) throw new Error(`formulas.json: ${path} is an empty list`);
    node.forEach((n, i) => validate(n, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (k !== '$comment') validate(v, path ? `${path}.${k}` : k);
    return;
  }
  throw new Error(`formulas.json: ${path} is not text`);
}

// A copy: the imported module object is shared, and `$comment` is dropped below.
const RAW = structuredClone(FORMULAS_JSON) as unknown as Formulas & { $comment?: string };
validate(RAW, '');
delete RAW.$comment;

export const FORMULAS: Formulas = RAW;

/**
 * Fill a formula: `{key}` becomes `values[key]`. A placeholder with no value
 * stays as written — that is how literal braces in prose (`{slot}`) survive.
 */
export function fill(formula: string, values: Record<string, string | number> = {}): string {
  return formula.replace(/\{([A-Za-z]+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/**
 * The one form a reference takes in the `.md` projection: ` (tpl-d82fd6de)` —
 * the block id — or '' when the target has none. Every reference in the md is
 * built through this function; other projections (the apx) pass their own.
 */
export function refSuffix(id: string | null | undefined): string {
  return id ? fill(FORMULAS.document.ref, { id }) : '';
}

/**
 * The introduction of a block kind — how to use that kind — as `.ap` lines
 * joined into source, or '' for a kind without one. Every projection opens a
 * kind with this text: the md chapter intro, the apx quiz remedy.
 */
export function introOf(kind: string): string {
  const guide = (FORMULAS.blocks as unknown as Record<string, Partial<KindGuide>>)[kind];
  return guide?.intro?.join('\n') ?? '';
}

/** The deepest heading level: markdown has six. Deeper requests are capped. */
export const MAX_HEADING_DEPTH = 6;

/** A heading line, as every heading of every projection reads: `## Title`. */
export function headingLine(depth: number, title: string): string {
  return fill(FORMULAS.document.heading, { hashes: '#'.repeat(Math.min(depth, MAX_HEADING_DEPTH)), title });
}

/** `{base} ({detail})` when there is a detail, the base alone otherwise. */
export function qualified(base: string, details: string[]): string {
  return details.length ? fill(FORMULAS.types.qualified, { base, detail: details.join(', ') }) : base;
}
