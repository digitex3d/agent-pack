// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Store-type registry — what `TYPE` in a STORE block resolves to.
 *
 * One built-in type ships. The registry exists so a second one is an entry
 * here rather than a change to the compiler, and so an unknown `TYPE` fails
 * with the list of what does exist instead of a silent fallback.
 *
 * No config surface yet, on purpose: a plugin seam earns its plumbing when
 * something needs to plug into it.
 */
import type { StoreType } from './types.js';
import tabeliStore from './tabeli/index.js';

const STORE_TYPES: Record<string, StoreType> = {
  [tabeliStore.name]: tabeliStore,
};

/** Resolve a `TYPE` value. Null when unregistered — callers report, never guess. */
export function storeTypeOf(name: string): StoreType | null {
  return STORE_TYPES[name.trim()] ?? null;
}

/** Every registered type name, for error messages that teach. */
export function storeTypeNames(): string[] {
  return Object.keys(STORE_TYPES).sort();
}
