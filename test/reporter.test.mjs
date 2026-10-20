// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The reporters: the core reports through `src/report.ts`; the plain reporter
 * prints as agent-pack always did, the pretty one (reporters/pretty) after rustc.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { CompileError, plainReporter, reporter, useReporter } = await import('../dist/src/report.js');
const { prettyReporter } = await import('../dist/reporters/pretty/index.js');
const { logo, banner, isPreRelease } = await import('../dist/reporters/pretty/logo.js');

/** What `fn` writes to stderr and stdout. */
function captured(fn) {
  const out = [];
  const [write, log, error] = [process.stderr.write, console.log, console.error];
  process.stderr.write = s => { out.push(String(s).replace(/\n$/, '')); return true; };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try { fn(); } finally { process.stderr.write = write; console.log = log; console.error = error; }
  return out.join('\n');
}

const tmp = mkdtempSync(join(tmpdir(), 'ap-reporter-'));
try {
  const file = join(tmp, 'flows.ap');
  writeFileSync(file, ['FLOW f:', '    STEP review:', '        BY bob', '        CONTEXT summery', '        DO check it', ''].join('\n'));
  const diag = { file, line: 4, message: 'CONTEXT: unknown value `summery` — did you mean `summary`?' };

  // --- the core's default is the plain reporter; a CompileError carries its diagnostics as data ---
  assert.equal(reporter(), plainReporter);
  const err = new CompileError('Bundle', [diag]);
  assert.deepEqual(err.diagnostics, [diag]);
  assert.equal(err.message, `Bundle failed: 1 lint error(s):\nerror  ${file}:4  CONTEXT: unknown value \`summery\` — did you mean \`summary\`?`, 'the plain text of old');
  assert.equal(captured(() => plainReporter.failed(err, 'agent a on claude-code')), `[agent-pack] failed agent a on claude-code: ${err.message}`);
  assert.equal(captured(() => plainReporter.done({ agents: 2, adapters: 1, files: 3, failures: 1 })), '[agent-pack] bundled 2 agent(s) × 1 adapter(s) → 3 file(s) (1 error(s))');

  // --- pretty: each diagnostic once, with its source line underlined and its hint ---
  const pretty = prettyReporter({ root: tmp, color: false });
  const shown = captured(() => {
    pretty.failed(err, 'agent a on claude-code');
    pretty.failed(new CompileError('Bundle', [diag]), 'agent b on claude-code');
    pretty.done({ agents: 2, adapters: 1, files: 0, failures: 2 });
  });
  assert.equal(shown, [
    'error: CONTEXT: unknown value `summery`',
    '  --> flows.ap:4',
    '  |',
    '3 |         BY bob',
    '4 |         CONTEXT summery',
    '  |         ^^^^^^^^^^^^^^^',
    '  = help: did you mean `summary`?',
    '',
    'error: build failed — 1 error; 2 steps did not complete',
  ].join('\n'), 'the same error met by two agents is shown once');
  const spanned = captured(() => prettyReporter({ root: tmp, color: false }).diagnostics([{ ...diag, col: 17, endCol: 24, severity: 'warning', code: 'r.1' }]));
  assert.ok(spanned.startsWith('warning[r.1]: CONTEXT') && spanned.includes('  |                 ^^^^^^^'), spanned);
  const ok = captured(() => prettyReporter({ root: tmp, color: false }).done({ agents: 1, adapters: 1, files: 4, failures: 0 }));
  assert.match(ok, /^ {4}Finished 1 agent × 1 adapter → 4 files in \d+\.\ds \(--verbose lists them\)$/);

  // --- the wordmark: agent-pack.org's pixels, two rows a line ---
  const plainLogo = logo({ color: false });
  assert.equal(plainLogo.length, 6);
  assert.ok(plainLogo.every(l => l.length <= 76) && plainLogo.join('').match(/[▀▄█]/), plainLogo.join('\n'));
  assert.ok(logo().join('').includes('\x1b[38;2;238;242;252m'), 'the site\'s first tone');
  // --- the banner: the wordmark, then the version — a pre-release before 1.0 or with a pre-release tag ---
  assert.deepEqual([isPreRelease('0.28.0'), isPreRelease('1.2.0-beta.1'), isPreRelease('1.0.0')], [true, true, false]);
  const info = { version: '0.28.0', description: 'A language. It compiles.', author: 'Ada', license: 'MIT', homepage: 'https://x.org',
    repository: 'https://github.com/a/b', issues: 'https://github.com/a/b/issues' };
  const side = banner(info, { color: false, columns: 120 });
  assert.deepEqual(side.slice(-3), [' v0.28.0 · pre-release  A language.', ' It compiles.', ' by Ada · MIT · https://x.org'],
    'the description\'s first sentence beside the version, the rest beneath');
  assert.ok(side.length === 11 && side[2].length > 20, 'mascot and wordmark side by side on a wide terminal');
  assert.equal(banner({ ...info, version: '1.0.0' }, { color: false }).at(-3), ' v1.0.0  A language.');
  assert.ok(banner(info, { color: false, columns: 80 }).length > side.length, 'the mascot above on a narrow terminal');
  assert.deepEqual(banner(info, { color: false, links: true }).slice(-2), [' docs   https://github.com/a/b/tree/main/docs', ' issues https://github.com/a/b/issues']);

  useReporter(plainReporter);
  console.log('reporter tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
