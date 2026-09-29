// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Template renderer — the v3 `SLOTS` / `BODY` / `EXAMPLE` contract for TEMPLATE
 * bodies. A TEMPLATE describes a typed record — the single shape primitive:
 * an agent binds its response shape via the `AS` operator.
 *
 * This is PARSE + RENDER only: there is NO validation and NO constraint
 * enforcement (an MCP tool validates `strict` templates later). Constraints
 * (MAX_WORDS, REGEX, number ranges, enum values) are rendered as guidance text.
 *
 * The rendered block is research-backed for Claude consumers: the literal
 * `BODY` layout the model must emit, a self-documenting field legend, and the
 * `EXAMPLE` wrapped in `<example>` tags (Anthropic's few-shot technique).
 *
 * Grammar:
 *
 *   TEMPLATE problem-line
 *     SLOTS:
 *       name:        TEXT MAX_WORDS 3    "short label"
 *       severity:    NUMBER 0..100       "severity score"
 *       fixes:       LIST <fix>          "suggested fixes"
 *     BODY:
 *       {name} | {severity}
 *     EXAMPLE:
 *       missing meta description | 70
 *
 *   scalar shorthand:  TEMPLATE role-name: TEXT REGEX /^[a-z-]+$/ "kebab id"
 *
 * Types: TEXT [MAX_WORDS n | MIN_WORDS n | REGEX /p/] · NUMBER n..m / >=n / <=n
 *        · ENUM[a b c] · <template> · LIST <template> [range].
 * `<template>` / `LIST <template>` emit an internal `@shape(slug)` marker that
 * `resolveShapeRefs` turns into `(id)` after emission — reusing the `AS` path.
 */

import { refSuffix } from './formulas.js';
import { markVerbatim } from "./services/text.js";
import { getIntroByKeyword, getAliasNames, aliasToCanonical } from './forceLevelConfig.js';

export interface Range {
  min?: number;
  max?: number;
}

export interface Slot {
  name: string;
  optional: boolean;
  /** Human render phrase; may contain an `@shape(slug)` marker for refs. */
  typePhrase: string;
  /**
   * The TYPE expression as written in source (e.g. `ENUM[a b]`, `TEXT MAX_WORDS 3`).
   * Machine-parseable counterpart of `typePhrase` — consumed by shapeSchema's
   * validator, never rendered.
   */
  rawType: string;
  description?: string;
  /** Slot-scoped rules, already rendered with their calibrated force-level intro. */
  rules: string[];
  /**
   * The same rules pre-render: source keyword (may be an alias like NEVER) +
   * rule text. Additive — consumed by the DocumentBuilder (TemplateBlock
   * structures them as typed directives), ignored by every renderer.
   */
  rawRules?: { keyword: string; text: string }[];
}

export interface ParsedTemplate {
  slots: Slot[];
  bodyLayout: string | null;
  example: string | null;
  /** Set for the scalar shorthand (a single typed value, no SLOTS). */
  scalar: { typePhrase: string; description?: string } | null;
}

/** Internal marker for `<tpl>` / `LIST <tpl>`; resolved to `(id)` post-emit. */
const SHAPE_REF_RE = /@shape\(([a-z][a-z0-9_-]*)\)/g;
const REGION_RE = /^(\s*)(SLOTS|BODY|EXAMPLE):\s*$/;
/** Author-facing marker in an EXAMPLE body composing another template's EXAMPLE verbatim. */
const EXAMPLE_REF_RE = /\{([a-z][a-z0-9_-]*)\.EXAMPLE\}/g;

// ---------------------------------------------------------------------------
// Type → human phrase (no validation; unknown forms pass through verbatim)
// ---------------------------------------------------------------------------

function formatRange(s: string): string {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+)\.\.(\d+)/))) return `${m[1]}–${m[2]}`;
  if ((m = s.match(/^>=\s*(\d+)/))) return `≥${m[1]}`;
  if ((m = s.match(/^<=\s*(\d+)/))) return `≤${m[1]}`;
  return '';
}

function formatTextConstraints(s: string): string {
  const hints: string[] = [];
  let m: RegExpMatchArray | null;
  if ((m = s.match(/MIN_WORDS\s+(\d+)/i))) hints.push(`≥${m[1]} words`);
  if ((m = s.match(/MAX_WORDS\s+(\d+)/i))) hints.push(`≤${m[1]} words`);
  if ((m = s.match(/REGEX\s+(\/.*\/)/i))) hints.push(`matching ${m[1]}`);
  return hints.join(', ');
}

