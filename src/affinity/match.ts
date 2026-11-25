// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * openIndex: checks an index and gives the three calls over it — terms, mark
 * and match. A single-stem unit lights wherever its stem is in the text; a
 * phrase lights where its stems stand adjacent and in order in the text's stem
 * sequence (stop words removed). No call throws on a text.
 */
import { FORMULAS, fill } from '../formulas.js';
import { type AffinityIndex, INDEX_VERSION, type IndexUnit } from './build.js';
import { isRecord } from '../guards.js';
import { isStringList, isWeight, isWeightOrZero } from './checks.js';
import { stems, type Word, words } from './normalize.js';

/** A word or phrase as written in a text, and a key it lights. */
export interface Mark {
  word: string;
  key: string;
}

/** A lit key, its score and the words that lit it, as written, in order of first appearance. */
export interface Match {
  key: string;
  score: number;
  marked: string[];
}

export interface MatchOptions {
  /** At most this many keys; no limit when not given. */
  top?: number;
  /** Only these keys are considered; unknown keys are ignored. */
  among?: string[];
  /** Keys scoring below it are dropped; every lit key is kept when not given. */
  threshold?: number;
}

export interface Affinity {
  /** The stems of a text in text order, stop words removed, without duplicates. */
  terms(text: string): string[];
  /** One row per distinct written word or phrase and key it lights, in order of first appearance. */
  mark(text: string): Mark[];
  /** The lit keys, by descending score; equal scores keep the order the entries were given in. */
  match(text: string, options?: MatchOptions): Match[];
}

/** A unit lit in a text: its position in the index, and its words as written, joined by one space. */
interface LitUnit {
  unit: number;
  written: string;
}

/** What lit one key: the distinct units, and the written words, in order of first appearance. */
interface KeyHit {
  units: Set<number>;
  marked: string[];
}

/** What joins the written words of a lit phrase. */
const PHRASE_JOINER = ' ';

/** What openIndex says of an index it refuses. */
const SAY = FORMULAS.messages.affinity;

/** Whether a unit is shaped as one: stems a non-empty string array, keys valid key positions, weight finite and not negative. */
function isUnit(value: unknown, keyCount: number): value is IndexUnit {
  if (!isRecord(value)) return false;
  const { stems: unitStems, keys, weight, fields } = value;
  return isStringList(unitStems) && unitStems.length > 0 && !unitStems.includes('')
    && Array.isArray(keys) && keys.length > 0
    && keys.every(item => Number.isInteger(item) && (item as number) >= 0 && (item as number) < keyCount)
    && isWeightOrZero(weight)
    && areFieldWeights(fields, keys.length);
}

/** Whether a unit's field weights are absent, or one weight per key it stands for. */
function areFieldWeights(fields: unknown, keyCount: number): boolean {
  return fields === undefined || (Array.isArray(fields) && fields.length === keyCount && fields.every(isWeight));
}

/** Whether the keys are an array of distinct strings. */
function areKeys(keys: unknown): keys is string[] {
  return isStringList(keys) && new Set(keys).size === keys.length;
}

/** Whether the weights are one finite number above zero per key. */
function areWeights(weights: unknown, keyCount: number): weights is number[] {
  return Array.isArray(weights) && weights.length === keyCount
    && weights.every(isWeight);
}

/** The index, checked: the version this module reads, and every part shaped as it writes it. */
function checkedIndex(index: unknown): AffinityIndex {
  if (!isRecord(index)) throw new Error(SAY.notObject);
  if (index.version === undefined) throw new Error(SAY.missingVersion);
  if (index.version !== INDEX_VERSION) throw new Error(fill(SAY.unknownVersion, { version: String(JSON.stringify(index.version)), supported: INDEX_VERSION }));
  const { keys, weights, units } = index;
  if (!areKeys(keys)) throw new Error(SAY.badKeys);
  if (!areWeights(weights, keys.length)) throw new Error(SAY.badWeights);
  if (!Array.isArray(units)) throw new Error(fill(SAY.badUnit, { position: 0 }));
  units.forEach((unit: unknown, position) => {
    if (!isUnit(unit, keys.length)) throw new Error(fill(SAY.badUnit, { position }));
  });
  return index as unknown as AffinityIndex;
}

