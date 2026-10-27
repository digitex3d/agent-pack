// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Domains (D44) and an agent's perimeter: `EXPORT DOMAIN <name>:` declares a
 * region of the code by path (ABOUT, FOR), an agent's WRITES names the domains
 * it may write (and read), READS the ones it may only read. The compiled
 * definition opens with the scope warning — their globs — and lists the
 * domains in their chapter. OWNS is gone: its line fails with the rewrite.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { lintFile } = await import('../dist/src/lint.js');
const { keywordCatalog } = await import('../dist/src/keywordCatalog.js');

const root = mkdtempSync(join(tmpdir(), 'ap-perimeter-'));
const lib = join(root, 'library');
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };
const domain = (name, about, globs) => write(join(lib, 'domains', `${name}.ap`), [`EXPORT DOMAIN ${name}:`, `    ABOUT  ${about}`, `    FOR    ${globs}`]);
domain('api', 'the HTTP layer', 'src/api/**, src/shared/http.ts');
domain('db', 'schema and queries', 'src/db/**');

const compile = (lines, top = ['IMPORT api, db FROM @main.domains', '']) => {
  const file = write(join(root, 'a.ap'), [
    ...top,
    'EXPORT AGENT a AS a-role:', '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '',
    'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work',
  ]);
  return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: root, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};
const has = (text, ...needles) => { for (const n of needles) assert.ok(text.includes(n), `missing ${JSON.stringify(n)} in:\n${text}`); };

try {
  // --- the words: DOMAIN opens a block, WRITES and READS are an agent's fields ---
  const catalog = keywordCatalog();
  assert.equal(catalog.DOMAIN, 'block');
  assert.equal(catalog.WRITES, 'meta');
  assert.equal(catalog.READS, 'meta');

  // --- WRITES and READS: the scope warning lists their globs, the chapter lists the domains ---
  {
    const out = await compile(['    WRITES   api', '    READS    db']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['src/api/**', 'src/shared/http.ts'], reads: ['src/db/**'] });
    has(out.body,
      '> This agent may write only: `src/api/**`, `src/shared/http.ts`.',
      '> Read only: `src/db/**` — and what you may write.',
      'Domains',
      'Files: `src/api/**`, `src/shared/http.ts`.',
      'Files: `src/db/**`.');
    assert.ok(out.body.indexOf('SCOPE — WARNING') < out.body.indexOf('# '), 'the scope warning comes first');
  }
  // --- no READS: whatever it needs; WRITES alone ---
  {
    const out = await compile(['    WRITES   api, db']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['src/api/**', 'src/shared/http.ts', 'src/db/**'], reads: null });
    has(out.body, '> Read whatever you need.');
  }
  // --- READS alone: it writes no file ---
  {
    const out = await compile(['    READS    db']);
    has(out.body, '> This agent writes no file');
  }
  // --- neither: no scope warning ---
  {
    const out = await compile([], []);
    assert.equal(out.structure.perimeter(), null);
    assert.ok(!out.body.includes('SCOPE — WARNING'));
  }
  // --- a domain declared in the agent's own file ---
  {
    const out = await compile(['    WRITES   docs'], ['DOMAIN docs:', '    ABOUT  the documentation', '    FOR    docs/**', '']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['docs/**'], reads: null });
  }

  // --- the names: a domain, once, never both written and read ---
  await assert.rejects(compile(['    WRITES   nope']), /WRITES nope: no DOMAIN is called `nope` — declare it \(`EXPORT DOMAIN nope:` with `FOR <glob>, …`\) or IMPORT it FROM @main.domains/);
  await assert.rejects(compile(['    WRITES   api, api']), /WRITES: `api` is listed twice/);
  await assert.rejects(compile(['    WRITES   api', '    READS    api, db']), /READS api: `api` is in WRITES already — writing a domain reads it/);
  await assert.rejects(compile(['    WRITES   api db']), /`WRITES api db`: separate the items with commas — `WRITES api, db`/);

  // --- OWNS is gone: its line names the rewrite ---
  await assert.rejects(compile(['    OWNS     src/**']), /OWNS was removed — declare the files as `EXPORT DOMAIN <name>:` with `FOR src\/\*\*`, and write `WRITES <name>`/);

  // --- a domain file: ABOUT and FOR once each, globs inside the project, nothing else ---
  {
    const lint = lines => lintFile(write(join(lib, 'domains', 'web.ap'), lines), lines.join('\n') + '\n').map(e => e.message);
    assert.deepEqual(lint(['EXPORT DOMAIN web:', '    ABOUT  the web app', '    FOR    web/**']), []);
    assert.ok(lint(['EXPORT DOMAIN web:', '    ABOUT  the web app']).some(m => /DOMAIN block requires at least one FOR/.test(m)), 'FOR is required');
    assert.ok(lint(['EXPORT DOMAIN web:', '    ABOUT  the web app', '    FOR    ../web/**']).some(m => m.startsWith('FOR `../web/**`: a glob is read from the project root')), 'a glob stays in the project');
    assert.ok(lint(['EXPORT DOMAIN web:', '    ABOUT  the web app', '    FOR    web/**', '    ALWAYS be fast']).some(m => /ALWAYS is not allowed inside DOMAIN/.test(m)), 'a domain holds no rule');
  }
  // --- where a DOMAIN goes: the file top or an agent's body; a CONTRACT's DOMAIN line stays a line ---
  {
    const msgs = lines => lintFile(join(root, 'p.ap'), lines.join('\n') + '\n').map(e => e.message);
    assert.ok(msgs(['EXPORT PROCEDURE p:', '    ABOUT  p', '    DOMAIN docs:', '        ABOUT  d', '        FOR    docs/**'])
      .some(m => m === "a DOMAIN is declared at the file top or directly in an agent's body — found inside PROCEDURE"));
    assert.ok(msgs(['EXPORT PROCEDURE p:', '    ABOUT  p', '    FOR    docs/**']).some(m => m === 'FOR is a line of a DIMENSION or a DOMAIN block — found inside PROCEDURE'));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('perimeter tests passed.');
