// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Slot-schema compiler + validator — the enforcement side of the TEMPLATE
 * contract.
 *
 * `shapeCompiler` renders SLOTS as guidance prose for the model;
 * this module compiles the same parsed slots into a machine-checkable schema
 * and validates a concrete value against it. It is shape-agnostic by design:
 * the apx validates a distilled script's output with it, against the contract
 * template of the compiled document (`specOfSlotType`).
 *
 * Type coverage mirrors shapeCompiler's grammar:
 *   TEXT [MIN_WORDS n | MAX_WORDS n | REGEX /p/] · NUMBER n..m / >=n / <=n
 *   · ENUM[a b c] · <template> · LIST <template> [range]
 * Unknown type expressions (e.g. `JSON`) validate as "any value" — the same
 * pass-through-verbatim stance shapeCompiler takes when rendering them.
 *
 * `<template>` / `LIST <template>` slots are checked as object / array +
 * cardinality, and — when the caller can resolve template names — every
 * nested object against its own template, all the way down.
 */
import { parseTemplate, type ParsedTemplate } from './shapeCompiler.js';
import type { ApSlotType } from './apdoc/types.js';

export type SlotTypeSpec =
  | { kind: 'text'; minWords?: number; maxWords?: number; regex?: RegExp }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'enum'; values: string[] }
  | { kind: 'shape'; ref: string }
  | { kind: 'list'; ref: string; min?: number; max?: number }
  | { kind: 'any'; raw: string };

/** One validation failure, anchored to the offending field. */
export interface SchemaIssue {
  field: string;
  message: string;
}

interface ParsedRange {
  min?: number;
  max?: number;
}

/** Parse a range expression: `a..b`, `>=n`, `<=n`. Empty on no match. */
function parseRange(s: string): ParsedRange {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+)\.\.(\d+)/))) return { min: Number(m[1]), max: Number(m[2]) };
  if ((m = s.match(/^>=\s*(\d+)/))) return { min: Number(m[1]) };
  if ((m = s.match(/^<=\s*(\d+)/))) return { max: Number(m[1]) };
  return {};
}

/**
 * Parse a slot's raw TYPE expression into its machine spec. The regexes mirror
 * shapeCompiler's `typeToPhrase` exactly — same grammar, different output.
 */
