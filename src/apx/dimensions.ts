// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The dimensions' cache (D43) — what the apx keeps of an answer about the code,
 * and how it knows the answer still holds. The apx never reasons: it hashes
 * files and serves, validates or drops entries.
 *
 *   .agent-pack/cache/<defhash>/<file>.json   one entry per source file
 *   .agent-pack/cache/stats/<defhash>.json    the read counters, best-effort
 *
 * The defhash names the dimension's definition by its content, never its name:
 * renaming a dimension or its template keeps its cache; editing what it asks
 * gives a new folder, and the old one is garbage `bundle all` removes.
 *
 * An entry holds when the file's fingerprint and every ref's are the ones it
 * was written against. The fingerprint reads the file as code: line endings,
 * trailing whitespace and blank lines do not count; indentation and comments do.
 */
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { nameFreeContent, sha256Hex } from '../apdoc/ids.js';
import type { ApBlock } from '../apdoc/block.js';
import type { DimensionBlock } from '../apdoc/blocks.js';
import type { ApDocument } from '../apdoc/document.js';
import { matchesAnyGlob } from '../services/glob.js';
import { filesUnder, readJsonFile, relativeWithin, removeEmptyDirs, namesMatching, writeFileAtomic } from '../services/fs.js';
import { CACHE_DIR } from './paths.js';

/** The engine's own share of every defhash: raised when what an entry means changes, so every cache starts over. */
export const DIMENSION_SALT = 1;

/** The format of a cache entry file: an entry of another format is read as never written. */
export const CACHE_FORMAT = 1;

/** A cache folder's name: a defhash. */
const DEFHASH_RE = /^[0-9a-f]{8}$/;

/** A counters file's name: a defhash's. */
const STATS_RE = /^[0-9a-f]{8}\.json$/;

/** The folder of the read counters, beside the definitions' folders. */
const STATS_DIR = 'stats';

/** The value no answer is: nothing to report — a valid, cached answer. */
export const NONE = 'none';

/** One cache entry — a dimension's answer for one file, and what it was worked out from. */
export interface CacheEntry {
  format: number;
  /** The dimension's name when it was written — the definition is the folder's. */
  dimension: string;
  /** The source file, from the project root. */
  file: string;
  /** The file's fingerprint when the answer was written. */
  hash: string;
  /** The other files the answer depends on, each with its fingerprint then. */
  refs: Record<string, string>;
  value: unknown[] | typeof NONE;
  /** The agent that wrote it. */
  by: string;
  at: string;
}

/** One file an entry depends on: its fingerprint then and now (null: the file is gone). */
export interface EntryCheck {
  path: string;
  role: 'file' | 'ref';
  stored: string;
  current: string | null;
}

/** Whether an entry still holds — and, when not, the first reason why. */
export interface EntryState {
  state: 'fresh' | 'stale' | 'gone';
  reason: string;
  checks: EntryCheck[];
}

/** The read counters of one definition. */
export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * The defhash of a dimension: its content and its templates' — the AS one and
 * the one EACH names — each without its name (ids.ts nameFreeContent), with
 * the engine's salt. Eight hex digits, the name of its cache folder.
 */
export function dimensionDefHash(dim: DimensionBlock, templates: { as: ApBlock | null; each: ApBlock | null }): string {
  const content = [dim, templates.as, templates.each].map(b => (b ? nameFreeContent(b.toJSON()) : null));
  return sha256Hex(JSON.stringify([DIMENSION_SALT, ...content])).slice(0, 8);
}

/** The templates a dimension's definition takes in: its AS template and the one its EACH names, as the document resolves them. */
export function dimensionTemplates(doc: ApDocument, dim: DimensionBlock): { as: ApBlock | null; each: ApBlock | null } {
  return { as: dim.shape ? doc.resolve(dim.shape.ref) : null, each: dim.eachRef ? doc.resolve(dim.eachRef) : null };
}

/** The defhash of each dimension of a compiled document — the cache folders its agent reads. */
export function documentDefHashes(doc: ApDocument): string[] {
  return (doc.byKind('dimension') as DimensionBlock[]).map(dim => dimensionDefHash(dim, dimensionTemplates(doc, dim)));
}

/** A file's fingerprint: its lines with line endings, trailing whitespace and blank lines left out. */
export function fingerprint(text: string): string {
  return sha256Hex(text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l !== '').join('\n'));
}

/** Whether a project path names a file that exists. */
function isFile(root: string, rel: string): boolean {
  try { return statSync(join(root, rel)).isFile(); } catch { return false; }
}

