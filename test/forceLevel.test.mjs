// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { applyForceLevels } from '../dist/src/forceLevel.js';

// --- basic expansion ---

{
  assert.equal(applyForceLevels('MAY   do something'), 'You may do something', 'MAY');
  assert.equal(applyForceLevels('SHOULD  do something'), 'You should do something', 'SHOULD');
  assert.equal(applyForceLevels('MUST    do something'), 'You must do something', 'MUST');
  assert.equal(applyForceLevels('MUST-NOT do something'), 'You must not do something', 'MUST-NOT');
  assert.equal(applyForceLevels('ALWAYS  write English'), 'You must always write English', 'ALWAYS');
  assert.equal(applyForceLevels('NEVER   skip tests'), 'You must never skip tests', 'NEVER');
  assert.equal(applyForceLevels('WHEN  the task is X'), 'When the task is X', 'WHEN lowercased');
}

{
  const out = applyForceLevels('SHOULD!  do something');
  assert.ok(out.includes('strongly recommended'), 'SHOULD! expands to strong recommendation');
  assert.ok(out.endsWith('do something'), 'action preserved after SHOULD!');
}

{
  const out = applyForceLevels('MUST!   call bundle');
  assert.ok(out.includes('[HARD CONSTRAINT]'), 'MUST! expands to hard constraint');
  assert.ok(out.endsWith('call bundle'), 'action preserved after MUST!');
}

{
  const out = applyForceLevels('NON-NEGOTIABLE  call bundle first');
  assert.ok(out.includes('IDENTITY CONSTRAINT'), 'identity constraint in formula');
  assert.ok(out.includes('Before any other action'), 'precedence clause present');
  assert.ok(out.includes('invalid'), 'output-invalidation clause present');
  assert.ok(out.endsWith('call bundle first'), 'action preserved after NON-NEGOTIABLE');
}

// --- non-interference ---

{
  // MUST-NOT expands to "You must not" (added to FORCE_LEVELS)
  const out = applyForceLevels('MUST-NOT  read .ap files');
  assert.equal(out, 'You must not read .ap files', 'MUST-NOT is expanded');
}

{
  // Keywords mid-line are not expanded
  assert.equal(
    applyForceLevels('text MUST  do something'),
    'text MUST  do something',
    'keyword mid-line is not expanded',
  );
}

{
  // Empty input
  assert.equal(applyForceLevels(''), '', 'empty string unchanged');
}

{
  // No force-level keywords
  assert.equal(
    applyForceLevels('# Title\n\nSome content.'),
    '# Title\n\nSome content.',
    'text without keywords unchanged',
  );
}

// --- multi-line ---

{
  const input = [
    'NON-NEGOTIABLE  call bundle',
    'MUST!   stop if unavailable',
    'MUST    read context',
    'SHOULD  use wiki',
    'MAY     delegate',
    'MUST-NOT  read .ap files',
  ].join('\n');

  const lines = applyForceLevels(input).split('\n');

  assert.ok(lines[0].includes('[IDENTITY CONSTRAINT]'), 'line 0: NON-NEGOTIABLE');
  assert.ok(lines[1].includes('[HARD CONSTRAINT]'), 'line 1: MUST!');
  assert.ok(lines[2].startsWith('You must'), 'line 2: MUST');
  assert.ok(lines[3].startsWith('You should'), 'line 3: SHOULD');
  assert.ok(lines[4].startsWith('You may'), 'line 4: MAY');
  assert.ok(lines[5].startsWith('You must not'), 'line 5: MUST-NOT expanded');
}

// --- idempotency: already-expanded text is not re-expanded ---

{
  const once = applyForceLevels('MUST    do something');
  const twice = applyForceLevels(once);
  assert.equal(once, twice, 'applying force levels twice gives the same result');
}

// --- grouping: runs of same keyword collapse to bullet list ---

{
  const input = [
    'MUST do A',
    'MUST do B',
    'MUST do C',
  ].join('\n');
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must:', 'header emitted once with colon');
  assert.equal(out[1], '- do A');
  assert.equal(out[2], '- do B');
  assert.equal(out[3], '- do C');
  assert.equal(out.length, 4, 'no extra lines');
}

{
  // MUST! grouping preserves the [HARD CONSTRAINT] prefix once
  const input = [
    'MUST! follow X',
    'MUST! follow Y',
  ].join('\n');
  const out = applyForceLevels(input);
  assert.equal((out.match(/HARD CONSTRAINT/g) ?? []).length, 1, '[HARD CONSTRAINT] appears once for grouped MUST!');
  assert.ok(out.includes('- follow X'));
  assert.ok(out.includes('- follow Y'));
}

{
  // different consecutive keywords stay individual (no grouping)
  const input = [
    'MUST do A',
    'SHOULD do B',
    'MAY do C',
  ].join('\n');
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must do A');
  assert.equal(out[1], 'You should do B');
  assert.equal(out[2], 'You may do C');
}

{
  // a single MUST followed by a non-keyword line stays inline (no grouping)
  const input = 'MUST do A\nplain text';
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must do A');
  assert.equal(out[1], 'plain text');
}

{
  // run interrupted by a different keyword restarts the count
  const input = [
    'MUST do A',
    'WHEN trigger',
    'MUST do B',
    'MUST do C',
  ].join('\n');
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must do A', 'single MUST stays inline');
  assert.equal(out[1], 'When trigger', 'WHEN lowercased between MUSTs');
  assert.equal(out[2], 'You must:', 'second run groups');
  assert.equal(out[3], '- do B');
  assert.equal(out[4], '- do C');
}

{
  // MUST-NOT grouping
  const input = [
    'MUST-NOT do A',
    'MUST-NOT do B',
  ].join('\n');
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must not:', 'MUST-NOT header with colon');
  assert.equal(out[1], '- do A');
  assert.equal(out[2], '- do B');
}

{
  // ALWAYS / NEVER grouping
  const input = [
    'ALWAYS apply DRY',
    'ALWAYS remove dead code',
    'ALWAYS prefer composability',
    'NEVER add features for hypothetical needs',
    'NEVER duplicate shared types',
  ].join('\n');
  const out = applyForceLevels(input).split('\n');
  assert.equal(out[0], 'You must always:');
  assert.equal(out[1], '- apply DRY');
  assert.equal(out[2], '- remove dead code');
  assert.equal(out[3], '- prefer composability');
  assert.equal(out[4], 'You must never:');
  assert.equal(out[5], '- add features for hypothetical needs');
  assert.equal(out[6], '- duplicate shared types');
}

// --- Parametric forms (new: direct canonical notation) ---

{
  // !MUST (negation prefix) → same output as MUST-NOT
  assert.equal(
    applyForceLevels('!MUST do X'),
    'You must not do X',
    '!MUST do X → You must not do X',
  );
}

{
  // MUST!! (level 2 amplification) → IDENTITY CONSTRAINT intro
  const out = applyForceLevels('MUST!! call bundle');
  assert.ok(out.includes('[IDENTITY CONSTRAINT]'), 'MUST!! contains [IDENTITY CONSTRAINT]');
  assert.ok(out.includes('Before any other action'), 'MUST!! contains precedence clause');
  assert.ok(out.endsWith('call bundle'), 'MUST!! action preserved');
}

{
  // !ALWAYS (negation of ALWAYS) → same output as NEVER
  assert.equal(
    applyForceLevels('!ALWAYS skip tests'),
    'You must never skip tests',
    '!ALWAYS skip tests → You must never skip tests',
  );
}

console.log('applyForceLevels tests passed.');
