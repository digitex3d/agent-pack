// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The file-system helpers every walker, cache and store of the project shares —
 * one source for walking a tree, naming a path inside a root, writing a file
 * whole, reading a JSON file and pruning what is left empty. Node's `fs` and
 * `path` only: the apx bundle imports it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, type Dirent } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

/**
 * Every file under `dir` whose name ends with `ext`, recursively, as absolute
 * paths — each folder's names in order; [] when `dir` is no directory. A
 * symbolic link to a folder is not followed.
 */
export function filesUnder(dir: string, ext: string): string[] {
  try { if (!statSync(dir).isDirectory()) return []; } catch { return []; }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(abs, ext));
    else if (entry.name.endsWith(ext)) out.push(abs);
  }
  return out;
}

/** The folders a walk of a project never enters: its history, its dependencies, its own build output. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.agent-pack']);

/**
 * Every file under `root` whose `/`-separated relative path `keep` admits, in
 * path order, `max` at most — the project's own files: `.git`, `node_modules` and `.agent-pack`
 * are never entered, nor is a symbolic link to a folder followed.
 */
export function projectFiles(root: string, keep: (rel: string) => boolean, max = Infinity): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) walk(abs); continue; }
      if (!entry.isFile()) continue;
      const rel = relativeWithin(root, abs);
      if (rel && keep(rel)) out.push(rel);
    }
  };
  walk(root);
  return out;
}

/** Whether some file of the project `keep` admits — the walk of projectFiles, stopped at the first. */
export function hasProjectFile(root: string, keep: (rel: string) => boolean): boolean {
  return projectFiles(root, keep, 1).length > 0;
}

/** Every `.ap` file under `dir`, recursively; [] when `dir` is no directory. */
export function apFilesUnder(dir: string): string[] {
  return filesUnder(dir, '.ap');
}

/** `path`'s place inside `root`, `/`-separated — null when it is `root` itself or lies outside. */
export function relativeWithin(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Write a file whole or not at all — its folder made, a temporary file beside it, then a rename. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A JSON file's value — undefined when it is missing or no JSON. */
export function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return undefined; }
}

/**
 * Remove the empty folders under `dir`, and `dir` itself when it ends up empty.
 * Given `top`, `dir` lies inside it: the folders from `dir` up to `top` that
 * are left empty go too — `top` itself never does.
 */
export function removeEmptyDirs(dir: string, top?: string): void {
  if (!existsSync(dir)) return;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(join(dir, e.name));
    for (let d = dir; top === undefined ? d === dir : d.startsWith(top + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    }
  } catch { /* a folder another process filled or removed meanwhile stays as it is */ }
}

/**
 * The names in `dir` shaped like `re`, but those `except` holds — given the
 * ones a build still uses, what it left behind. Sorted; [] when `dir` does not exist.
 */
export function namesMatching(dir: string, re: RegExp, except: ReadonlySet<string> = new Set()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => re.test(name) && !except.has(name)).sort();
}
