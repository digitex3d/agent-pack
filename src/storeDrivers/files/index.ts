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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
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
  const { _seq: _unusedSeq, ...rest } = doc;
  return rest;
}

/** One store's file: its path, and the KEY that reaches a record (else its id). */
interface Store {
  path: string;
  key: string | null;
}

/** Where the record `k` sits in the file's list, or -1. */
const indexOf = (store: Store, data: FileData, recordKey: string): number =>
  data.docs.findIndex(doc => String(store.key ? doc[store.key] : doc.id) === recordKey);

/** A record as written: its fields, the id it keeps, and the write's seq. */
const stamp = (data: FileData, doc: Doc): Doc => ({ ...doc, _seq: ++data.seq });

function put(store: Store, doc: Doc): { id: string; updated: boolean } {
  return write(store.path, data => {
    const at = store.key && doc[store.key] !== undefined ? indexOf(store, data, String(doc[store.key])) : -1;
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

function get(store: Store, recordKey: string): Doc | null {
  const data = load(store.path);
  const at = indexOf(store, data, recordKey);
  return at >= 0 ? plain(data.docs[at]) : null;
}

function find(store: Store, filters: Filter[], limit?: number): Doc[] {
  const found = load(store.path).docs.filter(doc => holds(doc, filters)).map(plain);
  return limit ? found.slice(0, limit) : found;
}

function set(store: Store, recordKey: string, fields: Doc, guard: Filter[] = []): 'set' | 'missing' | 'stale' {
  return write(store.path, data => {
    const at = indexOf(store, data, recordKey);
    if (at < 0) return 'missing';
    if (!holds(data.docs[at], guard)) return 'stale';
    data.docs[at] = stamp(data, { ...data.docs[at], ...fields, id: data.docs[at].id });
    return 'set';
  });
}

function remove(store: Store, recordKey: string): boolean {
  return write(store.path, data => {
    const at = indexOf(store, data, recordKey);
    if (at < 0) return false;
    data.docs.splice(at, 1);
    data.seq++;
    return true;
  });
}

function take(store: Store, filters: Filter[], fields: Doc): Doc | null {
  return write(store.path, data => {
    const at = data.docs.findIndex(doc => holds(doc, filters));
    if (at < 0) return null;
    data.docs[at] = stamp(data, { ...data.docs[at], ...fields, id: data.docs[at].id });
    return plain(data.docs[at]);
  });
}

function since(store: Store, mark: string): Doc[] | null {
  if (!/^\d+$/.test(mark)) return null;
  return load(store.path).docs.filter(doc => Number(doc._seq) > Number(mark)).map(plain);
}

/**
 * A collection over one file, outside any STORE block — what the apx keeps
 * its own tables in (session variables, the registry of background work):
 * the same format, the same lock, reached by `key` (else by id).
 */
export function fileCollection(path: string, key: string | null): Collection {
  const store: Store = { path, key };
  return {
    put: doc => put(store, doc),
    get: recordKey => get(store, recordKey),
    find: (filters, limit) => find(store, filters, limit),
    set: (recordKey, fields, guard) => set(store, recordKey, fields, guard),
    remove: recordKey => remove(store, recordKey),
    take: (filters, fields) => take(store, filters, fields),
    mark: () => String(load(store.path).seq),
    since: mark => since(store, mark),
  };
}

function collection(store: StoreRef): Collection {
  return fileCollection(store.path, store.key);
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
    const slotType = slot.type;
    if (slotType.kind === 'shape' || slotType.kind === 'list') {
      return `slot "${slot.name}" holds ${slotType.kind === 'list' ? 'a list of ' : 'another shape, '}<${slotType.ref.target}>, and a files record is flat — ` +
        'give that shape its own STORE, with a slot naming the record it belongs to';
    }
    return null;
  },

  open: collection,
};

export default filesDriver;
