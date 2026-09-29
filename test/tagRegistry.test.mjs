// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { useTagRegistry } from '../dist/src/services/tags.js';

// ---------------------------------------------------------------------------
// Case 1: fresh registry has empty byTag and no errors
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  const snap = registry.snapshot();
  assert.deepEqual(snap.byTag, {}, 'fresh registry: byTag is empty');
  assert.deepEqual(snap.errors, [], 'fresh registry: errors is empty');
}

// ---------------------------------------------------------------------------
// Case 2: register with empty tags → ok=false, error recorded
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  const result = registry.register('m1', 'foo.ap', []);
  assert.equal(result.ok, false, 'empty tags → ok=false');

  const snap = registry.snapshot();
  assert.equal(snap.errors.length, 1, 'one error recorded');
  assert.ok(snap.errors[0].message.includes('no TAGS'), 'error message mentions "no TAGS"');
  assert.equal(snap.errors[0].file, 'foo.ap', 'error file is foo.ap');
  assert.equal(snap.errors[0].severity, 'error', 'severity is error');
  assert.deepEqual(snap.byTag, {}, 'byTag remains empty after failed registration');
}

// ---------------------------------------------------------------------------
// Case 3: register with a valid tag → ok=true, byTag populated
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  const result = registry.register('m1', 'foo.ap', ['#vue']);
  assert.equal(result.ok, true, 'valid tag → ok=true');

  const snap = registry.snapshot();
  assert.deepEqual(snap.errors, [], 'no errors for valid tag');
  assert.deepEqual(snap.byTag, { '#vue': ['m1'] }, 'byTag has #vue → [m1]');
}

// ---------------------------------------------------------------------------
// Case 4: similar tag conflict → ok=false, second module NOT registered
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  registry.register('m1', 'foo.ap', ['#vue']);
  const result = registry.register('m2', 'bar.ap', ['#vue3']);
  assert.equal(result.ok, false, 'similar tag (#vue3 ≈ #vue) → ok=false');

  const snap = registry.snapshot();
  assert.equal(snap.errors.length, 1, 'one error recorded');
  assert.ok(snap.errors[0].message.includes('too similar'), 'error mentions "too similar"');
  assert.ok(snap.errors[0].message.includes('#vue3'), 'error mentions #vue3');
  assert.ok(snap.errors[0].message.includes('#vue'), 'error mentions existing #vue');

  // m2 must NOT appear in byTag under any tag
  assert.ok(!snap.byTag['#vue3'], '#vue3 NOT in byTag');
  assert.deepEqual(snap.byTag['#vue'], ['m1'], '#vue still only has m1');
}

// ---------------------------------------------------------------------------
// Case 5: transactional — if any tag of m2 conflicts, m2 not partial-registered
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  registry.register('m1', 'a.ap', ['#vue', '#forms']);
  // m2 has #vue3 (similar to #vue) AND #forms (same tag — would be ok alone).
  // Since #vue3 triggers a conflict, m2 must not be registered under #forms either.
  const result = registry.register('m2', 'b.ap', ['#vue3', '#forms']);
  assert.equal(result.ok, false, 'transactional: m2 fails due to #vue3 similarity');

  const snap = registry.snapshot();
  // #forms must only contain m1, not m2
  assert.deepEqual(snap.byTag['#forms'], ['m1'], '#forms must not contain m2 (transactional)');
  assert.ok(!snap.byTag['#vue3'], '#vue3 must not be registered');
}

// ---------------------------------------------------------------------------
// Case 6: snapshot is immutable — subsequent register does not mutate old snap
// ---------------------------------------------------------------------------
{
  const registry = useTagRegistry();
  registry.register('m1', 'a.ap', ['#react']);
  const snap1 = registry.snapshot();

  // Mutate registry after snapshot
  registry.register('m2', 'b.ap', ['#angular']);

  // snap1 must still reflect only m1
  assert.deepEqual(snap1.byTag, { '#react': ['m1'] }, 'old snapshot not mutated by later register');
  assert.deepEqual(snap1.errors, [], 'old snapshot errors not mutated');

  // Fresh snapshot reflects both
  const snap2 = registry.snapshot();
  assert.deepEqual(snap2.byTag['#react'], ['m1']);
  assert.deepEqual(snap2.byTag['#angular'], ['m2']);
}

console.log('tagRegistry tests passed.');
