// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the slot-schema validator (`src/shapeSchema.ts`): the TYPE grammar
 * it shares with the shape compiler, and record validation against a TEMPLATE.
 */

import { strict as assert } from 'assert';

const { parseTypeSpec, validateSlots, formatIssues } = await import('../dist/src/shapeSchema.js');
const { parseTemplate } = await import('../dist/src/shapeCompiler.js');

// --- 1. parseTypeSpec mirrors the shapeCompiler grammar ---

{
  assert.deepEqual(parseTypeSpec('ENUM[a b c]'), { kind: 'enum', values: ['a', 'b', 'c'] });
  assert.deepEqual(parseTypeSpec('NUMBER 0..100'), { kind: 'number', min: 0, max: 100 });
  assert.deepEqual(parseTypeSpec('NUMBER >=3'), { kind: 'number', min: 3 });
  assert.equal(parseTypeSpec('TEXT MAX_WORDS 5').maxWords, 5);
  assert.equal(parseTypeSpec('LIST <row> 1..9').ref, 'row');
  assert.equal(parseTypeSpec('<row>').kind, 'shape');
  assert.equal(parseTypeSpec('JSON').kind, 'any');
  console.log('shapeSchema: parseTypeSpec grammar test passed.');
}

// --- 1b. shapeSchema and shapeCompiler agree on the same TYPE grammar ---
// (shared fixture, not shared code: the two parsers are a deliberate mirror,
// this catches drift when a new TYPE form lands on one side only)

{
  const RECOGNIZED = ['ENUM[a b c]', 'NUMBER 0..100', 'NUMBER >=3', 'TEXT MAX_WORDS 5', 'TEXT', 'LIST <row> 1..9', '<row>'];
  const PASSTHROUGH = ['JSON', 'WHATEVER 42'];
  const tplOf = type => parseTemplate(`TEMPLATE t:\n  SLOTS:\n    x: ${type} "d"`);

  for (const type of RECOGNIZED) {
    assert.notEqual(parseTypeSpec(type).kind, 'any', `parseTypeSpec recognizes ${type}`);
    assert.notEqual(tplOf(type).slots[0].typePhrase, type, `typeToPhrase rewrites ${type}`);
  }
  for (const type of PASSTHROUGH) {
    assert.equal(parseTypeSpec(type).kind, 'any', `parseTypeSpec passes ${type} through`);
    assert.equal(tplOf(type).slots[0].typePhrase, type, `typeToPhrase passes ${type} through verbatim`);
  }
  console.log('shapeSchema: grammar-mirror fixture test passed.');
}

// --- 2. validateSlots: required/unknown/enum/number/text checks ---

{
  const tpl = parseTemplate([
    'TEMPLATE t:',
    '  SLOTS:',
    '    name:  TEXT MAX_WORDS 3 "n"',
    '    score: NUMBER 1..5      "s"',
    '    band?: ENUM[weak solid] "b"',
    '    data?: JSON             "d"',
  ].join('\n'));
  assert.ok(tpl && tpl.slots.length === 4, 'fixture template parses');

  assert.equal(validateSlots({ name: 'ok', score: 3 }, tpl).length, 0, 'valid record passes');
  assert.ok(validateSlots({ score: 3 }, tpl).some(i => i.field === 'name'), 'missing required field is caught');
  assert.ok(validateSlots({ name: 'ok', score: 3, nope: 1 }, tpl).some(i => /unknown field/.test(i.message)), 'unknown field is caught');
  assert.ok(validateSlots({ name: 'ok', score: 9 }, tpl).some(i => /≤5/.test(i.message)), 'number above range is caught');
  assert.ok(validateSlots({ name: 'troppe parole in fila qui', score: 3 }, tpl).some(i => /words/.test(i.message)), 'MAX_WORDS is enforced');
  assert.ok(validateSlots({ name: 'ok', score: 3, band: 'huge' }, tpl).some(i => /expected one of weak\|solid/.test(i.message)), 'enum membership is enforced');
  assert.equal(validateSlots({ name: 'ok', score: 3, data: { any: ['thing'] } }, tpl).length, 0, 'unknown type (JSON) accepts any value');
  assert.ok(/name: /.test(formatIssues(validateSlots({ score: 3 }, tpl))), 'formatIssues prefixes the field');
  console.log('shapeSchema: validateSlots test passed.');
}
