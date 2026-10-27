// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The one list syntax (src/lists.ts): items separated by commas wherever a
 * line takes several, a comma inside `{…}` kept in its glob, and the old
 * space-separated form refused with the line to write.
 */
import { strict as assert } from 'assert';

const { splitList, spacedListError } = await import('../dist/src/lists.js');
const { checkVocabulary } = await import('../dist/src/lint.js');

// --- splitList: trimmed items, empty ones dropped, braces kept ---
assert.deepEqual(splitList('a, b,c'), ['a', 'b', 'c']);
assert.deepEqual(splitList(' src/{api,db}/**, data/** ,, '), ['src/{api,db}/**', 'data/**']);
assert.deepEqual(splitList('{a,{b,c}}, d'), ['{a,{b,c}}', 'd'], 'nested braces');
assert.deepEqual(splitList(''), []);

// --- spacedListError: the rewrite, or null for a list ---
assert.equal(spacedListError('FOR', 'src/** data/**'), '`FOR src/** data/**`: separate the items with commas — `FOR src/**, data/**`');
assert.equal(spacedListError('ENUM[', 'low medium high', ']'), '`ENUM[low medium high]`: separate the items with commas — `ENUM[low, medium, high]`');
assert.equal(spacedListError('EXPERTISE', 'a, b'), null);
assert.equal(spacedListError('FOR', 'src/{api,db}/**'), null, 'one glob with braces');

// --- the vocabulary check refuses every spaced list, and only those ---
const errors = body => checkVocabulary('x.ap', body).map(e => e.message);
const spaced = body => errors(body).filter(m => m.includes('separate the items with commas'));
assert.deepEqual(spaced('EXPORT ROLE r:\n    ABOUT  a role\n    EXPERTISE  code-review refactoring\n'),
  ['`EXPERTISE code-review refactoring`: separate the items with commas — `EXPERTISE code-review, refactoring`']);
assert.deepEqual(spaced('EXPORT POLICY p:\n    ABOUT  p\n    APPLIES  #board universal\n    ALWAYS  be p\n'),
  ['`APPLIES #board universal`: separate the items with commas — `APPLIES #board, universal`']);
assert.equal(spaced('EXPORT POLICY p:\n    ABOUT  p\n    APPLIES  #board, universal\n    ALWAYS  be p\n').length, 0);
assert.equal(spaced('EXPORT ROLE r:\n    ABOUT  a role\n    EXPERTISE  code-review, refactoring\n').length, 0);
assert.ok(spaced('EXPORT TEMPLATE t:\n    ABOUT  t\n    SLOTS:\n        level: ENUM[low high]  "the level"\n')
  .some(m => m === 'slot `level`: `ENUM[low high]`: separate the items with commas — `ENUM[low, high]`'), 'an ENUM of a SLOTS line');
assert.equal(spaced('EXPORT TEMPLATE t:\n    ABOUT  t\n    SLOTS:\n        level: ENUM[low, high]  "the level"\n').length, 0);

console.log('list syntax tests passed.');
