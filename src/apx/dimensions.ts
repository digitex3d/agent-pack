// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The dimensions' cache (D43) — what the apx keeps of an answer about the code,
 * and how it knows the answer still holds. The apx never reasons: it hashes
 * files and serves, validates or drops entries.
 *
 * The answers live in a store (src/storeDrivers/): the one the dimension's
 * `STORE` line names gives the fields and the driver, and the cache gives the
 * place — `.agent-pack/cache/<defhash>.<the driver's extension>`, shared by
 * every agent that has the dimension, outside git. In it, each file answered
 * is one record (`_kind=file`: its fingerprint, its refs, who wrote it) and
 * each instance of its answer one more (`_kind=unit`, the store's fields);
 * a file with nothing to report has its file record alone.
 *
 * The defhash names the dimension's definition by its content, never its name:
 * the dimension (its FOR among it), its store and the template EACH names.
 * Renaming any of them keeps the cache; editing what it asks — or which files
 * it covers — gives a new store, and the old one is garbage `bundle all` removes.
 *
 * An entry holds when the file's fingerprint and every ref's are the ones it
 * was written against. The fingerprint reads the file as code: line endings,
 * trailing whitespace and blank lines do not count; indentation and comments do.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { nameFreeContent, sha256Hex } from '../apdoc/ids.js';
import type { ApBlock } from '../apdoc/block.js';
import type { DimensionBlock, StoreBlock } from '../apdoc/blocks.js';
import type { ApDocument } from '../apdoc/document.js';
import type { ApSlot } from '../apdoc/types.js';
import { matchesAnyGlob } from '../services/glob.js';
import { readJsonFile, relativeWithin, namesMatching, writeFileAtomic } from '../services/fs.js';
import type { Collection, Doc, Filter } from '../storeDrivers/types.js';
import { open as openStore, type OpenStore } from './stores.js';
import { CACHE_DIR } from './paths.js';

/** The engine's own share of every defhash: raised when what an entry means changes, so every cache starts over. */
export const DIMENSION_SALT = 2;

/** The format of a cache entry: an entry of another format is read as never written. */
export const CACHE_FORMAT = 2;

/** A cache folder's name — the format before stores: every one is garbage now. */
const DEFHASH_RE = /^[0-9a-f]{8}$/;

/** A dimension's store file in the cache: its defhash, the driver's extension, and the lock a driver may keep beside it. */
const CACHE_STORE_RE = /^([0-9a-f]{8})\.[A-Za-z0-9]+(?:\.lock)?$/;

/** A counters file's name: a defhash's. */
const STATS_RE = /^[0-9a-f]{8}\.json$/;

/** The folder of the read counters, beside the stores. */
const STATS_DIR = 'stats';

/** The value no answer is: nothing to report — a valid, cached answer. */
export const NONE = 'none';

/** How long a file `next` handed out stays reserved for whoever took it: thirty minutes. */
const CLAIM_MS = 1_800_000;

/** The hex digits of a defhash. */
const DEFHASH_LENGTH = 8;

/** The record kinds of a dimension's store. */
const FILE = 'file';
const UNIT = 'unit';

/** The keys of a file's record and of its n-th instance. */
const fileKey = (file: string): string => `f:${file}`;
const unitKey = (file: string, index: number): string => `u:${file}#${index}`;

/** One cache entry — a dimension's answer for one file, and what it was worked out from. */
export interface CacheEntry {
  format: number;
  /** The dimension's name when it was written — the definition is the store's. */
  dimension: string;
  /** The source file, from the project root. */
  file: string;
  /** The file's fingerprint when the answer was written. */
  hash: string;
  /** The other files the answer depends on, each with its fingerprint then. */
  refs: Record<string, string>;
  value: Record<string, unknown>[] | typeof NONE;
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

/** A write that lost to another agent's: the answer was given, or is being given, meanwhile. */
export class StaleWrite extends Error {}

/** The blocks a dimension's definition takes in: its store, the template EACH names. */
export interface DimensionParts {
  store: StoreBlock | null;
  each: ApBlock | null;
}

/**
 * The defhash of a dimension: its content and its parts' — its store, the
 * template EACH names — each without its name (ids.ts nameFreeContent), with
 * the engine's salt. Eight hex digits.
 */
export function dimensionDefHash(dim: DimensionBlock, parts: DimensionParts): string {
  const content = [dim, parts.store, parts.each].map(block => (block ? nameFreeContent(block.toJSON()) : null));
  return sha256Hex(JSON.stringify([DIMENSION_SALT, ...content])).slice(0, DEFHASH_LENGTH);
}

/** The parts of a dimension, as the document resolves them. */
export function dimensionParts(doc: ApDocument, dim: DimensionBlock): DimensionParts {
  return {
    store: dim.store ? doc.resolve(dim.store) as StoreBlock | null : null,
    each: dim.eachRef ? doc.resolve(dim.eachRef) : null,
  };
}

/** The defhash of each dimension of a compiled document — the cache stores its agent reads. */
export function documentDefHashes(doc: ApDocument): string[] {
  return (doc.byKind('dimension') as DimensionBlock[]).map(dim => dimensionDefHash(dim, dimensionParts(doc, dim)));
}

/** A file's fingerprint: its lines with line endings, trailing whitespace and blank lines left out. */
export function fingerprint(text: string): string {
  return sha256Hex(text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '').join('\n'));
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
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const word of node.split(/[\s`'"()<>[\]{},;|]+/)) {
        const candidate = pathWord(word);
        if (!/[/.]/.test(candidate)) continue;
        const rel = relativeWithin(root, resolve(root, candidate));
        if (rel && isFile(root, rel)) found.add(rel);
      }
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return [...found];
}

/** `<field>=<value>` as a filter — the conditions the cache reads its records by. */
const eq = (field: string, value: string): Filter => ({ field, op: '=', value });

/** A unit record's position in its file's answer, from its key. */
const unitIndex = (doc: Doc): number => Number(String(doc._key).slice(String(doc._key).lastIndexOf('#') + 1));

/** A file `next` handed out: the file, and why it has no fresh answer. */
export interface Claimed {
  file: string;
  reason: string;
}

/** The cache of one dimension definition, at a project root: its answers in its store. */
export class DimensionCache {
  /** The store, from the project root. */
  readonly location: string;
  readonly root: string;
  private collection: Collection | null = null;

  /** `store` is the dimension's STORE resolved into the cache (src/apx/stores.ts); its records are reached by `_key`. */
  constructor(private readonly store: OpenStore, readonly defhash: string) {
    this.root = store.ref.root;
    this.location = relative(store.ref.root, store.ref.path);
  }

  private async open(): Promise<Collection> {
    this.collection ??= await openStore(this.store);
    return this.collection;
  }

  /** A unit record's own fields: the store's slots, numbers read back as numbers. */
  private fieldsOf(doc: Doc): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const slot of this.store.spec.slots) {
      if (doc[slot.name] === undefined) continue;
      out[slot.name] = numeric(slot) && doc[slot.name] !== '' ? Number(doc[slot.name]) : doc[slot.name];
    }
    return out;
  }

  private entryOf(head: Doc, units: Doc[]): CacheEntry {
    return {
      format: CACHE_FORMAT,
      dimension: String(head._dim ?? ''),
      file: String(head._file),
      hash: String(head._hash),
      refs: JSON.parse(String(head._refs || '{}')) as Record<string, string>,
      value: head._none === '1' ? NONE : units.sort((left, right) => unitIndex(left) - unitIndex(right)).map(unit => this.fieldsOf(unit)),
      by: String(head._by ?? ''),
      at: String(head._at ?? ''),
    };
  }

  private async unitsOf(file: string): Promise<Doc[]> {
    return await (await this.open()).find([eq('_kind', UNIT), eq('_file', file)]);
  }

  /** The entry of a file — null when none is kept, or one is being written for the first time. */
  async read(file: string): Promise<CacheEntry | null> {
    const head = await (await this.open()).get(fileKey(file));
    if (!head?._hash) return null;
    return this.entryOf(head, await this.unitsOf(file));
  }

  /**
   * Keep an entry, replacing the file's answer. Its file record guards the
   * write: it is claimed with a token while the instances change, then
   * settled only while the token is still its — so two agents answering the
   * same file never mix their instances. Throws StaleWrite when another got there.
   */
  async write(entry: CacheEntry): Promise<void> {
    const collection = await this.open();
    const key = fileKey(entry.file);
    const head = await collection.get(key);
    const token = randomUUID();
    if (head) {
      if (await collection.set(key, { _claim: token }, [eq('_at', String(head._at))]) !== 'set') throw new StaleWrite();
    } else {
      await collection.put({ _key: key, _kind: FILE, _file: entry.file, _hash: '', _claim: token, _claimAt: '', _at: 'pending' });
    }
    for (const unit of await this.unitsOf(entry.file)) await collection.remove(String(unit._key));
    if (Array.isArray(entry.value)) {
      for (const [index, instance] of entry.value.entries()) await collection.put({ ...(instance as Doc), _key: unitKey(entry.file, index), _kind: UNIT, _file: entry.file });
    }
    const settled = await collection.set(key, {
      _hash: entry.hash, _refs: JSON.stringify(entry.refs), _by: entry.by, _at: entry.at,
      _none: entry.value === NONE ? '1' : '', _dim: entry.dimension, _claim: '', _claimAt: '',
    }, [eq('_claim', token)]);
    if (settled !== 'set') throw new StaleWrite();
  }

  async remove(file: string): Promise<void> {
    const collection = await this.open();
    for (const unit of await this.unitsOf(file)) await collection.remove(String(unit._key));
    await collection.remove(fileKey(file));
  }

  /** Every entry kept, by file, in path order — those matching `glob` when one is given. */
  async entries(glob?: string): Promise<CacheEntry[]> {
    const collection = await this.open();
    const heads = (await collection.find([eq('_kind', FILE)])).filter(head => head._hash && (!glob || matchesAnyGlob(String(head._file), [glob])));
    const units = new Map<string, Doc[]>();
    for (const unit of await collection.find([eq('_kind', UNIT)])) units.set(String(unit._file), [...(units.get(String(unit._file)) ?? []), unit]);
    return heads.map(head => this.entryOf(head, units.get(String(head._file)) ?? [])).sort((left, right) => left.file.localeCompare(right.file));
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
    const broken = checks.find(check => check.current !== check.stored);
    if (!broken) return { state: 'fresh', reason: '', checks };
    return { state: 'stale', reason: broken.current === null ? `ref gone: ${broken.path}` : `changed: ${broken.path}`, checks };
  }

  /**
   * A file moved or renamed without an edit keeps its answer: the entry of a
   * file that no longer exists, written against this very fingerprint, is
   * moved to this file — and returned. Null when there is none.
   */
  async adopt(file: string, hash: string): Promise<CacheEntry | null> {
    const orphan = (await this.entries()).find(entry => entry.file !== file && entry.hash === hash && !isFile(this.root, entry.file));
    if (!orphan) return null;
    const adopted = { ...orphan, file };
    await this.write(adopted);
    await this.remove(orphan.file);
    return adopted;
  }

  /** The entries whose file no longer exists. */
  async orphans(): Promise<CacheEntry[]> {
    return (await this.entries()).filter(entry => !isFile(this.root, entry.file));
  }

  /**
   * The first of `files` with no fresh answer and no one working on it, taken
   * for `by` — two agents never take the same file. Null when every file is answered or taken.
   */
  async claimNext(files: readonly string[], by: string): Promise<Claimed | null> {
    for (const file of files) {
      const entry = await this.read(file);
      const state = entry ? this.state(entry) : null;
      if (state?.state !== 'fresh' && await this.claim(file, by)) return { file, reason: state ? state.reason : 'never written' };
    }
    return null;
  }

  /** Take one file for `by`, unless another holds it — its file record is made, or freed from a claim past CLAIM_MS, first. */
  private async claim(file: string, by: string): Promise<boolean> {
    const collection = await this.open();
    const key = fileKey(file);
    const head = await collection.get(key);
    if (head?._claim && Date.now() - Date.parse(String(head._claimAt)) < CLAIM_MS) return false;
    if (!head) await collection.put({ _key: key, _kind: FILE, _file: file, _hash: '', _claim: '', _claimAt: '', _at: 'pending' });
    else if (head._claim) await collection.set(key, { _claim: '', _claimAt: '' }, [eq('_claimAt', String(head._claimAt))]);
    return !!await collection.take?.([eq('_key', key), eq('_claim', '')], { _claim: by, _claimAt: new Date().toISOString() });
  }

  /** The instances every filter holds for, each with its file — of fresh entries only; and the files left out as stale. */
  async query(filters: Filter[]): Promise<{ rows: { file: string; fields: Record<string, unknown> }[]; stale: string[] }> {
    const collection = await this.open();
    const fresh = new Map<string, boolean>();
    const stale: string[] = [];
    const rows: { file: string; fields: Record<string, unknown> }[] = [];
    for (const unit of await collection.find([eq('_kind', UNIT), ...filters])) {
      const file = String(unit._file);
      if (!fresh.has(file)) {
        const entry = await this.read(file);
        const ok = entry !== null && this.state(entry).state === 'fresh';
        fresh.set(file, ok);
        if (!ok) stale.push(file);
      }
      if (fresh.get(file)) rows.push({ file, fields: this.fieldsOf(unit) });
    }
    return { rows, stale };
  }

  /** A mark of now — the store's own. */
  async mark(): Promise<string> {
    const collection = await this.open();
    return String(await collection.mark?.() ?? '');
  }

  /** The files whose answer was written after a mark — null when the mark is none of this store's. */
  async changedSince(mark: string): Promise<string[] | null> {
    const docs = await (await this.open()).since?.(mark);
    if (!docs) return null;
    return [...new Set(docs.filter(doc => doc._kind === FILE && doc._hash).map(doc => String(doc._file)))].sort();
  }

  private statsPath(): string {
    return join(this.root, CACHE_DIR, STATS_DIR, `${this.defhash}.json`);
  }

  stats(): CacheStats {
    const stats = readJsonFile(this.statsPath()) as Partial<CacheStats> | undefined;
    return { hits: Number(stats?.hits) || 0, misses: Number(stats?.misses) || 0 };
  }

  /** Count one read — best-effort: a counter that cannot be written never fails a read. */
  count(outcome: keyof CacheStats): void {
    try {
      const stats = this.stats();
      stats[outcome]++;
      writeFileAtomic(this.statsPath(), `${JSON.stringify(stats)}\n`);
    } catch { /* the counters are a convenience */ }
  }
}

/** Whether a slot holds a number — the value an engine may answer as text. */
const numeric = (slot: ApSlot): boolean => slot.type.kind === 'number';

/**
 * Remove the cache stores no current dimension produces — and their counters:
 * what an edited or removed dimension left behind, and the folders of the
 * format before stores. Returns them, from the project root. Only names shaped
 * like a defhash's are touched.
 */
export function removeStaleCaches(root: string, live: ReadonlySet<string>): string[] {
  const base = join(root, CACHE_DIR);
  const stats = join(base, STATS_DIR);
  for (const name of namesMatching(stats, STATS_RE, new Set([...live].map(hash => `${hash}.json`)))) rmSync(join(stats, name), { force: true });
  const folders = namesMatching(base, DEFHASH_RE);
  for (const name of folders) rmSync(join(base, name), { recursive: true, force: true });
  let names: string[] = [];
  try { names = readdirSync(base); } catch { /* no cache yet */ }
  const stores = names.filter(name => {
    const match = CACHE_STORE_RE.exec(name);
    return match !== null && !live.has(match[1]);
  });
  for (const name of stores) rmSync(join(base, name), { force: true });
  return [...folders.map(name => `${CACHE_DIR}/${name}/`), ...stores.filter(name => !name.endsWith('.lock')).map(name => `${CACHE_DIR}/${name}`)];
}
