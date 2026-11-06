// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Store drivers: the contract holds for both shipped drivers and for a driver
 * loaded from a module, and a module that is no valid driver is refused.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runDriverContract } = await import('../dist/src/storeDrivers/contract.js');
const { loadDrivers, storeDriverOf, useTabeliEngine } = await import('../dist/src/storeDrivers/registry.js');
const { parseFilter } = await import('../dist/src/storeDrivers/filters.js');
const { TABELI_ENGINE } = await import('../dist/src/config.js');

const holds = async name => {
  const failed = (await runDriverContract(storeDriverOf(name))).filter(r => !r.ok);
  assert.deepEqual(failed, [], `${name}: the driver contract must hold`);
};

// --- filters: the operator that splits a field off wins, the longer ones first ---
assert.deepEqual(parseFilter('n>=5'), { field: 'n', op: '>=', value: '5' });
assert.deepEqual(parseFilter('topic~a=b'), { field: 'topic', op: '~', value: 'a=b' });
assert.deepEqual(parseFilter('note=x>y'), { field: 'note', op: '=', value: 'x>y' });
assert.equal(parseFilter('no-operator'), null);

// --- the shipped drivers ---
useTabeliEngine(TABELI_ENGINE);
await holds('files');
await holds('tabeli');

// --- a driver of the config: a module, as anyone writes one, installed under the name it answers ---
// It keeps its records the way files does, under its own name — the contract tests a driver loaded from a module.
const project = mkdtempSync(join(tmpdir(), 'agent-pack-drivers-'));
try {
  const files = pathToFileURL(join(ROOT, 'dist', 'src', 'storeDrivers', 'files', 'index.js')).href;
  writeFileSync(join(project, 'mirror.mjs'), [
    `import filesDriver from '${files}';`,
    "export default ({ name = 'mirror', api = filesDriver.api } = {}) => ({ ...filesDriver, name, api });",
  ].join('\n'));
  const [entry] = await loadDrivers(['./mirror.mjs'], project);
  assert.equal(entry.name, 'mirror');
  assert.equal(entry.module, join(project, 'mirror.mjs'));
  await holds('mirror');
  const [named] = await loadDrivers([{ module: './mirror.mjs', name: 'other' }], project);
  assert.deepEqual(named.options, { name: 'other' }, 'the options travel to the apx as written');
  await assert.rejects(loadDrivers([{ module: './mirror.mjs', name: 'files' }], project), /"files" is the name of a driver agent-pack ships/);
  await assert.rejects(loadDrivers([{ module: './mirror.mjs', api: 99 }], project), /written for driver API 99, this agent-pack runs API 1/);
  await assert.rejects(loadDrivers([{ name: 'x' }], project), /a driver is a module name or path/);
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log('store driver tests passed.');
