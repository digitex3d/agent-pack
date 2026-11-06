// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Filters — `<field><op><value>` read once, for every driver. The store API
 * parses what the agent wrote; a driver gets `Filter`s and translates them,
 * or, keeping records in memory (the files driver), tests them with `holds`.
 *
 * The semantics are tabeli's, the language agents already wrote: values are
 * compared as numbers when both sides are numbers, as text otherwise; `~`
 * means "contains".
 */
import { FILTER_OPS, type Doc, type Filter } from './types.js';

/** A field name a filter can read: letters, digits and _ — the compiler holds every store slot to it. */
export const STORE_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One `<field><op><value>` as a filter — null when it is not one. */
export function parseFilter(arg: string): Filter | null {
  for (const op of FILTER_OPS) {
    const at = arg.indexOf(op);
    if (at <= 0) continue;
    // `>=` and `<=` are tried before `>`, `<` and `=`: the first operator in the list that splits a field off wins
    const field = arg.slice(0, at);
    if (STORE_FIELD_RE.test(field)) return { field, op, value: arg.slice(at + op.length) };
  }
  return null;
}

/** The value as a number, when it reads as one. */
function numberOf(v: string | number | undefined): number | null {
  if (typeof v === 'number') return v;
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Order two values: as numbers when both are, as text otherwise. */
function compare(a: string | number | undefined, b: string): number {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return x - y;
  return String(a ?? '').localeCompare(b);
}

/** Whether one filter holds for a record; a field the record lacks reads as empty. */
function holdsOne(doc: Doc, f: Filter): boolean {
  const v = doc[f.field];
  switch (f.op) {
    case '~':
      return String(v ?? '').includes(f.value);
    case '=':
      return compare(v, f.value) === 0;
    case '!=':
      return compare(v, f.value) !== 0;
    case '>':
      return compare(v, f.value) > 0;
    case '<':
      return compare(v, f.value) < 0;
    case '>=':
      return compare(v, f.value) >= 0;
    case '<=':
      return compare(v, f.value) <= 0;
  }
}

/** Whether every filter holds for a record. */
export function holds(doc: Doc, filters: readonly Filter[]): boolean {
  return filters.every(f => holdsOne(doc, f));
}

/** A filter written back as `<field><op><value>` — a driver whose engine reads that language passes it on. */
export function filterText(f: Filter): string {
  return `${f.field}${f.op}${f.value}`;
}
