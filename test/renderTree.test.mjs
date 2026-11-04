// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the recursive body renderer (renderTree): sequence grouping plus
 * byte-identical reuse of the leaf primitive renderers.
 */
import { strict as assert } from 'node:assert';

const { renderTree } = await import('../dist/src/bundlers/renderTree.js');

// ---------------------------------------------------------------------------
// 1. STEP sequence grouping → numbered "Steps:" list with reindented bodies
// ---------------------------------------------------------------------------

{
  const out = renderTree([
    'STEP first:',
    '  DELEGATE do the thing BY alice',
    'STEP second:',
    '  DO other',
  ].join('\n'));

  assert.ok(out.includes('Steps:'), `has Steps header, got:\n${out}`);
  assert.ok(out.includes('1. first\n'), `a step is a label — nothing folded into its head, got:\n${out}`);
  assert.ok(out.includes('2. second'), `second item numbered, got:\n${out}`);
  // The body renders under the item, reindented: whoever runs the flow delegates, with all its context.
  assert.ok(out.includes('Delegate: do the thing — to `alice`, with all your context'), `delegation line, got:\n${out}`);
  assert.ok(out.includes('Do other'), `body action present, got:\n${out}`);

  console.log('renderTree STEP grouping test passed.');
}

// ---------------------------------------------------------------------------
// 1b. A delegation's form says its context; `~` starts it, WAIT takes it back
// ---------------------------------------------------------------------------

{
  const out = renderTree([
    'STEP review:',
    '  DELEGATE~ report the gaps INTO gaps BY bob AS brief',
    '  FORK~ trace the paths INTO paths',
    '  FORK wire it BY carol',
    '  WAIT gaps, paths',
  ].join('\n'));

  assert.ok(out.includes('report the gaps INTO gaps — to `bob`, handing over only what `brief` holds — start it in the background'), out);
  assert.ok(out.includes('trace the paths INTO paths — a fork of yourself, with this whole conversation — start it in the background'), out);
  assert.ok(out.includes('wire it — to `carol`, forked with this whole conversation'), out);
  assert.ok(out.includes('`gaps`, `paths` — every one delivered or blocked'), out);

  // A DELEGATE block: its head, then the lines the one it goes to is told.
  const block = renderTree(['STEP judge:', '  DELEGATE judge the findings BY dave:', '    DO verify every finding'].join('\n'));
  assert.ok(block.includes('judge the findings — to `dave`, with all your context:'), block);
  assert.ok(block.includes('Do verify every finding'), block);

  console.log('renderTree delegation lines test passed.');
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
// 4. Enum primitive (BUDGET) still resolves inside the tree pass
// ---------------------------------------------------------------------------

{
  const out = renderTree('BUDGET cheap');
  assert.equal(out, 'fast, shallow work — the cheapest model', `BUDGET enum, got: ${JSON.stringify(out)}`);

  console.log('renderTree enum primitive test passed.');
}

console.log('All renderTree tests passed.');
