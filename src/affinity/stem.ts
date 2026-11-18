// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The Porter stemmer (M. F. Porter, "An algorithm for suffix stripping", 1980),
 * steps 1a to 5b, written from the published rules. It takes one lowercase word
 * and returns its stem. Words of one or two letters are left as they are.
 */

/** A suffix rule: the suffix to strip and what replaces it. */
type SuffixRule = readonly [suffix: string, replacement: string];

/** Whether a stem may take a rule's replacement, the rule's suffix given. */
type StemCondition = (stem: string, suffix: string) => boolean;

/** The shortest word the algorithm stems. */
const SHORTEST_STEMMED_LENGTH = 3;

const STEP_1A: readonly SuffixRule[] = [['sses', 'ss'], ['ies', 'i'], ['ss', 'ss'], ['s', '']];

/** Step 1b's first rule: when a word ends with it, the other step-1b rules are not tried. */
const STEP_1B_EED: SuffixRule = ['eed', 'ee'];

const STEP_1B_STRIPS: readonly SuffixRule[] = [['ed', ''], ['ing', '']];

const STEP_1B_REPAIRS: readonly SuffixRule[] = [['at', 'ate'], ['bl', 'ble'], ['iz', 'ize']];

const STEP_1C: readonly SuffixRule[] = [['y', 'i']];

const STEP_2: readonly SuffixRule[] = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'],
  ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'],
  ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'],
  ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];

const STEP_3: readonly SuffixRule[] = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
];

/** The silent `e`: step 1b restores it, step 5a drops it. */
const SILENT_E = 'e';

const STEP_4: readonly SuffixRule[] = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent',
  'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
].map(suffix => [suffix, ''] as const);

const STEP_5A: readonly SuffixRule[] = [[SILENT_E, '']];

const STEP_5B: readonly SuffixRule[] = [['ll', 'l']];

/** The step-4 suffix that only goes after one of ION_STEM_ENDINGS. */
const ION_SUFFIX = 'ion';

/** The letters a stem must end with to lose ION_SUFFIX. */
const ION_STEM_ENDINGS = 'st';

/** The doubled consonants step 1b keeps. */
const KEPT_DOUBLES = 'lsz';

/** The length of a consonant-vowel-consonant ending. */
const CVC_LENGTH = 3;

/** The consonants that end no cvc pattern. */
const NON_CVC_ENDINGS = 'wxy';

/** The last letter of a word; empty for an empty word. */
function lastLetter(word: string): string {
  return word.slice(-1);
}

/** Whether the letter at `index` is a consonant: not a vowel, and `y` only after a vowel or at the start. */
function isConsonant(word: string, index: number): boolean {
  switch (word[index]) {
    case 'a':
    case 'e':
    case 'i':
    case 'o':
    case 'u':
      return false;
    case 'y':
      return index === 0 || !isConsonant(word, index - 1);
    default:
      return true;
  }
}

/** The measure m of a stem: how many vowel-consonant sequences it holds, as in [C](VC)^m[V]. */
function measure(stem: string): number {
  let count = 0;
  let previousIsVowel = false;
  for (let index = 0; index < stem.length; index++) {
    const isVowel = !isConsonant(stem, index);
    if (!isVowel && previousIsVowel) count++;
    previousIsVowel = isVowel;
  }
  return count;
}

/** Whether a stem holds a vowel (*v*). */
function containsVowel(stem: string): boolean {
  for (let index = 0; index < stem.length; index++) {
    if (!isConsonant(stem, index)) return true;
  }
  return false;
}

/** Whether a word ends with a double consonant (*d). */
function endsWithDoubleConsonant(word: string): boolean {
  const last = word.length - 1;
  return last > 0 && word[last] === word[last - 1] && isConsonant(word, last);
}

/** Whether a word ends consonant-vowel-consonant, the last not w, x or y (*o). */
function endsWithShortSyllable(word: string): boolean {
  const first = word.length - CVC_LENGTH;
  const last = word.length - 1;
  return first >= 0
    && isConsonant(word, first) && !isConsonant(word, first + 1) && isConsonant(word, last)
    && !NON_CVC_ENDINGS.includes(word[last]);
}

/** The word with the first rule whose suffix it ends with applied, when the condition holds; at most one rule is tried. */
function replaceSuffix(word: string, rules: readonly SuffixRule[], condition: StemCondition): string {
  for (const [suffix, replacement] of rules) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, word.length - suffix.length);
    return condition(stem, suffix) ? stem + replacement : word;
  }
  return word;
}

const always: StemCondition = () => true;
const measureAboveZero: StemCondition = stem => measure(stem) > 0;
const measureAboveOne: StemCondition = (stem, suffix) =>
  measure(stem) > 1 && (suffix !== ION_SUFFIX || ION_STEM_ENDINGS.includes(lastLetter(stem)));
/** Step 5a's condition: m > 1, or m = 1 and the stem does not end cvc. */
const longEnoughForNoE: StemCondition = stem => {
  const stemMeasure = measure(stem);
  return stemMeasure > 1 || (stemMeasure === 1 && !endsWithShortSyllable(stem));
};
/** Step 5b's condition, on the word once undoubled: its measure (the same as with the double) is above one. */
const undoubledAboveOne: StemCondition = (stem, suffix) => measure(stem + lastLetter(suffix)) > 1;

/** Step 1b's repair after `ed` or `ing` went: restore an `e`, or undouble a consonant. */
function repairAfterStrip(stem: string): string {
  const repaired = replaceSuffix(stem, STEP_1B_REPAIRS, always);
  if (repaired !== stem) return repaired;
  if (endsWithDoubleConsonant(stem) && !KEPT_DOUBLES.includes(lastLetter(stem))) return stem.slice(0, -1);
  if (measure(stem) === 1 && endsWithShortSyllable(stem)) return stem + SILENT_E;
  return stem;
}

/** Step 1b: `eed` to `ee` on m > 0; else `ed` or `ing` stripped from a vowel-holding stem, then repaired. */
function stripPastAndProgressive(word: string): string {
  if (word.endsWith(STEP_1B_EED[0])) return replaceSuffix(word, [STEP_1B_EED], measureAboveZero);
  const stripped = replaceSuffix(word, STEP_1B_STRIPS, containsVowel);
  return stripped === word ? word : repairAfterStrip(stripped);
}

/** The Porter stem of one lowercase word. */
export function stem(word: string): string {
  if (word.length < SHORTEST_STEMMED_LENGTH) return word;
  let result = replaceSuffix(word, STEP_1A, always);
  result = stripPastAndProgressive(result);
  result = replaceSuffix(result, STEP_1C, containsVowel);
  result = replaceSuffix(result, STEP_2, measureAboveZero);
  result = replaceSuffix(result, STEP_3, measureAboveZero);
  result = replaceSuffix(result, STEP_4, measureAboveOne);
  result = replaceSuffix(result, STEP_5A, longEnoughForNoE);
  return replaceSuffix(result, STEP_5B, undoubledAboveOne);
}
