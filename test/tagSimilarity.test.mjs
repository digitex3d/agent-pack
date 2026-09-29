// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import {
  levenshtein,
  levenshteinRatio,
  areSimilar,
  findSimilar,
  SIMILARITY_RATIO_THRESHOLD,
} from '../dist/src/services/text.js';

// --- levenshtein ---

assert.equal(levenshtein('vue', 'vue3'), 1, 'vue→vue3 distance is 1');
assert.equal(levenshtein('typescript', 'typscript'), 1, 'typescript→typscript distance is 1');
assert.equal(levenshtein('vue', 'vue'), 0, 'identical strings distance is 0');
assert.equal(levenshtein('', ''), 0, 'empty strings distance is 0');
assert.equal(levenshtein('a', ''), 1, 'single char vs empty is 1');
assert.equal(levenshtein('laravel', 'livewire'), 7, 'laravel→livewire distance is 7');

// --- levenshteinRatio ---

assert.equal(levenshteinRatio('vue', 'vue3'), 0.25, 'vue/vue3 ratio is 0.25');
// typescript / typscript: distance=1, max=10 → 0.1
assert.equal(levenshteinRatio('typescript', 'typscript'), 0.1, 'typescript/typscript ratio is 0.1');
// empty / empty → returns 1 (edge case: no conflict)
assert.equal(levenshteinRatio('', ''), 1, 'empty/empty ratio is 1');
// laravel / livewire: distance=7, max=8 → 0.875
assert.ok(levenshteinRatio('laravel', 'livewire') > SIMILARITY_RATIO_THRESHOLD, 'laravel/livewire ratio above threshold');

// --- areSimilar ---

// ratio ≤ threshold → block
assert.equal(areSimilar('vue', 'vue3'), true, 'vue/vue3: ratio 0.25 ≤ threshold → similar');
// ratio > threshold but substring → block
assert.equal(areSimilar('vue', 'vuejs'), true, 'vue/vuejs: substring → similar');
// substring (prefix)
assert.equal(areSimilar('vue', 'frontend-vue'), true, 'vue/frontend-vue: substring → similar');
// ratio ≤ threshold (typo)
assert.equal(areSimilar('typescript', 'typscript'), true, 'typescript/typscript: ratio 0.10 → similar');
// ratio > threshold, no substring → ok
assert.equal(areSimilar('laravel', 'livewire'), false, 'laravel/livewire: not similar');
// clear non-similar pair
assert.equal(areSimilar('vue', 'react'), false, 'vue/react: not similar');
// identical strings are NOT similar (same tag, not a conflict)
assert.equal(areSimilar('vue', 'vue'), false, 'identical tags are not similar');
// edge: empty strings are identical → false
assert.equal(areSimilar('', ''), false, 'empty/empty are not similar (identical)');

// --- findSimilar ---

assert.equal(findSimilar('vue3', ['vue', 'react']), 'vue', 'vue3 conflicts with vue');
assert.equal(findSimilar('xyz', ['vue', 'react']), null, 'xyz has no conflict');
assert.equal(findSimilar('react', ['vue', 'react']), null, 'exact match is not a conflict');
assert.equal(findSimilar('typescript', ['typscript', 'vue']), 'typscript', 'typescript conflicts with typscript');

console.log('tagSimilarity tests passed.');
