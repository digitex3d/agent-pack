// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the recursive body renderer (renderTree): sequence grouping plus
 * byte-identical reuse of the leaf primitive renderers.
 */
import { strict as assert } from 'assert';

const { renderTree } = await import('../dist/src/bundlers/renderTree.js');

// ---------------------------------------------------------------------------
// 1. STEP sequence grouping → numbered "Steps:" list with reindented bodies
// ---------------------------------------------------------------------------

{
  const out = renderTree([
    'STEP first:',
    '  BY alice',
    '  DO do the thing',
    'STEP second:',
    '  DO other',
  ].join('\n'));

  assert.ok(out.includes('Steps:'), `has Steps header, got:\n${out}`);
  assert.ok(out.includes('2. second'), `second item numbered, got:\n${out}`);
  // BY is a signature argument folded into the head, not a body line.
  assert.ok(out.includes('1. first — by `alice`'), `BY in signature, got:\n${out}`);
  assert.ok(!/^\s*By `alice`/m.test(out), `BY must not appear as a body line, got:\n${out}`);
  // The body (DO) renders under the item, reindented.
  assert.ok(out.includes('Do do the thing'), `body action present, got:\n${out}`);

  console.log('renderTree STEP grouping test passed.');
}

// ---------------------------------------------------------------------------
// 1b. Multiple signature arguments render inline in declared order
// ---------------------------------------------------------------------------

{
  const out = renderTree([
    'STEP review:',
    '  BY bob',
    '  CONTEXT full',
    '  DO check it',
  ].join('\n'));

  assert.ok(out.includes('1. review — by `bob`, full context'), `BY + CONTEXT signature, got:\n${out}`);
  assert.ok(!out.includes('passes the full upstream context'), `CONTEXT must render terse as an arg, got:\n${out}`);

  console.log('renderTree definition arguments test passed.');
}

// ---------------------------------------------------------------------------
// 2. Leaf force-level grouping is byte-identical to the flat pipeline
// ---------------------------------------------------------------------------

{
  const out = renderTree('MUST a\nMUST b');
  assert.equal(out, 'You must:\n- a\n- b', `MUST grouping, got: ${JSON.stringify(out)}`);

  console.log('renderTree leaf force-level grouping test passed.');
}

// ---------------------------------------------------------------------------
// 3. Non-keyword node with an indented body keeps its children (regression:
//    prose blocks with an indented body must not drop their children)
// ---------------------------------------------------------------------------

{
  const src = [
    'PROFILE default',
    '  shape: open response',
    '  rules:',
    '    - answer freely',
  ].join('\n');
  const out = renderTree(src);

  for (const line of ['PROFILE default', '  shape: open response', '  rules:', '    - answer freely']) {
    assert.ok(out.includes(line), `preserves "${line}", got:\n${out}`);
  }

  console.log('renderTree non-keyword body preservation test passed.');
}

// ---------------------------------------------------------------------------
// 4. Enum primitive (CONTEXT) still resolves inside the tree pass
// ---------------------------------------------------------------------------

{
  const out = renderTree('CONTEXT full');
  assert.equal(out, 'passes the full upstream context, as-is', `CONTEXT enum, got: ${JSON.stringify(out)}`);

  console.log('renderTree enum primitive test passed.');
}

console.log('All renderTree tests passed.');
