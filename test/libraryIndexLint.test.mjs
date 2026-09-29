// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildMetadataIndex } from '../dist/src/libraryIndex.js';


function makeConfig(libraryRoot) {
  return { libraryRoot, sharedLibraries: [] };
}

function writeMod(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Case 1: module with no TAGS → error "module has no TAGS", not indexed
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(tmp, 'a.policy.ap', '# a\nABOUT no tags\nALWAYS do something\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 1, 'one error for untagged module');
    assert.ok(index.errors[0].message.includes('module has no TAGS'), 'error message mentions "no TAGS"');
    assert.equal(index.errors[0].severity, 'error');
    assert.equal(Object.keys(index.exports).length, 0, 'untagged module is not indexed');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 2: two modules, first with #vue then second with #vue3 → error on second
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    // Use names so alphabetical sort puts a_ before b_
    writeMod(tmp, 'a_mod.policy.ap', '# a\nABOUT a\nTAGS #vue\nALWAYS do a\n');
    writeMod(tmp, 'b_mod.policy.ap', '# b\nABOUT b\nTAGS #vue3\nALWAYS do b\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 1, 'one error for similar tag');
    assert.ok(index.errors[0].message.includes('"#vue3"'), 'error mentions vue3');
    assert.ok(index.errors[0].message.includes('"#vue"'), 'error mentions existing vue');
    // first module (vue) is indexed; second (vue3) is skipped
    const keys = Object.keys(index.exports);
    assert.equal(keys.length, 1, 'only the first module is indexed');
    assert.ok(index.byTag['#vue'], '#vue is registered');
    assert.ok(!index.byTag['#vue3'], '#vue3 is NOT registered');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 3: two modules sharing the same tag #vue → no error, both indexed
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(tmp, 'a_mod.policy.ap', '# a\nABOUT a\nTAGS #vue\nALWAYS do a\n');
    writeMod(tmp, 'b_mod.policy.ap', '# b\nABOUT b\nTAGS #vue\nALWAYS do b\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 0, 'no errors when both modules use the same tag');
    assert.equal(Object.keys(index.exports).length, 2, 'both modules indexed');
    assert.equal(index.byTag['#vue'].length, 2, '#vue has 2 entries');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 4: typescript typo — #typescript then #typscript → error on second
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(tmp, 'a_mod.policy.ap', '# a\nABOUT a\nTAGS #typescript\nALWAYS do a\n');
    writeMod(tmp, 'b_mod.policy.ap', '# b\nABOUT b\nTAGS #typscript\nALWAYS do b\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 1, 'one error for typo tag');
    assert.ok(index.errors[0].message.includes('"#typscript"'), 'error mentions typscript');
    assert.ok(index.errors[0].message.includes('"#typescript"'), 'error mentions existing typescript');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 5: module with 3 unique tags → no errors, byTag populated
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(tmp, 'a_mod.policy.ap', '# a\nABOUT a\nTAGS #laravel #php #backend\nALWAYS do a\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 0, 'no errors for 3 unique tags');
    assert.equal(Object.keys(index.exports).length, 1, 'module indexed');
    assert.ok(index.byTag['#laravel'], '#laravel in byTag');
    assert.ok(index.byTag['#php'], '#php in byTag');
    assert.ok(index.byTag['#backend'], '#backend in byTag');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 6: determinism — first-wins depends on alphabetical sort
//   With #vue before #vue3 (alphabetical): error on vue3-carrying module.
//   If file names are swapped, vue3 comes first and wins; error lands on vue.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    // alpha sort: a_vue.policy.ap < b_vue3.policy.ap → vue wins
    writeMod(tmp, 'a_vue.policy.ap', '# av\nABOUT av\nTAGS #vue\nALWAYS do a\n');
    writeMod(tmp, 'b_vue3.policy.ap', '# bv\nABOUT bv\nTAGS #vue3\nALWAYS do b\n');

    const index1 = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index1.errors.length, 1);
    assert.ok(index1.errors[0].message.includes('"#vue3"'), 'vue3 is the late-comer when a_vue comes first');
    assert.ok(index1.byTag['#vue'], '#vue wins (first alphabetically)');
  } finally {
    rmSync(tmp, { recursive: true });
  }

  // Now flip: vue3 file sorts before vue file
  const tmp2 = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(tmp2, 'a_vue3.policy.ap', '# av3\nABOUT av3\nTAGS #vue3\nALWAYS do a\n');
    writeMod(tmp2, 'b_vue.policy.ap', '# bv\nABOUT bv\nTAGS #vue\nALWAYS do b\n');

    const index2 = buildMetadataIndex(makeConfig(tmp2));
    assert.equal(index2.errors.length, 1);
    assert.ok(index2.errors[0].message.includes('"#vue"'), 'vue is the late-comer when a_vue3 comes first');
    assert.ok(index2.byTag['#vue3'], '#vue3 wins (first alphabetically)');
  } finally {
    rmSync(tmp2, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 7: untagged EXPORT block → indexed, no error, absent from byTag
//   An EXPORT block without TAGS is indexed unconditionally — never dropped.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    writeMod(
      tmp,
      'a.policy.ap',
      '# a\nEXPORT POLICY untagged-rule:\n  ABOUT no tags here\n  ALWAYS do something\n',
    );

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 0, 'no error for untagged EXPORT block');
    assert.equal(Object.keys(index.exports).length, 1, 'untagged EXPORT block IS indexed');
    const entry = Object.values(index.exports)[0];
    assert.equal(entry.name, 'untagged-rule', 'the export block name is preserved');
    assert.deepEqual(entry.tags, [], 'no declared tags on the entry');
    assert.equal(Object.keys(index.byTag).length, 0, 'untagged export contributes nothing to byTag');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Case 8: mixed file — untagged EXPORT block indexed, untagged legacy dropped
//   The legacy TAGS-required contract is unchanged; only EXPORT blocks survive
//   absent tagging. A tagged EXPORT block alongside an untagged one both index.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-lint-'));
  try {
    // EXPORT-block file: one untagged block + one tagged block, both indexed.
    writeMod(
      tmp,
      'a.policy.ap',
      '# a\n' +
        'EXPORT POLICY untagged-rule:\n  ABOUT no tags\n  ALWAYS do a\n\n' +
        'EXPORT POLICY tagged-rule:\n  ABOUT has tags\n  TAGS #governed\n  ALWAYS do b\n',
    );
    // Legacy file (no EXPORT block) with no TAGS → dropped with an error, as before.
    writeMod(tmp, 'z_legacy.policy.ap', '# z\nABOUT legacy untagged\nALWAYS do z\n');

    const index = buildMetadataIndex(makeConfig(tmp));
    assert.equal(index.errors.length, 1, 'only the legacy untagged file errors');
    assert.ok(index.errors[0].message.includes('module has no TAGS'), 'legacy drop reason unchanged');
    assert.ok(index.errors[0].file.includes('z_legacy'), 'the error is for the legacy file');

    const keys = Object.keys(index.exports);
    assert.equal(keys.length, 2, 'both EXPORT blocks indexed; legacy file dropped');
    assert.ok(index.byTag['#governed'], 'the tagged export block populates byTag');
    assert.equal(index.byTag['#governed'].length, 1, 'only the tagged block is under #governed');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

console.log('libraryIndexLint tests passed.');