export function parseTypeSpec(rawType: string): SlotTypeSpec {
  let m: RegExpMatchArray | null;
  if ((m = rawType.match(/^LIST\s+<([a-z][a-z0-9_-]*)>\s*(.*)$/i))) {
    return { kind: 'list', ref: m[1], ...parseRange(m[2].trim()) };
  }
  if ((m = rawType.match(/^<([a-z][a-z0-9_-]*)>$/))) return { kind: 'shape', ref: m[1] };
  if ((m = rawType.match(/^ENUM\[(.*)\]$/i))) {
    return { kind: 'enum', values: m[1].trim().split(/\s+/).filter(Boolean) };
  }
  if ((m = rawType.match(/^NUMBER\b\s*(.*)$/i))) {
    return { kind: 'number', ...parseRange(m[1].trim()) };
  }
  if ((m = rawType.match(/^TEXT\b\s*(.*)$/i))) {
    const rest = m[1].trim();
    const spec: SlotTypeSpec = { kind: 'text' };
    let c: RegExpMatchArray | null;
    if ((c = rest.match(/MIN_WORDS\s+(\d+)/i))) spec.minWords = Number(c[1]);
    if ((c = rest.match(/MAX_WORDS\s+(\d+)/i))) spec.maxWords = Number(c[1]);
    if ((c = rest.match(/REGEX\s+\/(.*)\//i))) spec.regex = new RegExp(c[1]);
    return spec;
  }
  return { kind: 'any', raw: rawType };
}

function wordCount(s: string): number {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `${typeof v} "${String(v)}"`;
}

/** A slot as the validator sees it: name, optional, resolved type spec. */
export interface SlotSpec {
  name: string;
  optional: boolean;
  spec: SlotTypeSpec;
}

/** A template name → its slots, or null when the caller cannot resolve it. */
export type SlotResolver = (template: string) => readonly SlotSpec[] | null;

/** A nested record's issues, their fields prefixed with where the record sits. */
function nestedIssues(at: string, value: unknown, ref: string, resolve?: SlotResolver): SchemaIssue[] {
  const slots = resolve?.(ref);
  if (!slots) return [];
  return validateRecord(value, slots, resolve).map(i => ({ ...i, field: i.field === '(root)' ? at : `${at}.${i.field}` }));
}

/** Validate one field value against its slot spec. */
function checkSlot(slot: SlotSpec, value: unknown, resolve?: SlotResolver): SchemaIssue[] {
  const { spec } = slot;
  const field = slot.name;
  switch (spec.kind) {
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        return [{ field, message: `expected one of ${spec.values.join('|')}, got ${describeValue(value)}` }];
      }
      return [];
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return [{ field, message: `expected a number, got ${describeValue(value)}` }];
      }
      if (spec.min !== undefined && value < spec.min) {
        return [{ field, message: `expected ≥${spec.min}, got ${value}` }];
      }
      if (spec.max !== undefined && value > spec.max) {
        return [{ field, message: `expected ≤${spec.max}, got ${value}` }];
      }
      return [];
    }
    case 'text': {
      if (typeof value !== 'string') {
        return [{ field, message: `expected a string, got ${describeValue(value)}` }];
      }
      const issues: SchemaIssue[] = [];
      const words = wordCount(value);
      if (value.trim() === '') issues.push({ field, message: 'expected non-empty text' });
      if (spec.minWords !== undefined && words < spec.minWords) {
        issues.push({ field, message: `expected ≥${spec.minWords} words, got ${words}` });
      }
      if (spec.maxWords !== undefined && words > spec.maxWords) {
        issues.push({ field, message: `expected ≤${spec.maxWords} words, got ${words}` });
      }
      if (spec.regex && !spec.regex.test(value)) {
        issues.push({ field, message: `expected text matching ${spec.regex}, got "${value}"` });
      }
      return issues;
    }
    case 'shape': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [{ field, message: `expected an object (shape <${spec.ref}>), got ${describeValue(value)}` }];
      }
      return nestedIssues(field, value, spec.ref, resolve);
    }
    case 'list': {
      if (!Array.isArray(value)) {
        return [{ field, message: `expected an array (list of <${spec.ref}>), got ${describeValue(value)}` }];
      }
      if (spec.min !== undefined && value.length < spec.min) {
        return [{ field, message: `expected ≥${spec.min} items, got ${value.length}` }];
      }
      if (spec.max !== undefined && value.length > spec.max) {
        return [{ field, message: `expected ≤${spec.max} items, got ${value.length}` }];
      }
      return value.flatMap((item, i) => nestedIssues(`${field}[${i}]`, item, spec.ref, resolve));
    }
    case 'any':
      return [];
  }
}

/**
 * Validate a value against a parsed template's SLOTS record. Returns every
 * issue found (empty = valid). Fail-closed stance: unknown fields are errors,
 * not ignored — the gate exists to keep the record minable, and a silently
 * accepted stray field is schema drift.
 */
export function validateSlots(value: unknown, template: ParsedTemplate): SchemaIssue[] {
  return validateRecord(value, template.slots.map(s => ({ name: s.name, optional: s.optional, spec: parseTypeSpec(s.rawType) })));
}

/** A compiled document's slot type as a validator spec — the two are mirrors. */
export function specOfSlotType(t: ApSlotType): SlotTypeSpec {
  switch (t.kind) {
    case 'text': return { kind: 'text', minWords: t.minWords, maxWords: t.maxWords, regex: t.regex !== undefined ? new RegExp(t.regex) : undefined };
    case 'number': return { kind: 'number', min: t.min, max: t.max };
    case 'enum': return { kind: 'enum', values: t.values };
    case 'shape': return { kind: 'shape', ref: t.ref.target.split('/').pop() ?? t.ref.target };
    case 'list': return { kind: 'list', ref: t.ref.target.split('/').pop() ?? t.ref.target, min: t.min, max: t.max };
    case 'any': return { kind: 'any', raw: t.raw };
  }
}

/**
 * Compiled slots as the validator and the schema compiler read them —
 * `allOptional` for a partial write, where no slot is required.
 */
export function slotSpecsOf(slots: readonly { name: string; optional: boolean; type: ApSlotType }[], allOptional = false): SlotSpec[] {
  return slots.map(s => ({ name: s.name, optional: allOptional || s.optional, spec: specOfSlotType(s.type) }));
}

/**
 * The core: a record against its slot specs — shared by source templates and
 * compiled documents. With `resolve`, nested templates are checked too.
 */
