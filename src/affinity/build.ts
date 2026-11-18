// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * buildIndex: turns the entries, their lexicon and the background texts into
 * a plain-JSON index. A unit is what stands for a key: one stem, or a phrase
 * (several stems in order). Each unit carries its weight — rarity divided by
 * the number of keys it stands for — so the background is read only here.
 */
import { FORMULAS, fill } from '../formulas.js';
import { isRecord } from '../guards.js';
import { isStringList, isWeight } from './checks.js';
import { stems } from './normalize.js';

/** One key, the texts that describe it, and how much it counts (1 by default). */
export interface Entry {
  key: string;
  texts: string[];
  weight?: number;
}

/** Key to words or multi-word phrases that stand for it. */
export type Lexicon = Record<string, string[]>;

export interface BuildOptions {
  /** Texts that say how common a word is: the more of them hold a stem, the less it weighs. */
  background?: string[];
}

/** One unit of the index: its stems in order, the keys it stands for (by position in `keys`), its weight. */
export interface IndexUnit {
  stems: string[];
  keys: number[];
  weight: number;
}

/** The index: plain JSON, read back by openIndex. */
export interface AffinityIndex {
  version: number;
  /** The keys, in the order the entries were given. */
  keys: string[];
  /** Each key's entry weight, at the key's position. */
  weights: number[];
  units: IndexUnit[];
}

/** The version of the index this module writes and reads. */
export const INDEX_VERSION = 1;

/** The weight of an entry that gives none. */
const DEFAULT_WEIGHT = 1;

/** The rarity of every stem when no background is given. */
const FULL_RARITY = 1;

/** What separates the stems of a unit in its lookup id; a stem never holds one. */
const UNIT_ID_SEPARATOR = ' ';

/** What buildIndex says of the inputs it refuses. */
const SAY = FORMULAS.messages.affinity;

/** The entries, checked: each shaped as one, keys unique, weights finite and above zero. */
function checkedEntries(entries: unknown): Entry[] {
  if (!Array.isArray(entries)) throw new Error(SAY.notEntryList);
  const seen = new Set<string>();
  entries.forEach((entry: unknown, position) => {
    if (!isRecord(entry)) throw new Error(fill(SAY.notEntry, { position }));
    const { key, texts, weight } = entry;
    if (typeof key !== 'string' || !isStringList(texts)) throw new Error(fill(SAY.notEntry, { position }));
    if (seen.has(key)) throw new Error(fill(SAY.duplicateKey, { key }));
    if (weight !== undefined && !isWeight(weight)) throw new Error(fill(SAY.badWeight, { key }));
    seen.add(key);
  });
  return entries as Entry[];
}

/** The lexicon, checked: an object whose every key has an entry and whose values are arrays of strings. */
function checkedLexicon(lexicon: unknown, keys: ReadonlySet<string>): Lexicon {
  if (!isRecord(lexicon)) throw new Error(SAY.notLexicon);
  for (const [key, items] of Object.entries(lexicon)) {
    if (!keys.has(key)) throw new Error(fill(SAY.orphanLexiconKey, { key }));
    if (!isStringList(items)) throw new Error(fill(SAY.notLexiconItems, { key }));
  }
  return lexicon as Lexicon;
}

/** The background texts, checked; none when not given. */
function checkedBackground(options: BuildOptions | undefined): string[] {
  const background = options?.background;
  if (background === undefined) return [];
  if (!isStringList(background)) throw new Error(SAY.notBackground);
  return background;
}

/** The rarity of a stem: log((N+1)/(df+1)) / log(N+1), N the background texts, df those holding it; 1 without background. */
function rarityOf(background: string[]): (stem: string) => number {
  if (background.length === 0) return () => FULL_RARITY;
  const holders = new Map<string, number>();
  for (const text of background) {
    for (const held of new Set(stems(text))) holders.set(held, (holders.get(held) ?? 0) + 1);
  }
  const textCount = background.length;
  return stem => Math.log((textCount + 1) / ((holders.get(stem) ?? 0) + 1)) / Math.log(textCount + 1);
}

/** The units as they are collected: by id, each with its stems and the keys it stands for, in first-seen order. */
class UnitCollector {
  private readonly units = new Map<string, { stems: string[]; keys: Set<number> }>();

  /** Records that the stems stand for the key at `keyIndex`; nothing when they are empty. */
  add(unitStems: string[], keyIndex: number): void {
    if (unitStems.length === 0) return;
    const id = unitStems.join(UNIT_ID_SEPARATOR);
    const unit = this.units.get(id) ?? { stems: unitStems, keys: new Set<number>() };
    unit.keys.add(keyIndex);
    this.units.set(id, unit);
  }

  /** The units, each weighed by its rarity over its key count; a phrase's rarity is the lowest among its stems. */
  weighed(rarity: (stem: string) => number): IndexUnit[] {
    return [...this.units.values()].map(unit => ({
      stems: unit.stems,
      keys: [...unit.keys].sort((first, second) => first - second),
      weight: Math.min(...unit.stems.map(rarity)) / unit.keys.size,
    }));
  }
}

/** The index of the entries and their lexicon, words weighed against the background. */
export function buildIndex(entries: Entry[], lexicon: Lexicon, options?: BuildOptions): AffinityIndex {
  const checked = checkedEntries(entries);
  const keys = checked.map(entry => entry.key);
  const keyPositions = new Map(keys.map((key, position) => [key, position]));
  const checkedItems = checkedLexicon(lexicon, new Set(keys));
  const background = checkedBackground(options);

  const collector = new UnitCollector();
  checked.forEach((entry, keyIndex) => {
    for (const text of entry.texts) {
      for (const single of stems(text)) collector.add([single], keyIndex);
    }
  });
  for (const [key, items] of Object.entries(checkedItems)) {
    const keyIndex = keyPositions.get(key) as number;
    for (const item of items) collector.add(stems(item), keyIndex);
  }

  return {
    version: INDEX_VERSION,
    keys,
    weights: checked.map(entry => entry.weight ?? DEFAULT_WEIGHT),
    units: collector.weighed(rarityOf(background)),
  };
}
