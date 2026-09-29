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
import { createHash } from 'crypto';
import type { ApBlockData } from './types.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Stable id: `<prefix>-<first 8 hex of sha256("kind|namespace|name")>`.
 * Pure utility — the prefix is NOT known here: each block class declares its
 * own (see blocks.ts); `refId` there resolves it for pointer construction.
 */
export function stableId(prefix: string, kind: string, namespace: string, name: string): string {
  return `${prefix}-${sha256Hex(`${kind}|${namespace}|${name}`).slice(0, 8)}`;
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
