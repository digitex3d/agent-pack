// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * What a file's domain is made of, shared by the compiler (every file at build
 * time, src/judge/domains.ts) and the apx (a new or edited file at dispatch):
 * the options a DOMAINS dimension offers, the question, the lock key and the
 * cache entry a decided domain writes. No compiler imports: the apx bundles it.
 */
import type { ApDocument } from '../apdoc/document.js';
import type { DimensionBlock, TemplateBlock } from '../apdoc/blocks.js';
import { sha256Hex } from '../apdoc/ids.js';
import { CACHE_FORMAT, type CacheEntry } from '../apx/dimensions.js';

/** The question the judge is asked about a file. */
export const DOMAIN_QUESTION = 'Which domain does this source file belong to?';

/** The lock key of a file's domain: the dimension's definition and the file's fingerprint — never its path, so a move keeps the decision. */
export function domainKey(defhash: string, fileFingerprint: string): string {
  return sha256Hex(`domain\n${defhash}\n${fileFingerprint}`).slice(0, 16);
}

/** The domains a DOMAINS dimension can give: the values of its template's one ENUM slot, with the slot's name and description — or null. */
export function domainOptions(doc: ApDocument, dim: DimensionBlock): { slot: string; values: string[]; description: string } | null {
  const slots = dim.shape ? doc.slotsOf(dim.shape.ref) ?? [] : [];
  if (slots.length !== 1 || slots[0].spec.kind !== 'enum') return null;
  const description = (doc.resolve(dim.shape!.ref) as TemplateBlock | null)?.slots?.[0]?.description ?? slots[0].name;
  return { slot: slots[0].name, values: slots[0].spec.values, description };
}

/** The option → meaning map the judge is handed: each domain, described by the slot's description and its name. */
export function domainChoices(options: { values: string[]; description: string }): Record<string, string> {
  return Object.fromEntries(options.values.map(v => [v, `${options.description}: ${v}`]));
}

/** The entry a decided domain writes: the dimension's value for the file — one instance of its template. */
export function domainEntry(dim: DimensionBlock, file: string, hash: string, slot: string, domain: string, by: string): CacheEntry {
  return { format: CACHE_FORMAT, dimension: dim.name, file, hash, refs: {}, value: [{ [slot]: domain }], by, at: new Date().toISOString() };
}

/** The domain a fresh cache entry gives, or null. */
export function domainOf(entry: CacheEntry | null, slot: string): string | null {
  if (!entry || !Array.isArray(entry.value)) return null;
  const v = (entry.value[0] as Record<string, unknown> | undefined)?.[slot];
  return typeof v === 'string' ? v : null;
}
