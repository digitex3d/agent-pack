// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Store types — the plugin seam behind `TYPE` in a `STORE` block.
 *
 * A store declares WHAT it holds (SLOTS), what identifies a record (KEY) and
 * how long it lives (LASTS). A store *type* decides HOW that is backed, and —
 * the part that matters at compile time — what the agent is told to run.
 *
 * The contract is deliberately narrow. A type turns a declaration into the
 * concrete lines an agent reads: where the data lives, and the commands that
 * put, read and update it, written with this store's own field names. Nothing
 * else. Types stay interchangeable only while the interface is too small to
 * implement half of.
 *
 * Slots arrive already resolved (`ApSlot`, the document's own shape), so a type
 * reads a typed field and never re-parses the source grammar.
 */
import type { ApSlot, ApSlotType } from '../apdoc/types.js';
import { FORMULAS, fill, qualified } from '../formulas.js';

/** How long a store's data survives — the values `LASTS` takes. */
export const STORE_LIFETIMES = ['session', 'project'] as const;
export type StoreLifetime = typeof STORE_LIFETIMES[number];

/** A store block, resolved — what a store type is handed. */
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

export interface StoreType {
  type: 'store';
  /** The value written after `TYPE` in a STORE block. */
  name: string;
  /**
   * The store's file, from the project root: `LASTS project` data where the
   * project keeps it (`stores/<agent>/`, versionable), `LASTS session` data
   * beside the agent's apx, under `.agent-pack/`.
   */
  location(store: StoreDecl): string;
  /**
   * The usage block the compiled agent reads: one line per operation, written
   * with this store's real field names and the command that serves it (the
   * agent's apx — a store is never touched directly), so the agent never has
   * to translate a generic example into its own case.
   */
  usage(store: StoreDecl, command: string): string[];
  /**
   * Why this backing cannot hold a slot of this shape, or null when it can.
   * This is what makes the seam worth having: a type states its limits and the
   * compiler enforces them, instead of the limit surfacing on the first write.
   */
  rejects?(slot: ApSlot): string | null;
}

/** A slot's type as a short human phrase — the field list of a store chapter. */
export function phraseOf(t: ApSlotType): string {
  const TY = FORMULAS.types;
  switch (t.kind) {
    case 'enum':
      return fill(TY.enum, { values: t.values.join(', ') });
    case 'number': {
      if (t.min !== undefined && t.max !== undefined) return qualified(TY.number, [fill(TY.range, { min: t.min, max: t.max })]);
      if (t.min !== undefined) return qualified(TY.number, [fill(TY.atLeast, { min: t.min })]);
      if (t.max !== undefined) return qualified(TY.number, [fill(TY.atMost, { max: t.max })]);
      return TY.number;
    }
    case 'text': {
      const bits: string[] = [];
      if (t.minWords !== undefined) bits.push(fill(TY.minWords, { n: t.minWords }));
      if (t.maxWords !== undefined) bits.push(fill(TY.maxWords, { n: t.maxWords }));
      return qualified(TY.text, bits);
    }
    case 'shape':
      return fill(TY.storeShape, { target: t.ref.target });
    case 'list':
      return fill(TY.storeList, { target: t.ref.target });
    default:
      return t.raw;
  }
}
