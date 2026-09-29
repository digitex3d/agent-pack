// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `chars` measurement — every level that carries text reports its length.
 *
 * Structurally generic: the walker knows NOTHING about node types. It counts
 * every string it finds, recurses through arrays and objects, and stamps
 * `chars` on any object that declares the field. What "content" means is a
 * single policy, expressed once:
 *
 *   - values under identity/address keys never count (kind, name, id, …);
 *   - a Ref (`{target, kind}`) is an address, not content — skipped wholesale;
 *   - the default `when: "always"` is schema noise, not a trigger — skipped.
 *
 * Adding a new node type, arg, or field requires no change here: if it carries
 * text under a non-identity key, it is counted; if it carries a `chars` field,
 * it gets stamped.
 */


/** Identity/address/schema keys — their values are never content. */
const EXCLUDED_KEYS = new Set([
  'type',          // node discriminator AND slot type-spec subtree
  'kind', 'name', 'namespace',
  'id', 'contentHash', 'chars',
  'keyword', 'force', 'optional', 'resolved', 'indent',
  'target',        // Ref address (also fully skipped via isRef)
]);

/** A Ref-shaped object: pure address, skipped wholesale. */
function isRef(v: object): boolean {
  return 'target' in v && 'kind' in v;
}

/**
 * Count the content chars of `value` (reached via `key`), stamping `chars` on
 * every object along the way that declares the field. Returns the count.
 */
export function measure(value: unknown, key?: string): number {
  if (key !== undefined && EXCLUDED_KEYS.has(key)) return 0;
  if (typeof value === 'string') {
    return key === 'when' && value === 'always' ? 0 : value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((n: number, v) => n + measure(v), 0);
  }
  if (value !== null && typeof value === 'object') {
    if (isRef(value)) return 0;
    let n = 0;
    for (const [k, v] of Object.entries(value)) n += measure(v, k);
    if ('chars' in value) (value as { chars: number }).chars = n;
    return n;
  }
  return 0;
}