/** A path-like word of a text, its punctuation and a `:line[:col]` suffix taken off. */
function pathWord(word: string): string {
  return word.replace(/^\.\//, '').replace(/[.:]+$/, '').replace(/:\d+(?::\d+)?$/, '');
}

/** The project files a value names, literally, in any of its texts — each once, in order. */
export function filesNamedIn(root: string, value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const word of v.split(/[\s`'"()<>[\]{},;|]+/)) {
        const candidate = pathWord(word);
        if (!/[/.]/.test(candidate)) continue;
        const rel = relativeWithin(root, resolve(root, candidate));
        if (rel && isFile(root, rel)) found.add(rel);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

/** The cache of one dimension definition, at a project root. */
export class DimensionCache {
  /** The folder, absolute. */
  readonly dir: string;

  constructor(readonly root: string, readonly defhash: string) {
    this.dir = join(root, CACHE_DIR, defhash);
  }

  /** The folder, from the project root. */
  get location(): string {
    return `${CACHE_DIR}/${this.defhash}`;
  }

  /** Where the entry of a file is kept, from the project root. */
  entryLocation(file: string): string {
    return `${this.location}/${file}.json`;
  }

  private entryPath(file: string): string {
    return join(this.dir, `${file}.json`);
  }

  /** The entry of a file — null when none is kept, it cannot be read, or it is of another format. */
  read(file: string): CacheEntry | null {
    const entry = readJsonFile(this.entryPath(file)) as Partial<CacheEntry> | undefined;
    return entry && typeof entry === 'object' && entry.format === CACHE_FORMAT ? { ...entry, file } as CacheEntry : null;
  }

  write(entry: CacheEntry): void {
    writeFileAtomic(this.entryPath(entry.file), `${JSON.stringify(entry, null, 1)}\n`);
  }

  remove(file: string): void {
    rmSync(this.entryPath(file), { force: true });
    removeEmptyDirs(dirname(this.entryPath(file)), this.dir);
  }

  /** Every entry kept, by file, in path order — those matching `glob` when one is given. */
  entries(glob?: string): CacheEntry[] {
    return filesUnder(this.dir, '.json').map(path => relativeWithin(this.dir, path)!.slice(0, -'.json'.length)).sort()
      .filter(file => !glob || matchesAnyGlob(file, [glob]))
      .map(file => this.read(file))
      .filter((e): e is CacheEntry => e !== null);
  }

  /** A project file's fingerprint now — null when it is gone. */
  fingerprintOf(file: string): string | null {
    return isFile(this.root, file) ? fingerprint(readFileSync(join(this.root, file), 'utf-8')) : null;
  }

  /** Whether an entry still holds: its file and every ref as they were. */
  state(entry: CacheEntry): EntryState {
    const checks: EntryCheck[] = [
      { path: entry.file, role: 'file', stored: entry.hash, current: this.fingerprintOf(entry.file) },
      ...Object.entries(entry.refs ?? {}).map(([path, stored]): EntryCheck => ({ path, role: 'ref', stored, current: this.fingerprintOf(path) })),
    ];
    if (checks[0].current === null) return { state: 'gone', reason: 'file not found', checks };
    const broken = checks.find(c => c.current !== c.stored);
    if (!broken) return { state: 'fresh', reason: '', checks };
    return { state: 'stale', reason: broken.current === null ? `ref gone: ${broken.path}` : `changed: ${broken.path}`, checks };
  }

  /**
   * A file moved or renamed without an edit keeps its answer: the entry of a
   * file that no longer exists, written against this very fingerprint, is
   * moved to this file — and returned. Null when there is none.
   */
  adopt(file: string, hash: string): CacheEntry | null {
    const orphan = this.entries().find(e => e.file !== file && e.hash === hash && !isFile(this.root, e.file));
    if (!orphan) return null;
    const adopted = { ...orphan, file };
    this.write(adopted);
    this.remove(orphan.file);
    return adopted;
  }

  /** The entries whose file no longer exists. */
  orphans(): CacheEntry[] {
    return this.entries().filter(e => !isFile(this.root, e.file));
  }

  private statsPath(): string {
    return join(this.root, CACHE_DIR, STATS_DIR, `${this.defhash}.json`);
  }

  stats(): CacheStats {
    const s = readJsonFile(this.statsPath()) as Partial<CacheStats> | undefined;
    return { hits: Number(s?.hits) || 0, misses: Number(s?.misses) || 0 };
  }

  /** Count one read — best-effort: a counter that cannot be written never fails a read. */
  count(outcome: keyof CacheStats): void {
    try {
      const s = this.stats();
      s[outcome]++;
      writeFileAtomic(this.statsPath(), `${JSON.stringify(s)}\n`);
    } catch { /* the counters are a convenience */ }
  }
}

/**
 * Remove the cache folders no current dimension produces — and their counters:
 * what an edited or removed dimension left behind. Returns them, from the
 * project root. Only folders named like a defhash are touched.
 */
export function removeStaleCaches(root: string, live: ReadonlySet<string>): string[] {
  const base = join(root, CACHE_DIR);
  const stats = join(base, STATS_DIR);
  for (const name of namesMatching(stats, STATS_RE, new Set([...live].map(hash => `${hash}.json`)))) rmSync(join(stats, name), { force: true });
  const stale = namesMatching(base, DEFHASH_RE, live);
  for (const name of stale) rmSync(join(base, name), { recursive: true, force: true });
  return stale.map(name => `${CACHE_DIR}/${name}/`);
}
