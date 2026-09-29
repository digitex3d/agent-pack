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
  // Gap 1: Verify stripPrimitives removes APPLIES and TAGS from body
  // (library rendering pipeline uses this to strip metadata keywords)
  // -----------------------------------------------------------------------

  const sourceWithMetadata = [
    '# security-policy',
    'ABOUT  require security role for sensitive tasks',
    'APPLIES requires:security-role for agents with security clearance',
    'TAGS #security #access-control #compliance',
    'POLICY security-policy',
    'ALWAYS  require security audit for sensitive operations',
  ].join('\n');

  const stripped = stripPrimitives(sourceWithMetadata, 'APPLIES', 'TAGS');

  // Metadata keywords must be stripped
  assert.ok(!stripped.includes('APPLIES'), 'APPLIES keyword stripped');
  assert.ok(!stripped.includes('TAGS'), 'TAGS keyword stripped');
  assert.ok(!stripped.includes('requires:security-role'), 'APPLIES payload stripped');
  assert.ok(!stripped.includes('#security'), 'TAGS payload stripped');
  assert.ok(!stripped.includes('#access-control'), 'TAGS payload #2 stripped');
  assert.ok(!stripped.includes('#compliance'), 'TAGS payload #3 stripped');

  // Structural keywords must remain
  assert.ok(stripped.includes('POLICY security-policy'), 'POLICY keyword preserved');
  assert.ok(stripped.includes('ALWAYS'), 'ALWAYS keyword preserved');
  assert.ok(stripped.includes('require security audit'), 'body content preserved');

  console.log('stripPrimitives APPLIES/TAGS stripping test passed.');

  // -----------------------------------------------------------------------
  // Gap 2: Verify stripPrimitives removes only top-level APPLIES/TAGS
  // (indented occurrences like in code blocks are preserved)
  // -----------------------------------------------------------------------

  const sourceWithIndentedMetadata = [
    '# example',
    'ABOUT  documentation',
    'APPLIES universal for everyone',
    'TAGS #docs',
    'POLICY example-policy',
    'ALWAYS follow this',
    '  Here is an indented APPLIES example:',
    '  APPLIES special for edge cases',
    '  And an indented TAGS example:',
    '  TAGS #special #edge-case',
  ].join('\n');

  const strippedIndented = stripPrimitives(sourceWithIndentedMetadata, 'APPLIES', 'TAGS');

  // Top-level keywords stripped
  assert.ok(!strippedIndented.match(/^APPLIES/m), 'top-level APPLIES stripped');
  assert.ok(!strippedIndented.match(/^TAGS/m), 'top-level TAGS stripped');

  // Indented occurrences preserved
  assert.ok(strippedIndented.includes('  APPLIES special for edge cases'), 'indented APPLIES preserved');
  assert.ok(strippedIndented.includes('  TAGS #special #edge-case'), 'indented TAGS preserved');

  console.log('stripPrimitives preserves indented metadata test passed.');

  // -----------------------------------------------------------------------
  // Gap 3: Verify extractPrimitives extracts APPLIES/TAGS correctly
  // (library index uses this to populate metadata fields)
  // -----------------------------------------------------------------------

  {
    const { extractPrimitives } = await import('../dist/src/services/text.js');

    const source = [
      '# test',
      'APPLIES requires:security-role for agents with security clearance',
      'TAGS #security #access-control #compliance',
      'WHEN a security vulnerability is reported',
      'POLICY test-policy',
    ].join('\n');

    const applies = extractPrimitives(source, 'APPLIES');
    const tags = extractPrimitives(source, 'TAGS');
    const when = extractPrimitives(source, 'WHEN');

    assert.equal(applies.length, 1, 'extractPrimitives finds APPLIES');
    assert.equal(applies[0], 'requires:security-role for agents with security clearance', 'APPLIES raw text extracted verbatim');

    assert.equal(tags.length, 1, 'extractPrimitives finds TAGS');
    assert.equal(tags[0], '#security #access-control #compliance', 'TAGS payload extracted verbatim');

    assert.equal(when.length, 1, 'extractPrimitives finds WHEN');
    assert.equal(when[0], 'a security vulnerability is reported', 'WHEN payload extracted verbatim');

    console.log('extractPrimitives extraction test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 4: Verify multiple APPLIES/TAGS lines are all extracted
  // -----------------------------------------------------------------------

  {
    const { extractPrimitives } = await import('../dist/src/services/text.js');

    const source = [
      '# multi',
      'APPLIES universal for everyone',
      'APPLIES optional for some contexts',
      'TAGS #tag1 #tag2',
      'TAGS #tag3',
      'POLICY multi',
    ].join('\n');

    const applies = extractPrimitives(source, 'APPLIES');
    const tags = extractPrimitives(source, 'TAGS');

    assert.equal(applies.length, 2, 'extractPrimitives finds both APPLIES lines');
    assert.equal(applies[0], 'universal for everyone', 'first APPLIES extracted');
    assert.equal(applies[1], 'optional for some contexts', 'second APPLIES extracted');

    assert.equal(tags.length, 2, 'extractPrimitives finds both TAGS lines');

    console.log('extractPrimitives multiple lines test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 5: Verify APPLIES/TAGS primitives render as empty in renderNeutral
  // -----------------------------------------------------------------------

  {
    const { AppliesPrimitive, TagsPrimitive } = await import('../dist/src/primitives.js');

    // renderNeutral should return empty string for both
    assert.equal(AppliesPrimitive.renderNeutral([]), '', 'AppliesPrimitive.renderNeutral returns empty');
    assert.equal(AppliesPrimitive.renderNeutral(['requires:security-role']), '', 'AppliesPrimitive.renderNeutral with values returns empty');

    assert.equal(TagsPrimitive.renderNeutral([]), '', 'TagsPrimitive.renderNeutral returns empty');
    assert.equal(TagsPrimitive.renderNeutral(['#tag1', '#tag2']), '', 'TagsPrimitive.renderNeutral with values returns empty');

    console.log('Primitives renderNeutral empty test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 6: Verify AppliesPrimitive and TagsPrimitive contribute no frontmatter
  // -----------------------------------------------------------------------

  {
    const { AppliesPrimitive, TagsPrimitive } = await import('../dist/src/primitives.js');

    // contributesFrontmatter should return null for all adapters
    assert.equal(AppliesPrimitive.contributesFrontmatter('claude-code', []), null, 'AppliesPrimitive contributes no frontmatter');
    assert.equal(AppliesPrimitive.contributesFrontmatter('claude-code', ['requires:security-role']), null, 'AppliesPrimitive contributes no frontmatter with values');

    assert.equal(TagsPrimitive.contributesFrontmatter('claude-code', []), null, 'TagsPrimitive contributes no frontmatter');
    assert.equal(TagsPrimitive.contributesFrontmatter('claude-code', ['#tag1']), null, 'TagsPrimitive contributes no frontmatter with values');

    console.log('Primitives frontmatter contribution test passed.');
  }

  // -----------------------------------------------------------------------
  // Gap 7: Verify TAGS lint rule in libraryIndex context
  // (only TAGS declarations with space-separated #tags pass)
  // -----------------------------------------------------------------------

  {
    const dir = join(tmp, 'lint-test');
    mkdirSync(dir, { recursive: true });

    const { buildMetadataIndex } = await import('../dist/src/libraryIndex.js');

    // Valid TAGS with space-separated #tags
    writeFileSync(
      join(dir, 'valid.policy.ap'),
      [
        '# valid',
        'ABOUT  valid policy',
        'TAGS #tag1 #tag2 #tag3',
        'POLICY valid',
        'ALWAYS be valid',
      ].join('\n'),
      'utf-8'
    );

    const config = { libraryRoot: dir, sharedLibraries: [] };
    const index = buildMetadataIndex(config);

    const validKey = Object.keys(index.exports).find(k => k.includes('valid'));
    assert.ok(validKey, 'valid TAGS policy appears in index');
    assert.deepEqual(index.exports[validKey].tags, ['#tag1', '#tag2', '#tag3'], 'TAGS parsed correctly');

    console.log('Library index TAGS parsing test passed.');
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
        '  TAGS #multi-agent #orchestration',
        '  APPLIES universal',
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
    assert.deepEqual(entry.tags, ['#multi-agent', '#orchestration'], 'TAGS extracted from block scope');
    assert.equal(entry.applies, 'universal', 'APPLIES extracted from block scope');

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
      'TAGS #legacy',
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
