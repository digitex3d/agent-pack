// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A participant's pseudonym, `<first>-the-<adjective>` (`bob-the-swift`):
 * the adjective out of the most specific group of src/config/pseudonyms.json
 * that applies — its agent's role, then its effort, then its model's size,
 * then its harness, then the default — the first name and the adjective
 * picked by a hash of its id, so the same participant gets the same name in
 * every chat and on replay. A name taken in the chat moves to the next one.
 */
import PSEUDONYMS from '../../src/config/pseudonyms.json' with { type: 'json' };
import { HARNESS_SEP } from '../../src/delegation.js';

interface Matched { match: string[]; words: string[] }
interface Pseudonyms {
  names: string[];
  role: Record<string, Matched>;
  effort: Record<string, string[]>;
  model: Record<string, Matched>;
  harness: Record<string, string[]>;
  default: string[];
}

const DATA = PSEUDONYMS as unknown as Pseudonyms;
/** The role group of an agent no other role matches. */
const OTHER_ROLE = 'other';
/** FNV-1a, 32 bits: its offset basis and its prime; and how far the adjective's pick is shifted from the name's. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ADJECTIVE_SHIFT = 8;

/** A string's FNV-1a hash — the same on every run. */
function hashOf(text: string): number {
  let hash = FNV_OFFSET;
  for (const char of text) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0;
  return hash;
}

/** The words of the first entry whose `match` the text holds — null when none does. */
function matching(groups: Record<string, Matched>, text: string): string[] | null {
  const hit = Object.values(groups).find(group => group.match.some(word => text.includes(word)));
  return hit ? hit.words : null;
}

/** Who a pseudonym is for: its id (`harness` or `harness:agent`), its model and effort when known. */
export interface Who {
  id: string;
  model?: string | null;
  effort?: string | null;
}

/** The adjectives that fit: the most specific group that applies. */
export function adjectivesOf(who: Who): string[] {
  const [harness, agent] = who.id.split(HARNESS_SEP);
  const role = agent ? matching(DATA.role, agent.toLowerCase()) ?? DATA.role[OTHER_ROLE].words : null;
  const effort = who.effort ? DATA.effort[who.effort.toLowerCase()] : undefined;
  const model = who.model ? matching(DATA.model, who.model.toLowerCase()) : null;
  const flavour = Object.entries(DATA.harness).find(([name]) => harness.toLowerCase().includes(name))?.[1];
  return role ?? effort ?? model ?? flavour ?? DATA.default;
}

/** The pseudonym of a participant — the next one free when its own is taken in the chat. */
export function pseudonymOf(who: Who, taken: ReadonlySet<string> = new Set()): string {
  const hash = hashOf(who.id);
  const adjectives = adjectivesOf(who);
  const adjective = adjectives[(hash >>> ADJECTIVE_SHIFT) % adjectives.length];
  for (let step = 0; step < DATA.names.length; step++) {
    const name = `${DATA.names[(hash + step) % DATA.names.length]}-the-${adjective}`;
    if (!taken.has(name)) return name;
  }
  // Every first name taken with this adjective: the id itself, which is unique.
  return who.id;
}
