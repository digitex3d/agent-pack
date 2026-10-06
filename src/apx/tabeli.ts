// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx's side of tabeli — the backing of stores and, behind its own seam
 * (sessionVars.ts), of session variables. Checking the engine, creating a
 * table, reading answers and adding-or-updating by key are written once, here.
 * The engine is the one agent-pack builds (`tabeli/`), recorded in the apx.
 */
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';

/** The oldest tabeli the apx works with: v1 stored a value's bytes lossily. */
const MIN_TABELI = 2;

/** How to get the engine agent-pack ships: build agent-pack, then rewrite the apx files. */
const REBUILD = 'build agent-pack (npm run build — needs make and a C compiler), then run agent-pack bundle all';

/**
 * Null when a tabeli executable — the bare engine, run with no argument, or a
 * table, run with `help` — says `# tabeli v<N>` with N ≥ 2 on its first line,
 * else the error, ending with `remedy`.
 */
export function tabeliVersionError(exe: string, args: string[], remedy: string): string | null {
  const version = /^# tabeli v(\d+)/.exec(spawnSync(exe, args, { encoding: 'utf-8' }).stdout ?? '')?.[1];
  if (version !== undefined && Number(version) >= MIN_TABELI) return null;
  return `tabeli v${MIN_TABELI} or newer is needed, and ${exe} is ${version ? `v${version}` : 'of an unknown version'} — ${remedy}`;
}

/**
 * A tabeli table, created on first use by `engine` (v2 or newer) — null when
 * it is there or was just created, else why it is not. A table already there
 * is left alone: it carries its own engine.
 */
export function openTable(path: string, engine: string | undefined): string | null {
  if (existsSync(path)) return null;
  if (!engine) return `this apx records no tabeli engine — ${REBUILD}`;
  if (!existsSync(engine)) return `tabeli engine not found at ${engine} — ${REBUILD}`;
  const old = tabeliVersionError(engine, [], REBUILD);
  if (old) return old;
  mkdirSync(dirname(path), { recursive: true });
  const init = spawnSync(engine, ['init', path], { encoding: 'utf-8' });
  return init.status === 0 ? null : `creating ${path}: ${(init.stderr || init.stdout).trim()}`;
}

/** Run a table with a verb and its arguments. */
export function runTable(table: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(table, args, { encoding: 'utf-8' });
}

/** The records matching `filters` (`field=value` …), as tabeli answers them in JSON — byte for byte. Throws on a failure. */
export function queryTable(table: string, filters: string[]): ({ id: number } & Record<string, string>)[] {
  const q = runTable(table, ['q', ...filters, 'json', 'limit=0']);
  if (q.status !== 0) throw new Error(`${q.error?.message ?? `${q.stderr}${q.stdout}`}`.trim());
  return JSON.parse(q.stdout) as ({ id: number } & Record<string, string>)[];
}

/**
 * Add a record — or, when one with `key=value` exists, set `fields` on it
 * instead of duplicating it. Returns the run and the id it updated (null: added).
 */
export function upsertBy(table: string, key: string, value: string, fields: string[]): { run: SpawnSyncReturns<string>; updated: number | null } {
  const [existing] = queryTable(table, [`${key}=${value}`]);
  const run = runTable(table, existing ? ['s', String(existing.id), ...fields] : ['a', `${key}=${value}`, ...fields]);
  return { run, updated: existing?.id ?? null };
}
