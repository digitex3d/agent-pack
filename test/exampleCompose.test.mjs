// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `{slug.EXAMPLE}` in a compiled agent — a template's EXAMPLE composes another
 * template's EXAMPLE in, through the document the agent compiles to (the
 * renderTemplate path has its own tests in shapeCompiler.test.mjs).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-example-compose-'));
const lib = join(tmp, 'library');
mkdirSync(lib);

const ROW = [
  'TEMPLATE file-change:', '    ABOUT  one changed file', '    SLOTS:', '        path: TEXT "the path"', '        what: TEXT "what changed"',
  '    BODY:', '        {path} — {what}', '    EXAMPLE:', '        src/a.php — logo path read from the options', '',
];
const report = example => [
  'TEMPLATE change-report:', '    ABOUT  a change', '    SLOTS:', '        files: LIST <file-change> >=1 "one entry per file"',
  '    BODY:', '        files:', '        {files}', '    EXAMPLE:', '        files:', `        ${example}`, '',
];
async function compile(name, templates) {
  const file = join(tmp, `${name}.ap`);
  writeFileSync(file, [`EXPORT AGENT ${name} AS ${name}-role:`, '    ABOUT  an agent', '    ON-INVOKE:', '        AS  change-report', '',
    `ROLE ${name}-role:`, '    ABOUT  a worker', '', ...templates].join('\n'));
  return bundleAgentObject({ agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false } });
}

try {
  const c = await compile('ok', [...ROW, ...report('{file-change.EXAMPLE}')]);
  assert.ok(c.body.includes('<example>\nfiles:\nsrc/a.php — logo path read from the options\n</example>'), c.body);
  assert.ok(!c.body.includes('{file-change.EXAMPLE}'), 'the marker never reaches the compiled text');
  assert.equal(c.structure.templateNamed('change-report').example, 'files:\n{file-change.EXAMPLE}', 'the document keeps the source EXAMPLE');

  await assert.rejects(compile('ghost', [...ROW, ...report('{ghost.EXAMPLE}')]), /unknown shape "ghost"/, 'a template no one declares');
  const noExample = ROW.slice(0, ROW.indexOf('    EXAMPLE:')).concat('');
  await assert.rejects(compile('bare', [...noExample, ...report('{file-change.EXAMPLE}')]), /"file-change" has no EXAMPLE/, 'a template with no EXAMPLE');
  await assert.rejects(compile('loop', [...ROW, ...report('{change-report.EXAMPLE}')]), /circular/, 'a template composing itself');

  console.log('EXAMPLE composition in compiled agents tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
