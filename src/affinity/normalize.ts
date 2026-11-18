// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * How a text becomes words: lowercased, split on anything that is not a letter
 * or a digit (so a hyphen separates words), stop words dropped, each remaining
 * word reduced to its Porter stem. The one pipeline every text goes through —
 * entry texts, lexicon items, background texts and the texts matched.
 */
import { stem } from './stem.js';

/** One word of a text that is not a stop word: as written, and its stem. */
export interface Word {
  written: string;
  stem: string;
}

/** A run of letters a to z or digits: the stemmer's rules are defined on these letters only. */
const WORD_PATTERN = /[a-z0-9]+/gi;

/** English function words — articles, prepositions, auxiliaries, pronouns, conjunctions, contraction tails — never content words. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the',
  'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'at', 'before', 'behind', 'below',
  'beneath', 'beside', 'between', 'beyond', 'by', 'down', 'during', 'for', 'from', 'in', 'inside', 'into', 'near',
  'of', 'off', 'on', 'onto', 'out', 'over', 'per', 'since', 'through', 'throughout', 'till', 'to', 'toward',
  'towards', 'under', 'until', 'up', 'upon', 'via', 'with', 'within', 'without',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing', 'have', 'has', 'had',
  'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself',
  'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they',
  'them', 'their', 'theirs', 'themselves', 'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'than', 'as', 'because', 'while', 'whether', 'though',
  'although', 'unless', 'when', 'where',
  's', 't', 'm', 'd', 'll', 're', 've',
]);

/** The words of a text that are not stop words, in text order; any value that is not a string has none. */
export function words(text: unknown): Word[] {
  if (typeof text !== 'string') return [];
  const found: Word[] = [];
  for (const [written] of text.matchAll(WORD_PATTERN)) {
    const lowercase = written.toLowerCase();
    if (STOP_WORDS.has(lowercase)) continue;
    found.push({ written, stem: stem(lowercase) });
  }
  return found;
}

/** The stems of a text's words, in text order, repeats kept. */
export function stems(text: unknown): string[] {
  return words(text).map(word => word.stem);
}
