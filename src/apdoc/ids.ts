// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Block identity and content fingerprint.
 *
 * Two hashes, two purposes — deliberately distinct:
 *   - `blockId`      : STABLE identity from (kind, namespace, name). Survives
 *                      every content edit; changes only on rename/move. Refs
 *                      point at this.
 *   - `blockContentHash` : fingerprint of the canonical serialization. Changes
 *                      with the content; serves caching and drift detection.
 *                      (Distinct from `embedding.contentHash`, which hashes the
 *                      embedder INPUT text — see libraryIndex.embeddingInputFor.)
 */
import { createHash } from 'node:crypto';
import type { ApBlockData } from './types.js';

/** The sha256 of a text, in hex — the one hash every id, key and fingerprint is cut from. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/** The shape of every stable id: a three-letter prefix and eight hex digits (`tpl-1a2b3c4d`). */
export const BLOCK_ID_RE = /^[a-z]{3}-[0-9a-f]{8}$/;

/** A block's name from its address (`@main.templates/verdict` → `verdict`). */
export function addressName(target: string): string {
  return target.split('/').pop() ?? target;
}

/**
 * THE short-id rule: `<prefix>-<first 8 hex of sha256(text)>`. Each caller owns
 * only what it hashes (a block's identity, a distilled procedure, a checked
 * condition) and its prefix.
 */
export function shortId(prefix: string, text: string): string {
  return `${prefix}-${sha256Hex(text).slice(0, 8)}`;
}

/**
 * Stable id: `<prefix>-<first 8 hex of sha256("kind|namespace|name")>`.
 * Pure utility — the prefix is NOT known here: each block class declares its
 * own (see blocks.ts); `refId` there resolves it for pointer construction.
 */
export function stableId(prefix: string, kind: string, namespace: string, name: string): string {
  return shortId(prefix, `${kind}|${namespace}|${name}`);
}

/**
 * Content fingerprint: sha256:16hex over the canonical serialization of the
 * block MINUS the volatile fields (`id`, `contentHash`) — reformatting the
 * source or shuffling comments never lands here, only semantic change does.
 * The block object is constructed with a fixed key order (see recorder), so
 * plain JSON.stringify is canonical.
 */
export function blockContentHash(block: ApBlockData): string {
  const { id: _id, contentHash: _ch, ...rest } = block;
  return `sha256:${sha256Hex(JSON.stringify(rest)).slice(0, 16)}`;
}

/** What names a block rather than says what it is: its identity and its fingerprint. */
const IDENTITY_KEYS = new Set(['name', 'namespace', 'id', 'contentHash']);

/** A reference (`{ id, target, kind }`): it names another block, which the caller hashes on its own when it counts. */
function isRef(value: object): boolean {
  return 'target' in value && 'kind' in value && 'id' in value;
}

/**
 * The content of a block with its names left out — `blockContentHash`'s
 * canonical serialization (same fixed key order) less its identity (name,
 * namespace, id, content hash), its measures (`chars`, at any depth) and the
 * names its references carry (a reference keeps only the kind it points at).
 * A renamed block — or one whose references were renamed — keeps it; an edit
 * changes it. The input of a fingerprint that must outlive a rename.
 */
export function nameFreeContent(block: ApBlockData): unknown {
  const strip = (value: unknown, top: boolean): unknown => {
    if (Array.isArray(value)) return value.map(v => strip(v, false));
    if (!value || typeof value !== 'object') return value;
    if (!top && isRef(value)) return { kind: (value as { kind: unknown }).kind };
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => k !== 'chars' && !(top && IDENTITY_KEYS.has(k)))
      .map(([k, v]) => [k, strip(v, false)]));
  };
  return strip(JSON.parse(JSON.stringify(block)), true);
}
