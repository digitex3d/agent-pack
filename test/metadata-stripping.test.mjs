// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stripPrimitives } from '../dist/src/services/text.js';

const tmp = mkdtempSync(join(tmpdir(), 'ap-metadata-strip-'));

try {
  // -----------------------------------------------------------------------
  // Gap 1: Verify stripPrimitives removes APPLIES from body
  // (library rendering pipeline uses this to strip metadata keywords)
  // -----------------------------------------------------------------------

  const sourceWithMetadata = [
    '# security-policy',
    'ABOUT  require security role for sensitive tasks',
    'APPLIES #security #access-control #compliance universal',
    'POLICY security-policy',
    'ALWAYS  require security audit for sensitive operations',
  ].join('\n');

  const stripped = stripPrimitives(sourceWithMetadata, 'APPLIES');

  // Metadata keywords must be stripped
  assert.ok(!stripped.includes('APPLIES'), 'APPLIES keyword stripped');
  assert.ok(!stripped.includes('universal'), 'APPLIES perimeter stripped');
  assert.ok(!stripped.includes('#security'), 'APPLIES payload stripped');
  assert.ok(!stripped.includes('#access-control'), 'APPLIES payload #2 stripped');
  assert.ok(!stripped.includes('#compliance'), 'APPLIES payload #3 stripped');

  // Structural keywords must remain
  assert.ok(stripped.includes('POLICY security-policy'), 'POLICY keyword preserved');
  assert.ok(stripped.includes('ALWAYS'), 'ALWAYS keyword preserved');
  assert.ok(stripped.includes('require security audit'), 'body content preserved');

  console.log('stripPrimitives APPLIES stripping test passed.');

  // -----------------------------------------------------------------------
  // Gap 2: Verify stripPrimitives removes only top-level APPLIES
  // (indented occurrences like in code blocks are preserved)
  // -----------------------------------------------------------------------

  const sourceWithIndentedMetadata = [
    '# example',
    'ABOUT  documentation',
    'APPLIES universal for everyone',
    'APPLIES #docs',
    'POLICY example-policy',
    'ALWAYS follow this',
    '  Here is an indented APPLIES example:',
    '  APPLIES special for edge cases',
    '  And an indented APPLIES example:',
    '  APPLIES #special #edge-case',
  ].join('\n');

  const strippedIndented = stripPrimitives(sourceWithIndentedMetadata, 'APPLIES', 'APPLIES');

  // Top-level keywords stripped
  assert.ok(!strippedIndented.match(/^APPLIES/m), 'top-level APPLIES stripped');
  assert.ok(!strippedIndented.match(/^APPLIES/m), 'top-level APPLIES stripped');

  // Indented occurrences preserved
  assert.ok(strippedIndented.includes('  APPLIES special for edge cases'), 'indented APPLIES preserved');
  assert.ok(strippedIndented.includes('  APPLIES #special #edge-case'), 'indented APPLIES preserved');

  console.log('stripPrimitives preserves indented metadata test passed.');

  // -----------------------------------------------------------------------
  // Gap 3: Verify extractPrimitives extracts APPLIES correctly
  // (library index uses this to populate metadata fields)
  // -----------------------------------------------------------------------

  {
    const { extractPrimitives } = await import('../dist/src/services/text.js');

    const source = [
      '# test',
      'APPLIES #security #access-control #compliance',
      'WHEN a security vulnerability is reported',
      'POLICY test-policy',
    ].join('\n');

    const tags = extractPrimitives(source, 'APPLIES');
    const when = extractPrimitives(source, 'WHEN');

    assert.equal(tags.length, 1, 'extractPrimitives finds APPLIES');
    assert.equal(tags[0], '#security #access-control #compliance', 'APPLIES payload extracted verbatim');

    assert.equal(when.length, 1, 'extractPrimitives finds WHEN');
    assert.equal(when[0], 'a security vulnerability is reported', 'WHEN payload extracted verbatim');

    console.log('extractPrimitives extraction test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 4: Verify multiple APPLIES lines are all extracted
  // -----------------------------------------------------------------------

  {
    const { extractPrimitives } = await import('../dist/src/services/text.js');

    const source = [
      '# multi',
      'APPLIES #tag1 #tag2',
      'APPLIES #tag3',
      'POLICY multi',
    ].join('\n');

    const tags = extractPrimitives(source, 'APPLIES');

    assert.equal(tags.length, 2, 'extractPrimitives finds both APPLIES lines');
    assert.equal(tags[1], '#tag3', 'second APPLIES extracted');

    console.log('extractPrimitives multiple lines test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 5: Verify APPLIES primitives render as empty in renderNeutral
  // -----------------------------------------------------------------------

  {
    const { AppliesPrimitive } = await import('../dist/src/primitives.js');

    assert.equal(AppliesPrimitive.renderNeutral([]), '', 'AppliesPrimitive.renderNeutral returns empty');
    assert.equal(AppliesPrimitive.renderNeutral(['#tag1', 'universal']), '', 'AppliesPrimitive.renderNeutral with values returns empty');

    console.log('Primitives renderNeutral empty test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 6: Verify AppliesPrimitive and TagsPrimitive contribute no frontmatter
  // -----------------------------------------------------------------------

  {
    const { AppliesPrimitive } = await import('../dist/src/primitives.js');

    assert.equal(AppliesPrimitive.contributesFrontmatter('claude-code', []), null, 'AppliesPrimitive contributes no frontmatter');
    assert.equal(AppliesPrimitive.contributesFrontmatter('claude-code', ['#tag1']), null, 'AppliesPrimitive contributes no frontmatter with values');

    console.log('Primitives frontmatter contribution test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 7: Verify APPLIES lint rule in libraryIndex context
  // (only APPLIES declarations with space-separated #tags pass)
  // -----------------------------------------------------------------------

  {
    const dir = join(tmp, 'lint-test');
    mkdirSync(dir, { recursive: true });

    const { buildMetadataIndex } = await import('../dist/src/libraryIndex.js');

    // Valid APPLIES with space-separated #tags
    writeFileSync(
      join(dir, 'valid.policy.ap'),
      [
        '# valid',
        'ABOUT  valid policy',
        'APPLIES #tag1 #tag2 #tag3',
        'POLICY valid',
        'ALWAYS be valid',
      ].join('\n'),
      'utf-8'
    );

    const config = { libraryRoot: dir, sharedLibraries: [] };
    const index = buildMetadataIndex(config);

    const validKey = Object.keys(index.exports).find(k => k.includes('valid'));
    assert.ok(validKey, 'valid APPLIES policy appears in index');
    assert.deepEqual(index.exports[validKey].tags, ['#tag1', '#tag2', '#tag3'], 'APPLIES parsed correctly');

    console.log('Library index APPLIES parsing test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 8: EXPORT-form module indexes correctly (block-scoped metadata)
  // — requirement 3: an export-per-file module must not lose about/tags/applies.
  // -----------------------------------------------------------------------

  {
    const dir = join(tmp, 'export-index-test');
    mkdirSync(dir, { recursive: true });

    const { buildMetadataIndex } = await import('../dist/src/libraryIndex.js');

    writeFileSync(
      join(dir, 'ctx.policy.ap'),
      [
        '# ctx',
        'EXPORT POLICY ctx:',
        '  ABOUT  block-scoped context rules',
        '  APPLIES #multi-agent #orchestration universal',
        '  ALWAYS engineer the environment',
      ].join('\n') + '\n',
      'utf-8',
    );

    const config = { libraryRoot: dir, sharedLibraries: [] };
    const index = buildMetadataIndex(config);

    const key = Object.keys(index.exports).find(k => k.endsWith('/ctx'));
    assert.ok(key, 'EXPORT-form module appears in index keyed by its block name');
    const entry = index.exports[key];
    assert.equal(entry.name, 'ctx', 'name comes from the EXPORT block');
    assert.equal(entry.about, 'block-scoped context rules', 'ABOUT extracted from block scope');
    assert.deepEqual(entry.tags, ['#multi-agent', '#orchestration'], 'APPLIES extracted from block scope');
    assert.deepEqual(entry.scopes, ['universal'], 'APPLIES perimeter extracted from block scope');

    console.log('Library index EXPORT-form module test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 9: legacy file is untouched by the EXPORT seam (no-op normalisation)
  // -----------------------------------------------------------------------

  {
    const { unwrapExportFile } = await import('../dist/src/services/text.js');
    const legacy = [
      '# legacy',
      'ABOUT  legacy file-top metadata',
      'APPLIES #legacy',
      'POLICY legacy',
      'ALWAYS stay at indent 0',
    ].join('\n');
    assert.equal(unwrapExportFile(legacy), legacy, 'legacy file (no EXPORT block) passes through verbatim');

    console.log('EXPORT seam legacy no-op test passed.');
  }

} finally {
  rmSync(tmp, { recursive: true });
}

console.log('All metadata stripping tests passed.');
