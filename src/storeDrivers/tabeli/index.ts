// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `tabeli` driver — a `.tbl` file: engine, data and manual in one
 * executable, driven by its own CLI. It needs the engine agent-pack builds
 * (make and a C compiler), which is why it is a choice and not the default.
 *
 * The store API's filters are tabeli's own language, so they pass through as
 * written; the driver's work is mapping a store's key to the table's record
 * id, and the table's answers back to records.
 *
 * The one thing this backing cannot do is nesting: a `.tbl` record is flat
 * `key=value`, so a slot holding another shape or a list of them has no
 * representation. `rejects` says so at compile time rather than letting it
 * fail silently at the first write.
 */
import type { ApSlot } from '../../apdoc/types.js';
import { projectStoreDir, storeStateDir } from '../../apx/paths.js';
import { openTable, queryTable, runTable } from '../../apx/tabeli.js';
import { filterText } from '../filters.js';
import { DRIVER_API, type Collection, type Doc, type Filter, type StoreDecl, type StoreDriver, type StoreRef } from '../types.js';

/** The fields the engine writes on every record — not the store's. */
const ENGINE_FIELDS = new Set(['created_at', 'updated_at', 'created_by', 'updated_by']);

/** A table's record as a store record: the id as text, the engine's own fields dropped. */
function recordOf(row: Record<string, unknown>): Doc {
  const doc: Doc = {};
  for (const [field, value] of Object.entries(row)) {
    if (!ENGINE_FIELDS.has(field)) doc[field] = field === 'id' ? String(value) : value as string;
  }
  return doc;
}

/** `field=value` pairs for the engine's command line. */
const pairs = (fields: Doc): string[] => Object.entries(fields).map(([f, v]) => `${f}=${String(v)}`);

/** The engine's exit codes the driver reads as answers, not failures. */
const EXIT = { ok: 0, none: 1, usage: 2, stale: 4 };

/** Run the table, throwing with its own words when it fails for a reason that is not an answer. */
function run(path: string, args: string[], answers: number[] = [EXIT.ok]): { status: number; out: string } {
  const r = runTable(path, args);
  const status = r.status ?? EXIT.usage;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!answers.includes(status)) throw new Error(out.trim() || `tabeli exited ${status}`);
  return { status, out };
}

/** The id an `a`, `s` or `next` answer starts with: `id=<n> …`. */
const idIn = (out: string): string => /^id=(\d+)/m.exec(out)?.[1] ?? '';

/** One store's table: its path, and the KEY that reaches a record (else its id). */
interface Table {
  path: string;
  key: string | null;
}

/** The table's record id for a key — null when there is none. */
function idOf(t: Table, k: string): string | null {
  if (!t.key) return /^\d+$/.test(k) ? k : null;
  return queryTable(t.path, [`${t.key}=${k}`])[0]?.id.toString() ?? null;
}

/** The record with this id, as a store record. */
const byId = (t: Table, id: string): Doc | null => queryTable(t.path, [`id=${id}`]).map(recordOf)[0] ?? null;

function put(t: Table, doc: Doc): { id: string; updated: boolean } {
  const existing = t.key && doc[t.key] !== undefined ? idOf(t, String(doc[t.key])) : null;
  if (existing) {
    run(t.path, ['s', existing, ...pairs(doc)]);
    return { id: existing, updated: true };
  }
  return { id: idIn(run(t.path, ['a', ...pairs(doc)]).out), updated: false };
}

function set(t: Table, k: string, fields: Doc, guard: Filter[] = []): 'set' | 'missing' | 'stale' {
  const id = idOf(t, k);
  if (!id) return 'missing';
  const r = run(t.path, ['s', id, ...pairs(fields), ...(guard.length ? ['if', ...guard.map(filterText)] : [])], [EXIT.ok, EXIT.stale]);
  return r.status === EXIT.stale ? 'stale' : 'set';
}

function remove(t: Table, k: string): boolean {
  const id = idOf(t, k);
  if (!id) return false;
  run(t.path, ['d', id]);
  return true;
}

function take(t: Table, filters: Filter[], fields: Doc): Doc | null {
  const r = run(t.path, ['next', ...filters.map(filterText), 'set', ...pairs(fields)], [EXIT.ok, EXIT.none]);
  return r.status === EXIT.none ? null : byId(t, idIn(r.out));
}

function since(t: Table, mark: string): Doc[] | null {
  const r = run(t.path, ['diff', mark], [EXIT.ok, EXIT.usage]);
  if (r.status === EXIT.usage) return null;
  return [...r.out.matchAll(/^id=(\d+)/gm)].map(m => byId(t, m[1])).filter((d): d is Doc => d !== null);
}

function collection(store: StoreRef, engine: string | undefined): Collection {
  const unopened = openTable(store.path, engine);
  if (unopened) throw new Error(unopened);
  const t: Table = { path: store.path, key: store.key };
  return {
    put: doc => put(t, doc),
    get: k => {
      const id = idOf(t, k);
      return id ? byId(t, id) : null;
    },
    find: (filters, limit) => {
      const found = queryTable(t.path, filters.map(filterText)).map(recordOf);
      return limit ? found.slice(0, limit) : found;
    },
    set: (k, fields, guard) => set(t, k, fields, guard),
    remove: k => remove(t, k),
    take: (filters, fields) => take(t, filters, fields),
    mark: () => /# cursor=(\S+)/.exec(run(t.path, ['cursor']).out)?.[1] ?? '',
    since: mark => since(t, mark),
  };
}

/** The tabeli driver, opening its tables with `engine` — the one agent-pack built, recorded in the apx. */
export function tabeliDriver(engine?: string): StoreDriver {
  return {
    type: 'driver',
    name: 'tabeli',
    api: DRIVER_API,
    capabilities: ['take', 'guard', 'since'],

    location(store: StoreDecl) {
      return `${store.lasts === 'project' ? projectStoreDir(store.agent) : storeStateDir(store.agent)}/${store.name}.tbl`;
    },

    rejects(slot: ApSlot) {
      const t = slot.type;
      if (t.kind === 'shape') {
        return `slot "${slot.name}" holds another shape (<${t.ref.target}>), and a tabeli record is flat key=value — ` +
          'give the nested shape its own STORE and point at it by key';
      }
      if (t.kind === 'list') {
        return `slot "${slot.name}" holds a list of <${t.ref.target}>, and a tabeli record is flat key=value — ` +
          'give the listed shape its own STORE, with a slot naming the record it belongs to';
      }
      return null;
    },

    open: store => collection(store, engine),
  };
}
