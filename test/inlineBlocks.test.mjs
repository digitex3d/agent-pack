// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for inline blocks written inside an agent file (`extractInlineDefinitions`).
 *
 * An inline block goes through the same metadata seam as an imported unit
 * (`liftUnitMetadata`): its ABOUT and TAGS are lifted onto the Definition and
 * stripped from the body — they must never reach the bundle as raw lines —
 * while `AS <template>`, the block's output contract, stays in the body.
 */

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { extractInlineDefinitions } = await import('../dist/src/dispatch/inlineBlocks.js');
const { makeBundleContext } = await import('../dist/src/compiler/index.js');

{
  const ctx = makeBundleContext({ agentName: 'a', libraryRoot: '/nowhere', libraryRoots: ['/nowhere'] });
  const source = [
    'EXPORT AGENT a AS a-role:',
    '    ABOUT  an agent',
    '',
    'PROCEDURE verify-claim:',
    '    ABOUT  back one claim with independent sources',
    '    TAGS   #research',
    '    DO     search for the claim',
    '    AS     finding',
    '',
  ].join('\n');

  extractInlineDefinitions(source, ctx, '/nowhere/a.ap');

  const proc = ctx.procedures.find(p => p.name === 'verify-claim');
  assert.ok(proc, 'inline PROCEDURE collected');
  assert.equal(proc.about, 'back one claim with independent sources', 'ABOUT lifted onto the definition');
  assert.deepEqual(proc.tags, ['#research'], 'TAGS lifted onto the definition');
  assert.ok(!/ABOUT|TAGS/.test(proc.body), 'metadata lines stripped from the body');
  assert.ok(proc.body.includes('DO     search for the claim'), 'content lines kept');
  assert.ok(/^AS\s+finding$/m.test(proc.body), 'AS (the output contract) is content, never stripped');
}

{
  // POLICY is inline-able like every other kind: collected, metadata lifted.
  const ctx = makeBundleContext({ agentName: 'a', libraryRoot: '/nowhere', libraryRoots: ['/nowhere'] });
  const source = [
    'EXPORT POLICY board-rules:',
    '    ABOUT  how the board is kept',
    '    TAGS   #board',
    '    ALWAYS keep one card per task',
    '',
    'EXPORT AGENT a AS a-role:',
    '    ABOUT  an agent',
    '',
  ].join('\n');

  extractInlineDefinitions(source, ctx, '/nowhere/a.ap');

  const policy = ctx.policies.find(p => p.name === 'board-rules');
  assert.ok(policy, 'inline POLICY collected');
  assert.equal(policy.about, 'how the board is kept', 'ABOUT lifted onto the definition');
  assert.deepEqual(policy.tags, ['#board'], 'TAGS lifted onto the definition');
  assert.ok(policy.body.includes('ALWAYS keep one card per task'), 'rules kept in the body');
}

{
  // EXTENDS on an inline ROLE resolves like a library role's: parent rules first, no raw line.
  const lib = mkdtempSync(join(tmpdir(), 'ap-inline-extends-'));
  try {
    mkdirSync(join(lib, 'roles'));
    writeFileSync(join(lib, 'roles', 'careful-reader.ap'),
      ['EXPORT ROLE careful-reader:', '    ABOUT   reads everything first', '    TAGS    #reading', '    ALWAYS  read the whole change first', ''].join('\n'));
    const ctx = makeBundleContext({ agentName: 'a', libraryRoot: lib, libraryRoots: [lib] });
    const source = [
      'EXPORT AGENT a AS code-reviewer:',
      '    ABOUT  an agent',
      '',
      'ROLE code-reviewer:',
      '    ABOUT    a careful reviewer',
      '    EXTENDS  careful-reader',
      '    ALWAYS   quote the line a finding is about',
      '',
    ].join('\n');

    extractInlineDefinitions(source, ctx, join(lib, 'a.ap'));

    const role = ctx.roles.find(r => r.name === 'code-reviewer');
    assert.ok(role, 'inline ROLE collected');
    assert.ok(!/EXTENDS/.test(role.body), 'the EXTENDS line never reaches the body');
    const parentAt = role.body.indexOf('read the whole change first');
    const ownAt = role.body.indexOf('quote the line a finding is about');
    assert.ok(parentAt !== -1 && parentAt < ownAt, "the parent's rules come before the role's own");
    assert.ok(role.tags.includes('#reading'), "the parent's tags are inherited");
  } finally {
    rmSync(lib, { recursive: true });
  }
}

console.log('inline-block metadata tests passed.');
