// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Store drivers — the seam behind `DRIVER` in a `STORE` block.
 *
 * A store declares WHAT it holds (SLOTS), what identifies a record (KEY) and
 * how long it lives (LASTS). A *driver* decides HOW that is kept: a JSON file,
 * a tabeli table, a database. Agents never see the driver: they talk to the
 * store through the apx's store API (src/apx/stores.ts), in the same verbs
 * whatever keeps the records.
 *
 * The contract is deliberately narrow — too small to implement half of. At
 * compile time a driver says where the data lives and what it cannot hold; at
 * run time it opens a collection and translates a handful of operations into
 * its engine's own language. Everything that does not depend on the engine —
 * checking a write against the slots, parsing filters, refusing an operation
 * the driver lacks — is the store API's, written once.
 *
 * Slots arrive already resolved (`ApSlot`, the document's own shape), so a
 * driver reads a typed field and never re-parses the source grammar.
 */
import type { ApSlot, ApSlotType } from '../apdoc/types.js';
import { FORMULAS, fill, qualified } from '../formulas.js';

/** How long a store's data survives — the values `LASTS` takes. */
export const STORE_LIFETIMES = ['session', 'project'] as const;
export type StoreLifetime = typeof STORE_LIFETIMES[number];

/** The driver a STORE without a `DRIVER` line is kept by. */
export const DEFAULT_DRIVER = 'files';

/** The version of this contract; a driver states the one it was written for. */
export const DRIVER_API = 1;

/** A store block, resolved — what a driver is handed at compile time. */
export interface StoreDecl {
  name: string;
  /** The agent the store belongs to — its data lives under its name. */
  agent: string;
  about: string | null;
  /** The slot named by `KEY`, or null when the store declares none. */
  key: string | null;
  lasts: StoreLifetime;
  /** Record shape, resolved from the SLOTS region with the template grammar. */
  slots: ApSlot[];
}

/** A store as a driver opens it at run time. */
export interface StoreRef extends StoreDecl {
  /** The project root. */
  root: string;
  /** Where the data lives, absolute — the driver's own `location`, resolved from the root. */
  path: string;
  /** A name unique to this store in the project — agent, store, and nothing a driver must invent. */
  collection: string;
}

/** The operators a filter takes: comparisons, and `~` for "contains". */
export const FILTER_OPS = ['>=', '<=', '!=', '=', '>', '<', '~'] as const;
type FilterOp = typeof FILTER_OPS[number];

/** One condition on a field, parsed by the store API from `<field><op><value>`. */
export interface Filter {
  field: string;
  op: FilterOp;
  value: string;
}

/** A record, flat: field to value. `id` is the driver's own identifier of it. */
export type Doc = Record<string, string | number>;

export type MaybePromise<T> = T | Promise<T>;

/** The operations a driver may add to the base ones, and declares in `capabilities`. */
export type DriverCapability = 'take' | 'guard' | 'since';

/**
 * A store's records, open. `key` is the KEY slot's value when the store
 * declares one, else the record's `id`. Every record a driver answers carries
 * its `id`.
 */
export interface Collection {
  /** Add a record — with the store's KEY already present, replace that record's fields instead. */
  put(doc: Doc): MaybePromise<{ id: string; updated: boolean }>;
  get(key: string): MaybePromise<Doc | null>;
  /** The records every filter holds for, in the order they were added; at most `limit` when given. */
  find(filters: Filter[], limit?: number): MaybePromise<Doc[]>;
  /** Set some fields of a record: `missing` when there is none, `stale` when a `guard` filter does not hold. */
  set(key: string, fields: Doc, guard?: Filter[]): MaybePromise<'set' | 'missing' | 'stale'>;
  remove(key: string): MaybePromise<boolean>;
  /** `take`: the first record the filters hold for, its `fields` set — two callers never get the same one. */
  take?(filters: Filter[], fields: Doc): MaybePromise<Doc | null>;
  /** `since`: a mark of now, then the records added or changed after a mark. */
  mark?(): MaybePromise<string>;
  since?(mark: string): MaybePromise<Doc[] | null>;
}

export interface StoreDriver {
  type: 'driver';
  /** The value written after `DRIVER` in a STORE block. */
  name: string;
  /** The contract version the driver was written for — DRIVER_API. */
  api: number;
  /** The operations beyond the base ones the driver keeps: `guard` is `set … if`. */
  capabilities: readonly DriverCapability[];
  /** Where the store's data lives, from the project root. */
  location(store: StoreDecl): string;
  /** Why this driver cannot keep this store at all, or null when it can — a session store in a shared database, say. */
  rejectsStore?(store: StoreDecl): string | null;
  /**
   * Why this driver cannot hold a slot of this shape, or null when it can.
   * A driver states its limits and the compiler enforces them, instead of the
   * limit surfacing on the first write.
   */
  rejects?(slot: ApSlot): string | null;
  open(store: StoreRef): MaybePromise<Collection>;
}

/** A slot's type as a short human phrase — the field list of a store chapter. */
/** A number slot's phrase: its bounds, when it has any. */
function numberPhrase(t: Extract<ApSlotType, { kind: 'number' }>): string {
  const TY = FORMULAS.types;
  if (t.min !== undefined && t.max !== undefined) return qualified(TY.number, [fill(TY.range, { min: t.min, max: t.max })]);
  if (t.min !== undefined) return qualified(TY.number, [fill(TY.atLeast, { min: t.min })]);
  if (t.max !== undefined) return qualified(TY.number, [fill(TY.atMost, { max: t.max })]);
  return TY.number;
}

/** A text slot's phrase: its word bounds, when it has any. */
function textPhrase(t: Extract<ApSlotType, { kind: 'text' }>): string {
  const TY = FORMULAS.types;
  const bits: string[] = [];
  if (t.minWords !== undefined) bits.push(fill(TY.minWords, { n: t.minWords }));
  if (t.maxWords !== undefined) bits.push(fill(TY.maxWords, { n: t.maxWords }));
  return qualified(TY.text, bits);
}

export function phraseOf(t: ApSlotType): string {
  const TY = FORMULAS.types;
  switch (t.kind) {
    case 'enum':
      return fill(TY.enum, { values: t.values.join(', ') });
    case 'number':
      return numberPhrase(t);
    case 'text':
      return textPhrase(t);
    case 'shape':
      return fill(TY.storeShape, { target: t.ref.target });
    case 'list':
      return fill(TY.storeList, { target: t.ref.target });
    default:
      return t.raw;
  }
}
