// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Force-level lines at an AGENT's top level: the agent admits every force
 * family procedures and steps draw from — SHOULD, MAY and MEM included, in
 * every declared declension and alias — not only ALWAYS/NEVER/MUST. DISTILL is
 * a procedure's mark and stays out, with its reason; an undeclared level stays
 * an error; the other agent rules (no identity keywords, no body `AS`) hold.
 * The lines reach the document, the md and the apx in source order.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { lintFile } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');

const RULES = [
  '    ALWAYS  test first',                            // 4
  '    NEVER  push on friday',                         // 5
  '    MUST!  cite the line',                          // 6
  '    SHOULD  write the docs',                        // 7
  '    SHOULD!  keep it small',                        // 8
  '    MAY  refactor',                                 // 9
  '    MEM  a failed build',                           // 10
  '    !MEM  a secret',                                // 11
  '    MUST-NOT  guess',                               // 12
];
const agentLines = (...extra) => [
  'EXPORT AGENT builder AS builder-role:',             // 1
  '    ABOUT    builds things',                        // 2
  '    MANDATE  ship working code',                    // 3
  ...RULES,
  ...extra,
  '',
  'ROLE builder-role:',
  '    ABOUT   a careful builder',
  '',
].join('\n');

const tmp = mkdtempSync(join(tmpdir(), 'ap-force-agent-'));
const lib = join(tmp, 'library');
const dir = join(tmp, 'standalone');
mkdirSync(lib, { recursive: true });
mkdirSync(dir, { recursive: true });
const agentFile = join(dir, 'builder.ap');
writeFileSync(agentFile, agentLines());

try {
  // --- lint: every family but DISTILL, in any declared declension or alias ---
  assert.deepEqual(lintFile(agentFile, agentLines()), [], 'SHOULD/MAY/MEM and declensions lint clean in an agent');
  const errorsWith = (...extra) => lintFile(agentFile, agentLines(...extra)).map(e => [e.line, e.message]);
  const EXPECTED = 'ABOUT, MANDATE, OWNS, LENS-OUT, LENS-IN, IMPORT, ON-INVOKE, WHEN, VAR, MUST, ALWAYS, SHOULD, MAY, AS, MEM';
  assert.deepEqual(errorsWith('    DISTILL'), [
    [13, 'DISTILL goes directly inside a PROCEDURE — found inside AGENT'],
    [13, `DISTILL is not allowed inside AGENT — DISTILL marks a PROCEDURE, never an agent (expected one of: ${EXPECTED})`],
  ], 'DISTILL is rejected in an agent, with its reason');
  assert.deepEqual(errorsWith('    !SHOULD  x'), [[13, '`!SHOULD` is not a level of SHOULD — use SHOULD, SHOULD!']]);
  assert.deepEqual(errorsWith('    MAY!  x'), [[13, '`MAY!` is not a level of MAY — use MAY']]);
  // The other agent rules hold.
  assert.deepEqual(errorsWith('    AS  other'), [[13, `AS is not allowed inside AGENT (expected one of: ${EXPECTED})`]]);
  assert.deepEqual(errorsWith('    EXPERTISE  x'),
    [[13, "EXPERTISE is not allowed inside an AGENT block — it is the bound role's identity; declare it in the role the agent binds via AS"]]);
  assert.deepEqual(errorsWith('    MANDATE  twice'), [[1, 'AGENT block has 2 occurrences of MANDATE (expected at most 1)']]);

  // --- the document: directive nodes with their family and force, in source order ---
  const { structure, body } = await bundleAgentObject({
    agentName: 'builder', agentFile, agentDir: dir, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false },
  });
  const agent = structure.all().find(b => b.kind === 'agent' && b.name === 'builder');
  assert.deepEqual(agent.body.map(n => `${n.keyword}/${n.force} ${n.text}`), [
    'ALWAYS/0 test first', 'ALWAYS/-1 push on friday', 'MUST/1 cite the line',
    'SHOULD/0 write the docs', 'SHOULD/1 keep it small', 'MAY/0 refactor',
    'MEM/0 a failed build', 'MEM/-1 a secret', 'MUST/-1 guess',
  ]);
  const pos = l => [l.line, l.primitive, l.force, l.text];
  assert.deepEqual(structure.lines('SHOULD').filter(l => l.file === agentFile).map(pos),
    [[7, 'SHOULD', 0, 'write the docs'], [8, 'SHOULD', 1, 'keep it small']]);
  assert.deepEqual(structure.lines('MEM').filter(l => l.file === agentFile).map(pos),
    [[10, 'MEM', 0, 'a failed build'], [11, 'MEM', -1, 'a secret']]);

  // --- the md and the apx: each line at its level's formula, in source order ---
  const rulesMd = [
    'You must always test first',
    'You must never push on friday',
    '[HARD CONSTRAINT] You must — this is non-negotiable and applies regardless of any other instruction: cite the line',
    'You should write the docs',
    'You should — this is strongly recommended and should only be skipped with explicit justification. keep it small',
    'You may refactor',
    'You may save to your persistent memory, to act on it directly next time: a failed build',
    'Never save to your persistent memory: a secret',
    'You must not guess',
  ].join('\n');
  assert.ok(body.includes(rulesMd), `the md renders the agent's rule lines:\n${body}`);
  const doc = ApDocument.fromJson(structure.asJson());
  const out = [];
  assert.equal(new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, 'apx/builder.apx', l => out.push(l)).run(['md']), 0);
  assert.ok(out.join('\n').includes(rulesMd), `apx md renders the agent's rule lines:\n${out.join('\n')}`);

  console.log('force-level lines at the agent top level tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