function typeToPhrase(typePart: string): string {
  let m: RegExpMatchArray | null;
  if ((m = typePart.match(/^LIST\s+<([a-z][a-z0-9_-]*)>\s*(.*)$/i))) {
    const card = formatRange(m[2].trim());
    return `list of @shape(${m[1]})${card ? ` (${card})` : ''}`;
  }
  if ((m = typePart.match(/^<([a-z][a-z0-9_-]*)>$/))) return `@shape(${m[1]})`;
  if ((m = typePart.match(/^ENUM\[(.*)\]$/i))) {
    const vals = m[1].trim().split(/\s+/).filter(Boolean);
    return `one of: ${vals.join(', ')}`;
  }
  if ((m = typePart.match(/^NUMBER\b\s*(.*)$/i))) {
    const r = formatRange(m[1].trim());
    return `number${r ? ` (${r})` : ''}`;
  }
  if ((m = typePart.match(/^TEXT\b\s*(.*)$/i))) {
    const hints = formatTextConstraints(m[1].trim());
    return `text${hints ? ` (${hints})` : ''}`;
  }
  return typePart; // unknown — render verbatim, no error
}

/** Whether a scalar header carries a recognized type (vs prose). */
function looksTyped(typePart: string): boolean {
  return /^(TEXT|NUMBER|ENUM|LIST|<)/i.test(typePart);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split a trailing `"description"` off a slot/scalar declaration. */
function splitDesc(rest: string): { typePart: string; desc?: string } {
  const m = rest.match(/^(.*?)\s*"([^"]*)"\s*$/);
  if (m) return { typePart: m[1].trim(), desc: m[2] || undefined };
  return { typePart: rest };
}

/** Remove the common leading indent from region lines and trim trailing space. */
function dedent(lines: string[]): string {
  const nonBlank = lines.filter(l => l.trim() !== '');
  if (nonBlank.length === 0) return '';
  const min = Math.min(...nonBlank.map(l => (l.match(/^\s*/) as RegExpMatchArray)[0].length));
  return lines.map(l => l.slice(min)).join('\n').replace(/\s+$/, '');
}

/** Calibrated intro for a force-level rule token (direct form or alias), or null. */
function ruleIntro(token: string): string | null {
  const direct = getIntroByKeyword(token);
  if (direct) return direct;
  if (getAliasNames().includes(token)) return getIntroByKeyword(aliasToCanonical(token));
  return null;
}

/**
 * Parse the SLOTS region. Two lexically disjoint line classes:
 *   - `lowercase-name[?]: TYPE …`  → a new slot declaration
 *   - `FORCE-LEVEL <rule>`         → a rule of the PRECEDING slot
 * Attachment is by ORDER + keyword class — indentation is style, not
 * semantics, so reformatting can never re-scope a rule. A rule with no slot
 * above it is a structural error and throws (loud, like an unknown AS slug).
 */
function parseSlots(lines: string[]): Slot[] {
  const out: Slot[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = t.match(/^([a-z][\w-]*)(\?)?\s*:\s*(.+)$/);
    if (m) {
      const { typePart, desc } = splitDesc(m[3].trim());
      out.push({ name: m[1], optional: m[2] === '?', typePhrase: typeToPhrase(typePart), rawType: typePart, description: desc, rules: [], rawRules: [] });
      continue;
    }
    const rm = t.match(/^(!?[A-Z][A-Z0-9-]*!*)\s+(.+)$/);
    if (rm) {
      const intro = ruleIntro(rm[1]);
      if (intro) {
        const cur = out[out.length - 1];
        if (!cur) {
          throw new Error(`slot rule "${t}" has no slot above it — rules attach to the preceding slot`);
        }
        cur.rules.push(`${intro} ${rm[2].trim()}`);
        cur.rawRules!.push({ keyword: rm[1], text: rm[2].trim() });
        continue;
      }
    }
    // anything else: skipped silently (no lint by design; MCP validates strict templates)
  }
  return out;
}

/**
 * Parse a TEMPLATE body into its regions. Returns null when the body is neither
 * a SLOTS record nor a typed scalar — so prose templates fall back to verbatim.
 */
export function parseTemplate(body: string): ParsedTemplate | null {
  const lines = body.split('\n');
  const regions: Record<string, string[]> = {};
  let cur: string | null = null;
  let curIndent = 0;
  for (const raw of lines) {
    const mk = raw.match(REGION_RE);
    if (mk) { cur = mk[2]; curIndent = mk[1].length; regions[cur] = regions[cur] ?? []; continue; }
    if (cur) {
      if (raw.trim() === '') { regions[cur].push(''); continue; }
      const ind = (raw.match(/^\s*/) as RegExpMatchArray)[0].length;
      if (ind > curIndent) regions[cur].push(raw);
      else cur = null;
    }
  }

  const example = regions['EXAMPLE'] ? dedent(regions['EXAMPLE']) : null;

  if (regions['SLOTS']) {
    const slots = parseSlots(regions['SLOTS']);
    if (slots.length === 0) return null;
    const bodyLayout = regions['BODY'] ? dedent(regions['BODY']) : null;
    return { slots, bodyLayout, example, scalar: null };
  }

  // Scalar shorthand: a bare TYPE on the header (`TEMPLATE name: TYPE …`) or on
  // the first content line under `TEMPLATE name:` (block form).
  const decl = scalarDecl(body, lines);
  if (decl) {
    const { typePart, desc } = splitDesc(decl);
    return { slots: [], bodyLayout: null, example, scalar: { typePhrase: typeToPhrase(typePart), description: desc } };
  }
  return null;
}