export function validateRecord(value: unknown, slots: readonly SlotSpec[], resolve?: SlotResolver): SchemaIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: `expected a JSON object, got ${describeValue(value)}` }];
  }
  const record = value as Record<string, unknown>;
  const issues: SchemaIssue[] = [];
  const known = new Set(slots.map(s => s.name));

  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push({ field: key, message: `unknown field (allowed: ${[...known].join(', ')})` });
    }
  }

  for (const slot of slots) {
    const v = record[slot.name];
    if (v === undefined) {
      if (!slot.optional) issues.push({ field: slot.name, message: 'required field missing' });
      continue;
    }
    issues.push(...checkSlot(slot, v, resolve));
  }
  return issues;
}

/**
 * A record's slots as JSON Schema — the grammar `validateRecord` checks, for a
 * harness that enforces the shape itself (a structured-output tool). Word
 * limits have no JSON Schema keyword: they travel in `description`. A nested
 * template the resolver cannot reach, or one already being expanded, stays a
 * plain object.
 */
export function jsonSchemaOf(slots: readonly SlotSpec[], resolve?: SlotResolver, expanding: ReadonlySet<string> = new Set()): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(slots.map(s => [s.name, slotJsonSchema(s.spec, resolve, expanding)])),
    required: slots.filter(s => !s.optional).map(s => s.name),
    additionalProperties: false,
  };
}

function slotJsonSchema(spec: SlotTypeSpec, resolve: SlotResolver | undefined, expanding: ReadonlySet<string>): Record<string, unknown> {
  const nested = (ref: string): Record<string, unknown> => {
    const slots = expanding.has(ref) ? null : resolve?.(ref);
    return slots ? jsonSchemaOf(slots, resolve, new Set([...expanding, ref])) : { type: 'object' };
  };
  switch (spec.kind) {
    case 'text': {
      const words = [spec.minWords !== undefined && `≥${spec.minWords}`, spec.maxWords !== undefined && `≤${spec.maxWords}`].filter(Boolean);
      return {
        type: 'string',
        ...(spec.regex ? { pattern: spec.regex.source } : {}),
        ...(words.length ? { description: `${words.join(', ')} words` } : {}),
      };
    }
    case 'number': return { type: 'number', ...(spec.min !== undefined ? { minimum: spec.min } : {}), ...(spec.max !== undefined ? { maximum: spec.max } : {}) };
    case 'enum': return { type: 'string', enum: spec.values };
    case 'shape': return nested(spec.ref);
    case 'list': return { type: 'array', items: nested(spec.ref), ...(spec.min !== undefined ? { minItems: spec.min } : {}), ...(spec.max !== undefined ? { maxItems: spec.max } : {}) };
    case 'any': return {};
  }
}

/** Render issues as one actionable multi-line message (one line per issue). */
export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map(i => `${i.field}: ${i.message}`).join('\n');
}

/**
 * An example JSON value of a template — every slot, typed from the same
 * grammar the validator checks (text, the first enum value, the lower bound of
 * a number, a nested template, a one-item list). What a distilled script reads
 * and writes, shown before it is written. Templates by name, from their source.
 */
/** The bodies of a template and of every template its slots reach, each once, depth first. */
export function templateClosure(name: string, templates: readonly { name: string; body: string }[], seen = new Set<string>()): string[] {
  const template = templates.find(t => t.name === name);
  if (!template || seen.has(name)) return [];
  seen.add(name);
  const parsed = parseTemplate(template.body);
  const nested = (parsed?.slots ?? []).flatMap(s => {
    const spec = parseTypeSpec(s.rawType);
    return spec.kind === 'shape' || spec.kind === 'list' ? templateClosure(spec.ref, templates, seen) : [];
  });
  return [template.body, ...nested];
}

export function jsonExample(name: string, templates: readonly { name: string; body: string }[], seen: ReadonlySet<string> = new Set()): unknown {
  const template = templates.find(t => t.name === name);
  const parsed = template && !seen.has(name) ? parseTemplate(template.body) : null;
  if (!parsed) return {};
  const inner = new Set([...seen, name]);
  const value = (spec: SlotTypeSpec): unknown => {
    switch (spec.kind) {
      case 'text': return '…';
      case 'number': return spec.min ?? 0;
      case 'enum': return spec.values[0] ?? '';
      case 'shape': return jsonExample(spec.ref, templates, inner);
      case 'list': return [jsonExample(spec.ref, templates, inner)];
      case 'any': return null;
    }
  };
  return Object.fromEntries(parsed.slots.map(s => [s.name, value(parseTypeSpec(s.rawType))]));
}
