// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Characterisation of the lint of ROLE and PROCEDURE (zone lint-kind-keyword-lists,
 * src/lint.ts ROLE_SPEC / PROCEDURE_SPEC and their keyword lists). Each fixture is a
 * source and the exact errors the intact code reports for it — line, message,
 * severity, file, in order: every keyword on one line of a role and a procedure
 * (flat, block form, and through lintFile from a roles/ or procedures/ folder),
 * the duplicate/missing counts, the identity and flow-only rejections, and ROLE /
 * PROCEDURE blocks held in an agent's or a team's file (no new errors there).
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lint = await import('../dist/src/lint.js');
const fixtures = JSON.parse(readFileSync(join(ROOT, 'test', 'lint-role-procedure-specs.fixtures.json'), 'utf8'));

assert.ok(fixtures.length > 500, 'the fixtures are all there');
for (const f of fixtures) {
  const body = f.path ? readFileSync(join(ROOT, f.path), 'utf8') : `${f.lines.join('\n')}\n`;
  const got = lint[f.fn](f.file, body).map(e => [e.line, e.message, e.severity ?? null, e.file]);
  assert.deepEqual(got, f.expected, `${f.name}: ${f.fn}(${f.file}) changed`);
}

// The wording the refactor-spec names, pinned in plain sight.
{
  const flat = lint.lintRole('r.role.ap', '# r\nABOUT r\nEXPERTISE a\nEXPERTISE b\nEXTENDS x\nEXTENDS y\nDO z\n');
  assert.deepEqual(flat.map(e => [e.line, e.message]), [
    [1, 'role has 2 EXTENDS clauses (expected at most 1)'],
    [1, 'role has 2 occurrences of EXPERTISE (expected at most 1)'],
  ]);
}

console.log(`lint role/procedure specs: ${fixtures.length} fixtures pinned`);