/** Locate a scalar template's bare TYPE declaration, header-inline or first child line. */
function scalarDecl(body: string, lines: string[]): string | null {
  const hdr = body.match(/^[ \t]*TEMPLATE\s+[^\s:]+:?[ \t]*(.+)$/m);
  if (hdr && looksTyped(hdr[1].trim())) return hdr[1].trim();
  let seenHeader = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (/^TEMPLATE\b/.test(t)) { seenHeader = true; continue; }
    if (!seenHeader) continue;
    if (REGION_RE.test(raw)) return null; // hit SLOTS/BODY/EXAMPLE before a type → not scalar
    return looksTyped(t) ? t : null;      // first content line under the header decides
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Minimal shape of a template entry needed to compose its EXAMPLE by reference. */
export interface ExampleRefEntry {
  name: string;
  body: string;
}

/**
 * Resolve `{slug.EXAMPLE}` markers — written by hand in an EXAMPLE region to
 * compose another template's EXAMPLE verbatim instead of hand-copying it
 * (single source of truth for composed examples, e.g. a list-of-rows template
 * quoting its row template's EXAMPLE). Runs at render time, before the
 * EXAMPLE is wrapped in `markVerbatim` — a later pass would never see it,
 * since verbatim content is shielded from every post-emit substitution.
 * Throws on an unknown slug, a slug with no EXAMPLE, or a reference cycle.
 */
function resolveExampleRefs(example: string, templates: ExampleRefEntry[], seen: Set<string>): string {
  return example.replace(EXAMPLE_REF_RE, (_m, slug: string) => {
    if (seen.has(slug)) {
      throw new Error(`template EXAMPLE reference "{${slug}.EXAMPLE}" is circular`);
    }
    const ref = templates.find(t => t.name === slug);
    if (!ref) {
      throw new Error(`template EXAMPLE references unknown shape "${slug}" (no TEMPLATE with this name is imported)`);
    }
    const parsed = parseTemplate(ref.body);
    if (!parsed?.example) {
      throw new Error(`template "${slug}" has no EXAMPLE to compose via "{${slug}.EXAMPLE}"`);
    }
    return resolveExampleRefs(parsed.example, templates, new Set(seen).add(slug));
  });
}

/**
 * Render a TEMPLATE body to its bundle block, or null when the body is not a
 * v3 template (caller then falls back to verbatim). Emits the literal BODY
 * layout, a field legend, and the EXAMPLE wrapped in `<example>` tags.
 *
 * `templates`, when given, is every template collected for this bundle (name +
 * raw body) — enables `{slug.EXAMPLE}` composition in this template's own
 * EXAMPLE. Omit it to render an EXAMPLE with no such refs (or leave them
 * unresolved verbatim, e.g. in isolated tests).
 */
export function renderTemplate(body: string, name: string, templates?: ExampleRefEntry[]): string | null {
  const t = parseTemplate(body);
  if (!t) return null;

  const out: string[] = [];

  if (t.scalar) {
    const desc = t.scalar.description ? ` — ${t.scalar.description}` : '';
    out.push(`**${name}** — ${t.scalar.typePhrase}${desc}`);
  } else {
    const layout = t.bodyLayout ?? t.slots.map(s => `{${s.name}}`).join(' | ');
    out.push(`Produce **${name}** by filling this layout — replace every \`{slot}\`, keep the rest verbatim:`);
    out.push('', markVerbatim(layout), '');
    out.push('Fields:');
    for (const s of t.slots) {
      const opt = s.optional ? ' *(optional)*' : '';
      const desc = s.description ? ` — ${s.description}` : '';
      out.push(`- **${s.name}**${opt} — ${s.typePhrase}${desc}`);
      for (const r of s.rules) out.push(`  - ${r}`);
    }
  }

  if (t.example) {
    const example = templates ? resolveExampleRefs(t.example, templates, new Set([name])) : t.example;
    out.push('', '<example>', markVerbatim(example), '</example>');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Reference resolution (reused for slot `<tpl>` / `LIST <tpl>`)
// ---------------------------------------------------------------------------

interface ShapeRefCtx {
  templates: { name: string; refId?: string }[];
}

/**
 * Resolve internal `@shape(slug)` markers (emitted by the template renderer for
 * `<tpl>` / `LIST <tpl>` slots) to ``**slug** (id)`` against the bundle's
 * imported shapes. Throws on an unknown slug (a slot referencing an unimported
 * template). Runs in postProcessBody after numbering, so forward refs resolve.
 * Only matches the private `@shape(...)` token — prose `<...>` is never touched.
 */
export function resolveShapeRefs(text: string, ctx: ShapeRefCtx): string {
  const shapes = ctx.templates;
  return text.replace(SHAPE_REF_RE, (_m, slug: string) => {
    const shape = shapes.find(s => s.name === slug);
    if (!shape) {
      throw new Error(
        `template references unknown shape "${slug}" (no TEMPLATE with this name is imported)`,
      );
    }
    return `**${slug}**${refSuffix(shape.refId)}`;
  });
}
