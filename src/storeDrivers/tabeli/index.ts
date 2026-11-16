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
import { fieldArgs, openTable, queryTable, runTable } from '../../apx/tabeli.js';
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


/** The engine's exit codes the driver reads as answers, not failures. */
const EXIT = { ok: 0, none: 1, usage: 2, stale: 4 };

/** Run the table, throwing with its own words when it fails for a reason that is not an answer. */
function run(path: string, args: string[], answers: number[] = [EXIT.ok]): { status: number; out: string } {
  const result = runTable(path, args);
  const status = result.status ?? EXIT.usage;
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
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
function idOf(table: Table, recordKey: string): string | null {
  if (!table.key) return /^\d+$/.test(recordKey) ? recordKey : null;
  return queryTable(table.path, [`${table.key}=${recordKey}`])[0]?.id.toString() ?? null;
}

/** The record with this id, as a store record. */
const byId = (table: Table, id: string): Doc | null => queryTable(table.path, [`id=${id}`]).map(recordOf)[0] ?? null;

function put(table: Table, doc: Doc): { id: string; updated: boolean } {
  const existing = table.key && doc[table.key] !== undefined ? idOf(table, String(doc[table.key])) : null;
  if (existing) {
    run(table.path, ['s', existing, ...fieldArgs(doc)]);
    return { id: existing, updated: true };
  }
  return { id: idIn(run(table.path, ['a', ...fieldArgs(doc)]).out), updated: false };
}

function set(table: Table, recordKey: string, fields: Doc, guard: Filter[] = []): 'set' | 'missing' | 'stale' {
  const id = idOf(table, recordKey);
  if (!id) return 'missing';
  const result = run(table.path, ['s', id, ...fieldArgs(fields), ...(guard.length ? ['if', ...guard.map(filterText)] : [])], [EXIT.ok, EXIT.stale]);
  return result.status === EXIT.stale ? 'stale' : 'set';
}

function remove(table: Table, recordKey: string): boolean {
  const id = idOf(table, recordKey);
  if (!id) return false;
  run(table.path, ['d', id]);
  return true;
}

function take(table: Table, filters: Filter[], fields: Doc): Doc | null {
  const result = run(table.path, ['next', ...filters.map(filterText), 'set', ...fieldArgs(fields)], [EXIT.ok, EXIT.none]);
  return result.status === EXIT.none ? null : byId(table, idIn(result.out));
}

function since(table: Table, mark: string): Doc[] | null {
  const result = run(table.path, ['diff', mark], [EXIT.ok, EXIT.usage]);
  if (result.status === EXIT.usage) return null;
  return [...result.out.matchAll(/^id=(\d+)/gm)].map(match => byId(table, match[1])).filter((doc): doc is Doc => doc !== null);
}

function collection(store: StoreRef, engine: string | undefined): Collection {
  const unopened = openTable(store.path, engine);
  if (unopened) throw new Error(unopened);
  const table: Table = { path: store.path, key: store.key };
  return {
    put: doc => put(table, doc),
    get: recordKey => {
      const id = idOf(table, recordKey);
      return id ? byId(table, id) : null;
    },
    find: (filters, limit) => {
      const found = queryTable(table.path, filters.map(filterText)).map(recordOf);
      return limit ? found.slice(0, limit) : found;
    },
    set: (recordKey, fields, guard) => set(table, recordKey, fields, guard),
    remove: recordKey => remove(table, recordKey),
    take: (filters, fields) => take(table, filters, fields),
    mark: () => /# cursor=(\S+)/.exec(run(table.path, ['cursor']).out)?.[1] ?? '',
    since: mark => since(table, mark),
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
      const slotType = slot.type;
      if (slotType.kind === 'shape') {
        return `slot "${slot.name}" holds another shape (<${slotType.ref.target}>), and a tabeli record is flat key=value — ` +
          'give the nested shape its own STORE and point at it by key';
      }
      if (slotType.kind === 'list') {
        return `slot "${slot.name}" holds a list of <${slotType.ref.target}>, and a tabeli record is flat key=value — ` +
          'give the listed shape its own STORE, with a slot naming the record it belongs to';
      }
      return null;
    },

    open: store => collection(store, engine),
  };
}
