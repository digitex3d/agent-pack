// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge's units — one file per `.ap` source, like a C object file: what the
 * judge made of that source, valid while the source and the rules are the same.
 *
 *   .agent-pack/units/<source path from the project root>.json
 *   .agent-pack/units/_external/<@alias>/<path in that library>.json   (a library source outside the project)
 *   .agent-pack/units/_external/<short hash of its directory>/<file>.json   (any other source outside it)
 *
 *   { "version": 1, "source": "<path>", "model": "<model>", "hash": "sha256:…", "rules": "sha256:…",
 *     "verdicts": { "<key>": { "p": 0.83 } }, "diagnostics": [ <diagnostic> ] }
 *
 * `hash` is the source text's, `rules` everything else that decides the result
 * (the rules, the lock, the threshold): both equal, and every check the source's
 * lines need among `verdicts`, the diagnostics stand as they are. `verdicts` are
 * the judge's answers — machine verdicts, never a human decision — given by
 * `model`: a run uses them only when the lock pins that same model (a unit
 * written before units named their model counts as the lock's), so a model
 * change asks every line again. A diagnostic
 * has the shape of a LintError without its file — the unit names the source.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { isProbability } from './lock.js';

/** A judge diagnostic at a line of the source — a LintError less its `file`. */
export interface UnitDiagnostic {
  line: number;
  col?: number;
  endCol?: number;
  severity: 'error' | 'warning';
  source: 'judge';
  code: string;
  message: string;
  data: { p: number; key: string };
}

export interface Unit {
  version: 1;
  /** The source: its path from the project root, `@alias/<path>` in a library outside it, else `<dir hash>/<file>`. */
  source: string;
  /** The model that gave `verdicts` — absent in a unit written before units named it. */
  model?: string;
  hash: string;
  rules: string;
  verdicts: Record<string, { p: number }>;
  diagnostics: UnitDiagnostic[];
}

/** `sha256:<hex>` of a text. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** The units of a project: every unit file read once, when the run opens. */
export class UnitStore {
  /** unit file → its unit. */
  private readonly units = new Map<string, Unit>();
  /** Every machine verdict of every unit, by key — a key names its check and line text, whatever the file. */
  private readonly known = new Map<string, number>();

  /**
   * dir: the units directory; root: the project root; model: the lock's pinned
   * model (null: none yet, so no verdict is trusted); libraries: alias → root.
   */
  constructor(readonly dir: string, readonly root: string, model: string | null, private readonly libraries: Record<string, string>) {
    for (const file of unitFiles(dir)) {
      let unit = readUnit(file);
      if (!unit) continue; // not a unit (any more): rewritten or pruned like a missing one
      // Another model's verdicts (or any, while no model is pinned) are asked again.
      if (model === null || (unit.model ?? model) !== model) unit = { ...unit, verdicts: {} };
      this.units.set(file, unit);
      for (const [key, v] of Object.entries(unit.verdicts)) if (!this.known.has(key)) this.known.set(key, v.p);
    }
  }

  /** How a source is named in its unit — never by a machine's absolute path. */
  sourceName(file: string): string {
    return within(this.root, file) ?? this.externalName(file);
  }

  /** A source outside the project: `@alias/<path>` in the library holding it (the deepest), else `<dir hash>/<file>`. */
  private externalName(file: string): string {
    let best: { alias: string; rel: string } | null = null;
    for (const [alias, path] of Object.entries(this.libraries)) {
      const rel = path ? within(resolve(this.root, path), file) : null;
      if (rel !== null && (!best || rel.length < best.rel.length)) best = { alias, rel };
    }
    if (best) return `${best.alias}/${best.rel}`;
    return `${createHash('sha256').update(dirname(file)).digest('hex').slice(0, 12)}/${basename(file)}`;
  }

  /** The unit file of a source. */
  pathOf(file: string): string {
    const inside = within(this.root, file);
    return inside !== null ? join(this.dir, `${inside}.json`) : join(this.dir, EXTERNAL, `${this.externalName(file)}.json`);
  }

  /** The unit of a source, or null. */
  get(file: string): Unit | null {
    return this.units.get(this.pathOf(file)) ?? null;
  }

  /** A machine verdict any unit holds for a key. */
  verdict(key: string): number | undefined {
    return this.known.get(key);
  }

  /** Write a source's unit when it changed. */
  write(file: string, unit: Unit): void {
    const path = this.pathOf(file);
    const text = JSON.stringify(unit, null, 2) + '\n';
    if (existsSync(path) && readFileSync(path, 'utf-8') === text) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf-8');
  }

  /** Delete every unit file but those of `seen` sources, then the directories left empty. */
  prune(seen: Iterable<string>): void {
    const keep = new Set([...seen].map(f => this.pathOf(f)));
    for (const file of unitFiles(this.dir)) if (!keep.has(file)) unlinkSync(file);
    removeEmptyDirs(this.dir);
  }
}

/** The directory of the units of sources outside the project. */
const EXTERNAL = '_external';

/** `file`'s path inside `dir`, `/`-separated — null when it is not inside. */
function within(dir: string, file: string): string | null {
  const rel = relative(dir, file);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
}

/** Every `.json` under a directory, recursively, in sorted order — none when it does not exist. */
function unitFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(e => {
    const path = join(dir, e.name);
    return e.isDirectory() ? unitFiles(path) : e.isFile() && e.name.endsWith('.json') ? [path] : [];
  });
}

/** A unit file's unit — null when it is not a well-formed version 1 unit. */
function readUnit(file: string): Unit | null {
  let unit: Unit;
  try {
    unit = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const ok = unit?.version === 1 && typeof unit.hash === 'string' && typeof unit.rules === 'string'
    && typeof unit.verdicts === 'object' && unit.verdicts !== null && Array.isArray(unit.diagnostics)
    && (unit.model === undefined || typeof unit.model === 'string')
    && Object.values(unit.verdicts).every(v => isProbability(v?.p));
  return ok ? unit : null;
}

/** Remove the empty directories under `dir` (and `dir` itself when it ends up empty). */
function removeEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(join(dir, e.name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
