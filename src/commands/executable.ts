// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `agent-pack bundle <agent> --executable` — an agent's `.apx`, the
 * development form Node runs, compiled by Bun into one executable: the
 * engine and the agent's data in a single file. The data is the apx's own
 * pack lines (src/apx/pack.ts), carried into the executable as `__APX_PACK`
 * and read by the same engine (src/apx/main.ts); the executable keeps the
 * apx's paths — `.agent-pack/bin/` is as deep as `.agent-pack/apx/`, so the
 * project root, the state, the stores and the programs are where the apx
 * finds them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitPack } from '../apx/pack.js';
import { apxPath, binPath } from '../apx/paths.js';

/** Whether `bun` answers on the PATH. */
export function bunInstalled(): boolean {
  return spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0;
}

/** The entry of the executable: the data lines as one string, then the engine as it stands. */
export function executableEntry(data: string): string {
  return `globalThis.__APX_PACK = ${JSON.stringify(data)};\nrequire('./engine.cjs');\n`;
}

/**
 * Compile one agent's apx into `.agent-pack/bin/<agent>`: split the apx into
 * engine and data, write them beside an entry in a temporary folder, run
 * `bun build --compile` on it. Throws with Bun's words when the build fails.
 */
export function buildExecutable(agent: string, projectRoot: string, target: string | null = null): string {
  const apx = resolve(projectRoot, apxPath(agent));
  if (!existsSync(apx)) throw new Error(`no apx for ${agent} at ${apxPath(agent)} — bundle it first`);
  const { engine, data } = splitPack(readFileSync(apx, 'utf-8'), apxPath(agent));
  const out = resolve(projectRoot, binPath(agent, target));
  mkdirSync(resolve(out, '..'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'agent-pack-executable-'));
  try {
    writeFileSync(join(work, 'engine.cjs'), engine);
    writeFileSync(join(work, 'entry.cjs'), executableEntry(data));
    const args = ['build', '--compile', './entry.cjs', '--outfile', out, ...(target ? ['--target', target] : [])];
    const run = spawnSync('bun', args, { cwd: work, encoding: 'utf-8' });
    if (run.status !== 0) throw new Error(`bun build failed for ${agent}:\n${(run.stderr || run.stdout).trim()}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}
