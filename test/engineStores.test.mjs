// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The engine's own tables as stores (src/apx/engineStores.ts), reached
 * through the one store API (src/apx/stores.ts): resolved into the session's
 * folder, their writes checked against their slots like any store's, and the
 * API the only place in the apx that opens a driver.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { engineStore, varsStore, checksStore, delegationsStore } = await import('../dist/src/apx/engineStores.js');
const { resolveStore, open, checkWrite, StoreRefusal } = await import('../dist/src/apx/stores.js');
const { openSessionVars } = await import('../dist/src/apx/sessionVars.js');
const { DelegationTable } = await import('../dist/src/apx/delegations.js');

const tmp = mkdtempSync(join(tmpdir(), 'engine-stores-'));
try {
  // --- resolved into the session's folder, by the default driver ---
  const vars = engineStore(tmp, 's1', 'a', varsStore('session'));
  assert.equal(vars.driver.name, 'files');
  assert.equal(vars.ref.path, join(tmp, '.agent-pack', 'state', 's1', 'session.json'));
  assert.equal(vars.ref.key, 'name', 'a variable is reached by its name');
  const priv = engineStore(tmp, 's1', 'a', varsStore('private/a'));
  assert.equal(priv.ref.path, join(tmp, '.agent-pack', 'state', 's1', 'private', 'a.json'));

  // --- a write is checked against the slots, as any store's ---
  assert.throws(() => checkWrite(engineStore(tmp, 's1', 'a', checksStore), { agent: 'a', cnd: 'c', level: 1, round: 1, threshold: 0.7, outcome: 'maybe', at: 'now' }, true),
    err => err instanceof StoreRefusal && /outcome/.test(err.message), 'an outcome outside the enum is refused');
  assert.throws(() => checkWrite(vars, { name: 'x', value: 'v', by: 'a', colour: 'red' }, true), /colour/, 'an unknown field is refused');
  const sv = openSessionVars(tmp, 's1', 'a');
  sv.write('answer', 'session', { value: '42', type: '', by: 'a' });
  assert.equal(sv.read('answer', 'session'), '42');
  assert.equal(sv.read('answer', 'private'), null, 'a scope of its own');
  const written = JSON.parse(readFileSync(vars.ref.path, 'utf-8'));
  assert.equal(written.docs.length, 1);
  assert.equal(written.docs[0].type, undefined, 'an empty field is left out of the record');
  sv.record({ cnd: 'c', level: 1, round: 1, fingerprint: '', model: '', p: '', threshold: 0.7, outcome: 'closed', at: 't' });
  assert.deepEqual(sv.checks('c').map(c => [c.round, c.outcome, c.fingerprint]), [[1, 'closed', '']], 'read back as declared, an absent field as empty');

  // --- the registry is a store too: its states an enum ---
  const table = DelegationTable.open(tmp, 's1');
  assert.equal(table.path, join(tmp, '.agent-pack', 'state', 's1', 'delegations.json'));
  assert.throws(() => table.add({ dlg: 'dlg-00000001', state: 'flying' }), /state/, 'a state outside the enum is refused');
  table.add({ dlg: 'dlg-00000001', state: 'running', assignee: 'b' });
  assert.equal(table.transition('dlg-00000001', 'running', 'delivered'), true);
  assert.equal(table.transition('dlg-00000001', 'running', 'blocked'), false, 'moved meanwhile: the guard holds');
  assert.equal(table.get('dlg-00000001').state, 'delivered');
  assert.equal(table.get('dlg-00000001').reason, '', 'a field never written reads as empty');
  const spec = delegationsStore(['dlg', 'state', 'reason'], ['running', 'delivered']);
  assert.deepEqual(spec.slots.map(s => [s.name, s.type.kind, s.optional]), [['dlg', 'text', false], ['state', 'enum', false], ['reason', 'text', true]]);

  // --- the same resolution places a dimension's cache and an agent's store ---
  const storeSpec = { id: 'sto-1', name: 'notes', about: null, slots: [], storeKey: 'topic', storeDriver: 'files', lasts: 'project' };
  assert.equal(resolveStore(storeSpec, tmp, 'pm', { kind: 'agent' }).ref.path, join(tmp, 'stores', 'pm', 'notes.json'));
  const cache = resolveStore(storeSpec, tmp, 'dimension', { kind: 'cache', defhash: 'abcd1234' });
  assert.equal(cache.ref.path, join(tmp, '.agent-pack', 'cache', 'abcd1234.json'));
  assert.equal(cache.ref.key, '_key', 'the cache reaches a record by its own key');
  assert.equal(cache.ref.lasts, 'project');
  assert.throws(() => resolveStore({ ...storeSpec, storeDriver: 'mongo' }, tmp, 'pm', { kind: 'agent' }), /no driver "mongo"/);
  assert.ok((await open(cache)).put, 'opened through the API');

  // --- one way: nothing in src/apx but stores.ts looks a driver up or opens one ---
  const offenders = [];
  const walk = dir => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) check(p); } };
  const check = p => {
    if (p.endsWith('/stores.ts')) return;
    const text = readFileSync(p, 'utf-8');
    if (/storeDriverOf\(|driver\.open\(|\.open\(this\.ref\)/.test(text)) offenders.push(p.slice(ROOT.length + 1));
  };
  walk(join(ROOT, 'src', 'apx'));
  assert.deepEqual(offenders, [], 'a driver is looked up and opened in stores.ts only');
  console.log('engine stores tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
