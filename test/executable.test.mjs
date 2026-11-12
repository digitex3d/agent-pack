// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `agent-pack bundle <agent> --executable` (src/commands/executable.ts): an agent's apx split into engine
 * and data (`splitPack`), the data read back on its own (`Pack.fromData`) as
 * the compiled binary reads it, the entry that carries it — and, when Bun is
 * on the PATH, the binary itself answering as the apx does.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { splitPack, Pack, packFile } = await import('../dist/src/apx/pack.js');
const { parsePayload, packPayload } = await import('../dist/src/apx/payload.js');
const { executableEntry, buildExecutable, bunInstalled } = await import('../dist/src/commands/executable.js');
const { apxPath, binPath } = await import('../dist/src/apx/paths.js');

const apxDir = join(ROOT, '.agent-pack', 'apx');
/** An agent of this project with a plain SESSION variable, `docs-audit`. */
const AGENT = 'docs-auditor';
const anApx = existsSync(apxDir) ? readFileSync(join(apxDir, `${AGENT}.apx`), 'utf-8') : null;
const engine = anApx ? splitPack(anApx).engine : readFileSync(join(ROOT, 'dist', 'apx-engine.js'), 'utf-8');

// --- split is the inverse of packFile; the data alone reads as the file does ---
const payload = `{"build":{"agentPackVersion":"0.0.0","hash":"abc","tabeli":"/t"},"document":{"blocks":[]}}`;
const file = packFile(engine, { name: 'x', version: '0.0.0', engine: 'agent-pack 0.0.0' }, [{ type: 'image', name: '', encoding: 'json', data: payload }]);
const { engine: head, data } = splitPack(file);
assert.equal(head + data, file, 'engine + data give the file back');
assert.ok(data.startsWith('//apx:header::json:'), 'the data starts at the header line');
assert.deepEqual(packPayload(Pack.fromData(data)), parsePayload(file), 'the data alone carries the same payload');
assert.throws(() => splitPack('const x = 1;\n'), /carries no pack data/);
assert.throws(() => Pack.fromData(data.slice(0, -10)), /truncated/);

// --- the entry sets the data for the engine and loads it ---
const entry = executableEntry(data);
assert.ok(entry.startsWith('globalThis.__APX_PACK = "'), 'the data is a string constant of the entry');
assert.ok(entry.includes("require('./engine.cjs')"), 'the entry runs the engine');

// --- run by Node as the binary would be: the same engine answers from the embedded data ---
if (anApx) {
  const work = mkdtempSync(join(tmpdir(), 'pack-sim-'));
  try {
    const split = splitPack(anApx);
    writeFileSync(join(work, 'engine.cjs'), split.engine);
    writeFileSync(join(work, 'entry.cjs'), executableEntry(split.data));
    const sim = spawnSync(process.execPath, ['entry.cjs', 'ls'], { cwd: work, encoding: 'utf-8' });
    const real = spawnSync(process.execPath, [join(apxDir, `${AGENT}.apx`), 'ls'], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(sim.status, 0, sim.stdout + sim.stderr);
    assert.equal(sim.stdout, real.stdout, 'the embedded data lists what the apx lists');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- the build refuses an agent with no apx, before it needs Bun ---
const empty = mkdtempSync(join(tmpdir(), 'pack-empty-'));
try {
  assert.throws(() => buildExecutable('nobody', empty), /no apx for nobody .* bundle it first/);
  assert.equal(binPath('explorer'), '.agent-pack/bin/explorer');
  assert.equal(binPath('explorer', 'bun-linux-x64'), '.agent-pack/bin/explorer-linux-x64');
  assert.equal(apxPath('explorer'), '.agent-pack/apx/explorer.apx');
} finally {
  rmSync(empty, { recursive: true, force: true });
}

// --- with Bun on the PATH: the binary answers as the apx does, on the same project ---
if (bunInstalled() && anApx) {
  const project = mkdtempSync(join(tmpdir(), 'pack-bun-'));
  try {
    mkdirSync(join(project, '.agent-pack', 'apx'), { recursive: true });
    writeFileSync(join(project, apxPath(AGENT)), anApx);
    const bin = buildExecutable(AGENT, project);
    assert.ok(existsSync(bin), 'the binary is written');
    const fromBin = spawnSync(bin, ['ls'], { cwd: project, encoding: 'utf-8' });
    const fromApx = spawnSync(process.execPath, [apxPath(AGENT), 'ls'], { cwd: project, encoding: 'utf-8' });
    assert.equal(fromBin.status, 0, fromBin.stdout + fromBin.stderr);
    assert.equal(fromBin.stdout, fromApx.stdout, 'the binary lists what the apx lists');
    const sessionEnv = JSON.parse(parsePayload(anApx).document).meta?.sessionEnv;
    if (sessionEnv) {
      const env = { ...process.env, [sessionEnv]: 'p1' };
      const set = spawnSync(bin, ['set', 'docs-audit', '42'], { cwd: project, encoding: 'utf-8', env });
      assert.equal(set.status, 0, set.stdout + set.stderr);
      const get = spawnSync(process.execPath, [apxPath(AGENT), 'get', 'docs-audit'], { cwd: project, encoding: 'utf-8', env });
      assert.equal(get.stdout.trim().split('\n').at(-1), '42', 'a variable the binary writes, the apx reads: one state');
      assert.ok(existsSync(join(project, '.agent-pack', 'state', 'p1')), 'the state is in the project, where the apx keeps it');
    }
    console.log('executable: Bun build tested.');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
} else {
  console.log(`executable: Bun ${bunInstalled() ? 'found' : 'not on the PATH'} — the binary itself was not tested.`);
}
console.log('executable tests passed.');
