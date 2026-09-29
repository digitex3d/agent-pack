// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { parseBlocks } from '../dist/src/parseBlocks.js';
import { buildRoleIndex, resolveRole, ANCHOR_PRIORITY } from '../dist/src/roleIndex.js';
import { parseAgentSignature } from '../dist/src/definitionArgs.js';

const blocksOf = src => parseBlocks(src).blocks;

// --- parseAgentSignature ---
{
  assert.equal(parseAgentSignature('AS simplifier').role, 'simplifier');
  assert.equal(parseAgentSignature('AS simplifier  MANDATE x').role, 'simplifier');
  assert.equal(parseAgentSignature('').role, null);
  assert.equal(parseAgentSignature('MANDATE only').role, null);
  console.log('parseAgentSignature ok');
}

// --- buildRoleIndex: basic binding + resolveRole ---
{
  const src = [
    'AGENT alice AS simplifier:',
    '  MANDATE keep it lean',
    '',
    'AGENT bob AS architect:',
    '  MANDATE design the system',
  ].join('\n');
  const index = buildRoleIndex({ blocks: blocksOf(src), anchor: 'directory' });

  const simp = resolveRole(index, 'simplifier');
  assert.ok(simp, 'simplifier resolves');
  assert.equal(simp.name, 'alice');
  assert.equal(simp.anchor, 'directory');
  assert.equal(simp.priority, ANCHOR_PRIORITY.directory);

  assert.equal(resolveRole(index, 'architect').name, 'bob');
  assert.equal(resolveRole(index, 'nonexistent'), null, 'unknown role resolves to null');
  console.log('buildRoleIndex basic + resolveRole ok');
}

// --- precedence: directory beats imported ---
{
  const local = 'AGENT local-impl AS simplifier:\n  MANDATE local mandate\n';
  const imported = 'AGENT lib-impl AS simplifier:\n  MANDATE lib mandate\n';
  // Pass imported FIRST to prove order does not matter — priority decides.
  const index = buildRoleIndex(
    { blocks: blocksOf(imported), anchor: 'imported' },
    { blocks: blocksOf(local), anchor: 'directory' },
  );
  const winner = resolveRole(index, 'simplifier');
  assert.equal(winner.name, 'local-impl', 'directory-anchored local agent wins');
  assert.equal(winner.anchor, 'directory');
  console.log('precedence directory > imported ok');
}

// --- precedence: a local agent shadows an imported one silently (no throw) ---
{
  const imported = 'AGENT lib-impl AS simplifier:\n  MANDATE lib\n';
  const local = 'AGENT local-impl AS simplifier:\n  MANDATE local\n';
  assert.doesNotThrow(() => buildRoleIndex(
    { blocks: blocksOf(local), anchor: 'directory' },
    { blocks: blocksOf(imported), anchor: 'imported' },
  ), 'local shadowing imported is not an error');
  console.log('local shadows imported silently ok');
}

// --- ambiguity: two LOCAL agents on the same role throws ---
{
  const src = [
    'AGENT alice AS simplifier:',
    '  MANDATE one',
    '',
    'AGENT bob AS simplifier:',
    '  MANDATE two',
  ].join('\n');
  assert.throws(
    () => buildRoleIndex({ blocks: blocksOf(src), anchor: 'directory' }),
    /ambiguous role binding/,
    'two local agents on same role is an explicit ambiguity error',
  );
  console.log('ambiguity (two local on one role) ok');
}

// --- ambiguity across groups at equal precedence (two imported) throws ---
{
  const a = 'AGENT a AS p:\n  MANDATE x\n';
  const b = 'AGENT b AS p:\n  MANDATE y\n';
  assert.throws(
    () => buildRoleIndex(
      { blocks: blocksOf(a), anchor: 'imported' },
      { blocks: blocksOf(b), anchor: 'imported' },
    ),
    /ambiguous role binding/,
    'two imported agents on same role at equal precedence throws',
  );
  console.log('ambiguity (two imported on one role) ok');
}

// --- AGENT blocks without AS contribute nothing ---
{
  const src = 'AGENT noas:\n  MANDATE nothing bound\n';
  const index = buildRoleIndex({ blocks: blocksOf(src), anchor: 'directory' });
  assert.equal(index.size, 0, 'AGENT without AS is not indexed');
  console.log('AGENT without AS skipped ok');
}

console.log('roleIndex tests passed.');
