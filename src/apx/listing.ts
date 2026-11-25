// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * What an apx holds, as data — one model, two renderings: the lines of
 * `ls` and the JSON of `ls --json` (what the chat's launcher reads). A unit
 * lists every document it holds: its own (holder '') and each agent's.
 */
import type { ApDocument } from '../apdoc/document.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef } from '../apdoc/types.js';
import { refName } from '../../adapters/md/phrases.js';

/** One block, listed. */
export interface ListingEntry {
  kind: string;
  id: string;
  name: string;
  about: string;
  tags: string[];
  /** Where a policy or a skill holds — null for any other kind. */
  scope: string | null;
  /** The names of the blocks it refers to. */
  uses: string[];
  /** The document of the pack that holds it: '' its own, else the agent's name — `<apx> <holder> get <id>` reads it. */
  holder: string;
}

/** What `ls --json` prints: the unit, when the apx is one, and its blocks. */
export interface Listing {
  unit: { kind: string; name: string } | null;
  entries: ListingEntry[];
}

/** Every reference a block's data holds — any `{ kind, target, id }` object — once per target. */
export function uniqueRefs(data: unknown): ApRef[] {
  const found = new Map<string, ApRef>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (typeof node.target === 'string' && typeof node.kind === 'string' && 'id' in node) {
      if (!found.has(node.target)) found.set(node.target, node as unknown as ApRef);
      return;
    }
    Object.values(node).forEach(walk);
  };
  const { args, body } = data as { args?: unknown; body?: unknown };
  walk(args);
  walk(body);
  return [...found.values()];
}

/** One block as a listing entry. */
function entryOf(doc: ApDocument, block: ApBlock, holder: string): ListingEntry {
  // A block another document holds (a fellow agent) is named by the reference itself.
  const uses = uniqueRefs(block.toJSON()).map(ref => doc.resolve(ref)?.name ?? refName(ref));
  return {
    kind: block.kind, id: block.id, name: block.name, about: block.about ?? '', tags: block.tags,
    scope: block.perimeter, uses, holder,
  };
}

/** Every block of the documents given — the same block held by several, once: by the first that holds it. */
export function listingOf(docs: readonly { doc: ApDocument; holder: string }[], unit: Listing['unit']): Listing {
  const seen = new Set<string>();
  const entries = docs.flatMap(({ doc, holder }) => doc.all().flatMap(block => {
    if (seen.has(block.id)) return [];
    seen.add(block.id);
    return [entryOf(doc, block, holder)];
  }));
  return { unit, entries };
}
