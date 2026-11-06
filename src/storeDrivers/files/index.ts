// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `files` driver — the default: one flat JSON file per store, a list of
 * documents, the way a document database keeps a collection. No engine to
 * build, nothing to install.
 *
 *   { "format": 1, "seq": 12, "nextId": 4, "docs": [ { "id": "1", …fields, "_seq": 9 } ] }
 *
 * Every write reads, changes and rewrites the whole file under an exclusive
 * lock (`<file>.lock`, created only when absent), so two agents writing at
 * once never lose each other's write. `seq` counts the writes: a mark is the
 * seq of a moment, and `since` answers the records whose `_seq` is past it.
 *
 * Fine for thousands of records; past that, a store wants another driver.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApSlot } from '../../apdoc/types.js';
import { projectStoreDir, storeStateDir } from '../../apx/paths.js';
import { writeFileAtomic } from '../../services/fs.js';
import { holds } from '../filters.js';
import { DRIVER_API, type Collection, type Doc, type Filter, type StoreDecl, type StoreDriver, type StoreRef } from '../types.js';

const FORMAT = 1;
/** How long a writer waits for the lock before it gives up, and when a lock left behind counts as abandoned. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;
/** The bytes of the one Int32 a lock wait sleeps on. */
const INT32_BYTES = 4;

interface FileData {
  format: number;
  seq: number;
  nextId: number;
  docs: Doc[];
}

const EMPTY: FileData = { format: FORMAT, seq: 0, nextId: 1, docs: [] };

/** The file's data — an absent file is an empty store. */
function load(path: string): FileData {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const data = JSON.parse(readFileSync(path, 'utf-8')) as FileData;
  if (data.format !== FORMAT) throw new Error(`${path}: a store file of format ${String(data.format)}, this driver reads ${FORMAT}`);
  return data;
}

/** Block the thread for `ms`: a lock wait stays synchronous, like the rest of the apx. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
}

/** Take the file's lock, waiting while another writer holds it; a lock older than LOCK_STALE_MS is a crashed writer's. */
function lock(path: string): () => void {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = statSync(lockPath, { throwIfNoEntry: false });
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      else if (Date.now() > deadline) throw new Error(`${path}: another writer holds the store's lock — try again`);
      else sleep(LOCK_POLL_MS);
    }
  }
}

/** Read, change and write the file under its lock; `change` answers what the operation returns. */
function write<T>(path: string, change: (data: FileData) => T): T {
  const release = lock(path);
  try {
    const data = load(path);
    const out = change(data);
    writeFileAtomic(path, `${JSON.stringify(data, null, 1)}\n`);
    return out;
  } finally {
    release();
  }
}

/** A record as the API sees it: without the driver's own `_seq`. */
function plain(doc: Doc): Doc {
  const { _seq: _, ...rest } = doc;
  return rest;
}

/** One store's file: its path, and the KEY that reaches a record (else its id). */
interface Store {
  path: string;
  key: string | null;
}

/** Where the record `k` sits in the file's list, or -1. */
const indexOf = (s: Store, data: FileData, k: string): number =>
  data.docs.findIndex(d => String(s.key ? d[s.key] : d.id) === k);

/** A record as written: its fields, the id it keeps, and the write's seq. */
const stamp = (data: FileData, doc: Doc): Doc => ({ ...doc, _seq: ++data.seq });

function put(s: Store, doc: Doc): { id: string; updated: boolean } {
  return write(s.path, data => {
    const at = s.key && doc[s.key] !== undefined ? indexOf(s, data, String(doc[s.key])) : -1;
    if (at >= 0) {
      const id = String(data.docs[at].id);
      data.docs[at] = stamp(data, { ...doc, id });
      return { id, updated: true };
    }
    const id = String(data.nextId++);
    data.docs.push(stamp(data, { ...doc, id }));
    return { id, updated: false };
  });
}

function get(s: Store, k: string): Doc | null {
  const data = load(s.path);
  const at = indexOf(s, data, k);
  return at >= 0 ? plain(data.docs[at]) : null;
}

function find(s: Store, filters: Filter[], limit?: number): Doc[] {
  const found = load(s.path).docs.filter(d => holds(d, filters)).map(plain);
  return limit ? found.slice(0, limit) : found;
}

function set(s: Store, k: string, fields: Doc, guard: Filter[] = []): 'set' | 'missing' | 'stale' {
  return write(s.path, data => {
    const at = indexOf(s, data, k);
    if (at < 0) return 'missing';
    if (!holds(data.docs[at], guard)) return 'stale';
    data.docs[at] = stamp(data, { ...data.docs[at], ...fields, id: data.docs[at].id });
    return 'set';
  });
}

function remove(s: Store, k: string): boolean {
  return write(s.path, data => {
    const at = indexOf(s, data, k);
    if (at < 0) return false;
    data.docs.splice(at, 1);
    data.seq++;
    return true;
  });
}

function take(s: Store, filters: Filter[], fields: Doc): Doc | null {
  return write(s.path, data => {
    const at = data.docs.findIndex(d => holds(d, filters));
    if (at < 0) return null;
    data.docs[at] = stamp(data, { ...data.docs[at], ...fields, id: data.docs[at].id });
    return plain(data.docs[at]);
  });
}

function since(s: Store, mark: string): Doc[] | null {
  if (!/^\d+$/.test(mark)) return null;
  return load(s.path).docs.filter(d => Number(d._seq) > Number(mark)).map(plain);
}

function collection(store: StoreRef): Collection {
  const s: Store = { path: store.path, key: store.key };
  return {
    put: doc => put(s, doc),
    get: k => get(s, k),
    find: (filters, limit) => find(s, filters, limit),
    set: (k, fields, guard) => set(s, k, fields, guard),
    remove: k => remove(s, k),
    take: (filters, fields) => take(s, filters, fields),
    mark: () => String(load(s.path).seq),
    since: mark => since(s, mark),
  };
}

const filesDriver: StoreDriver = {
  type: 'driver',
  name: 'files',
  api: DRIVER_API,
  capabilities: ['take', 'guard', 'since'],

  location(store: StoreDecl) {
    return `${store.lasts === 'project' ? projectStoreDir(store.agent) : storeStateDir(store.agent)}/${store.name}.json`;
  },

  rejects(slot: ApSlot) {
    const t = slot.type;
    if (t.kind === 'shape' || t.kind === 'list') {
      return `slot "${slot.name}" holds ${t.kind === 'list' ? 'a list of ' : 'another shape, '}<${t.ref.target}>, and a files record is flat — ` +
        'give that shape its own STORE, with a slot naming the record it belongs to';
    }
    return null;
  },

  open: collection,
};

export default filesDriver;