/** The units by how they are looked up: a single stem by its stem, a phrase by its first stem. */
class UnitLookup {
  private readonly singles = new Map<string, number>();
  private readonly phrasesByFirstStem = new Map<string, number[]>();

  constructor(private readonly units: IndexUnit[]) {
    units.forEach((unit, position) => {
      const [first] = unit.stems;
      if (unit.stems.length === 1) {
        this.singles.set(first, position);
        return;
      }
      this.phrasesByFirstStem.set(first, [...(this.phrasesByFirstStem.get(first) ?? []), position]);
    });
  }

  /** The units a text lights, in order of first appearance: at one position, the single stem before the phrases. */
  lit(text: string): LitUnit[] {
    const found = words(text);
    const lit: LitUnit[] = [];
    found.forEach((word, position) => {
      const single = this.singles.get(word.stem);
      if (single !== undefined) lit.push({ unit: single, written: word.written });
      for (const phrase of this.phrasesByFirstStem.get(word.stem) ?? []) {
        const span = this.phraseAt(found, position, this.units[phrase].stems);
        if (span) lit.push({ unit: phrase, written: span.map(spanned => spanned.written).join(PHRASE_JOINER) });
      }
    });
    return lit;
  }

  /** The words of the phrase when its stems stand at `position`, adjacent and in order; null otherwise. */
  private phraseAt(found: Word[], position: number, phraseStems: string[]): Word[] | null {
    const span = found.slice(position, position + phraseStems.length);
    const matches = span.length === phraseStems.length && span.every((word, offset) => word.stem === phraseStems[offset]);
    return matches ? span : null;
  }
}

/** The keys a text lights, by key position, each with the units and the words that lit it. */
function hitsOf(units: IndexUnit[], lookup: UnitLookup, text: string): Map<number, KeyHit> {
  const hits = new Map<number, KeyHit>();
  for (const { unit, written } of lookup.lit(text)) {
    for (const keyIndex of units[unit].keys) {
      const hit = hits.get(keyIndex) ?? { units: new Set<number>(), marked: [] };
      hit.units.add(unit);
      if (!hit.marked.includes(written)) hit.marked.push(written);
      hits.set(keyIndex, hit);
    }
  }
  return hits;
}

/** A key's score: its entry weight times the sum, over the distinct units that lit it, of each one's weight times its field weight for the key (1 without one). */
function scoreOf(index: AffinityIndex, keyIndex: number, hit: KeyHit): number {
  let total = 0;
  for (const unit of hit.units) {
    const { weight, keys, fields } = index.units[unit];
    total += weight * (fields?.[keys.indexOf(keyIndex)] ?? 1);
  }
  return index.weights[keyIndex] * total;
}

/** The calls over an index; throws when the index is of an unknown version or not shaped as one. */
export function openIndex(index: AffinityIndex): Affinity {
  const checked = checkedIndex(index);
  const { keys, units } = checked;
  const lookup = new UnitLookup(units);

  return {
    terms(text) {
      return [...new Set(stems(text))];
    },

    mark(text) {
      const seen = new Set<string>();
      const rows: Mark[] = [];
      for (const { unit, written } of lookup.lit(text)) {
        for (const keyIndex of units[unit].keys) {
          const row = { word: written, key: keys[keyIndex] };
          const id = JSON.stringify([row.word, row.key]);
          if (seen.has(id)) continue;
          seen.add(id);
          rows.push(row);
        }
      }
      return rows;
    },

    match(text, options = {}) {
      const { top, among, threshold } = options;
      const allowed = among === undefined ? null : new Set(among);
      const hits = hitsOf(units, lookup, text);
      const matches: Match[] = [];
      keys.forEach((key, keyIndex) => {
        const hit = hits.get(keyIndex);
        if (!hit || (allowed && !allowed.has(key))) return;
        const score = scoreOf(checked, keyIndex, hit);
        if (threshold !== undefined && score < threshold) return;
        matches.push({ key, score, marked: hit.marked });
      });
      matches.sort((first, second) => second.score - first.score);
      return top === undefined ? matches : matches.slice(0, Math.max(0, Math.floor(top)));
    },
  };
}
