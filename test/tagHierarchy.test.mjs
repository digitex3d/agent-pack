// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for buildHierarchy (FCA-derived tag forest). The forest is consumed
 * by the library MCP `knowledge_list_tags` handler; the deleted renderTagIndex
 * bundler used to render it inline, but cross-references now take that role
 * (see test/crossReferences.test.mjs).
 */
import { strict as assert } from 'assert';
import { buildHierarchy } from '../dist/src/services/tags.js';

function set(...items) {
  return new Set(items);
}

// ---------------------------------------------------------------------------
// Case 1: simple subset → parent/child
// ---------------------------------------------------------------------------
{
  const byTag = new Map([
    ['#coding', set('a', 'b', 'c')],
    ['#design', set('b', 'c')],
  ]);
  const forest = buildHierarchy(byTag);
  assert.equal(forest.length, 1, 'one root');
  assert.equal(forest[0].tag, '#coding');
  assert.equal(forest[0].children.length, 1, 'coding has one child');
  assert.equal(forest[0].children[0].tag, '#design');
  assert.deepEqual(forest[0].children[0].children, [], 'design is leaf');

  console.log('case 1 (simple subset) passed.');
}

// ---------------------------------------------------------------------------
// Case 2: synonyms (identical module sets) → canonical + aliases
// ---------------------------------------------------------------------------
{
  const byTag = new Map([
    ['#dry', set('a')],
    ['#kiss', set('a')],
  ]);
  const forest = buildHierarchy(byTag);
  assert.equal(forest.length, 1, 'single concept');
  assert.equal(forest[0].tag, '#dry', 'alphabetical first wins as canonical');
  assert.deepEqual(forest[0].aliases, ['#kiss'], 'kiss is alias');

  console.log('case 2 (synonyms) passed.');
}

// ---------------------------------------------------------------------------
// Case 3: multi-parent → primary parent = smaller modules set (tie-break alpha)
// ---------------------------------------------------------------------------
{
  const byTag = new Map([
    ['#A', set('x', 'y', 'z')],
    ['#B', set('x', 'y')],
    ['#C', set('x', 'z')],
    ['#D', set('x')],
  ]);
  const forest = buildHierarchy(byTag);
  assert.equal(forest.length, 1, 'single root #A');
  assert.equal(forest[0].tag, '#A');
  const a = forest[0];
  assert.equal(a.children.length, 2, 'A has two children: B and C');

  function findNode(start, tag) {
    if (start.tag === tag) return start;
    for (const c of start.children) {
      const found = findNode(c, tag);
      if (found) return found;
    }
    return null;
  }

  const b = findNode(a, '#B');
  const c = findNode(a, '#C');
  assert.ok(b, 'B exists in tree');
  assert.ok(c, 'C exists in tree');

  // D has two direct parents (#B size 2 and #C size 2): tie size → alphabetical → #B
  const dUnderB = b.children.find(n => n.tag === '#D');
  const dUnderC = c.children.find(n => n.tag === '#D');
  assert.ok(dUnderB, 'D primary parent is #B (alphabetical tie-break)');
  assert.ok(!dUnderC, 'D not duplicated under #C');

  console.log('case 3 (multi-parent primary parent) passed.');
}

// ---------------------------------------------------------------------------
// Case 4: ordering — roots by descending member count, then alpha
// ---------------------------------------------------------------------------
{
  const byTag = new Map([
    ['#small', set('a')],
    ['#big', set('a', 'b', 'c')],
    ['#mid', set('a', 'b')],
  ]);
  // #small ⊂ #mid ⊂ #big → single chain root=#big
  // To force 3 roots, use disjoint module sets:
  const disjoint = new Map([
    ['#small', set('a')],
    ['#big', set('p', 'q', 'r')],
    ['#mid', set('x', 'y')],
  ]);
  const forest = buildHierarchy(disjoint);
  assert.equal(forest.length, 3, 'three disjoint roots');
  assert.deepEqual(forest.map(n => n.tag), ['#big', '#mid', '#small'], 'order by descending member count');

  console.log('case 4 (ordering) passed.');
}

// ---------------------------------------------------------------------------
// Case 5: empty input
// ---------------------------------------------------------------------------
{
  const forest = buildHierarchy(new Map());
  assert.deepEqual(forest, []);
  console.log('case 5 (empty) passed.');
}

console.log('tagHierarchy tests passed.');
