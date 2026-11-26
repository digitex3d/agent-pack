// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Filters — `<field><op><value>` read once, for every driver. The store API
 * parses what the agent wrote; a driver gets `Filter`s and translates them,
 * or, keeping records in memory (the files driver), tests them with `holds`.
 *
 * The semantics are the language agents already write: values are
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

/**
 * `<field><op><value>` arguments as filters on a store's fields — and on
 * `extra`, the one field of its own the caller reads by (`id`, `_file`) — or
 * why one of them is not: the one check of filters every caller makes.
 */
export function filtersOn(args: readonly string[], fields: readonly string[], extra: string): Filter[] | string {
  const filters: Filter[] = [];
  for (const arg of args) {
    const filter = parseFilter(arg);
    if (!filter) return `\`${arg}\` is no filter — write <field><op><value>, op one of = != > < >= <= ~`;
    if (filter.field !== extra && !fields.includes(filter.field)) return `\`${filter.field}\` is none of its fields (${fields.join(', ')}, or ${extra})`;
    filters.push(filter);
  }
  return filters;
}

/** The value as a number, when it reads as one. */
function numberOf(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value;
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Order two values: as numbers when both are, as text otherwise. */
function compare(left: string | number | undefined, right: string): number {
  const leftNumber = numberOf(left);
  const rightNumber = numberOf(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return String(left ?? '').localeCompare(right);
}

/** Whether one filter holds for a record; a field the record lacks reads as empty. */
function holdsOne(doc: Doc, filter: Filter): boolean {
  const value = doc[filter.field];
  switch (filter.op) {
    case '~':
      return String(value ?? '').includes(filter.value);
    case '=':
      return compare(value, filter.value) === 0;
    case '!=':
      return compare(value, filter.value) !== 0;
    case '>':
      return compare(value, filter.value) > 0;
    case '<':
      return compare(value, filter.value) < 0;
    case '>=':
      return compare(value, filter.value) >= 0;
    case '<=':
      return compare(value, filter.value) <= 0;
  }
}

/** Whether every filter holds for a record. */
export function holds(doc: Doc, filters: readonly Filter[]): boolean {
  return filters.every(filter => holdsOne(doc, filter));
}

/** A filter written back as `<field><op><value>` — a driver whose engine reads that language passes it on. */
export function filterText(filter: Filter): string {
  return `${filter.field}${filter.op}${filter.value}`;
}
