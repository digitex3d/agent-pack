// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * EXTENDS — a role takes its parent's rules first, then its own. A parent that
 * cannot be found, or a chain that loops back, fails the compilation.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-extends-'));
const lib = join(tmp, 'library');
mkdirSync(join(lib, 'roles'), { recursive: true });
const role = (name, parent) => writeFileSync(join(lib, 'roles', `${name}.ap`), [
  `EXPORT ROLE ${name}:`, `    ABOUT    the ${name}`, ...(parent ? [`    EXTENDS  ${parent}`] : []), `    ALWAYS   rule of ${name}`, '',
].join('\n'));
const compile = parent => {
  role('child', parent);
  const file = join(tmp, 'a.ap');
  writeFileSync(file, ['IMPORT child FROM @main.roles', '', 'EXPORT AGENT a AS child:', '    ABOUT  an agent', ''].join('\n'));
  return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};

try {
  role('base');
  const md = (await compile('base')).body;
  assert.ok(md.indexOf('rule of base') < md.indexOf('rule of child'), "the parent's rules come first");

  await assert.rejects(compile('nobody'), /child\.ap:3  EXTENDS nobody: no role `nobody`/, 'a missing parent fails');

  role('loop', 'child');
  await assert.rejects(compile('loop'), /EXTENDS child: circular/, 'a cycle fails');

  console.log('EXTENDS tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
