// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A table of records with a state, one per session — what the apx keeps of
 * the work it hands out: the instances of a team's contracts (contracts.ts),
 * the delegations a flow started in the background (delegations.ts). One
 * implementation for both: read, add, set, and move a record from one state
 * to another as a guarded set, so two agents never move the same record
 * twice. The table is an engine store (engineStores.ts), reached through the
 * store API like every other: its writes are checked against its slots.
 */
import { dirname } from 'node:path';
import type { Collection, Doc } from '../storeDrivers/types.js';
import { checkWrite, open, type OpenStore } from './stores.js';

export class RecordTable<R extends { state: string }> {
  /** Where the table's file lives, and its folder — the session's. */
  readonly path: string;
  readonly dir: string;
  private collection: Collection | null = null;

  protected constructor(
    protected readonly store: OpenStore,
    private readonly fields: readonly (keyof R & string)[],
  ) {
    this.path = store.ref.path;
    this.dir = dirname(store.ref.path);
  }

  private open(): Collection {
    return this.collection ??= this.sync(open(this.store));
  }

  /** Every record, in the order written. */
  all(): R[] {
    return this.sync(this.open().find([])).map(r => this.asRecord(r));
  }

  get(id: string): R | null {
    const r = this.sync(this.open().get(id));
    return r ? this.asRecord(r) : null;
  }

  /** Add a record, checked against the table's slots. Throws on a failure. */
  add(record: R): void {
    const doc = this.asDoc(record);
    checkWrite(this.store, doc, true);
    this.sync(this.open().put(doc));
  }

  /** Set fields on a record, unconditionally. */
  set(id: string, fields: Partial<R>): void {
    const doc = this.asDoc(fields);
    checkWrite(this.store, doc, false);
    if (this.sync(this.open().set(id, doc)) === 'missing') throw new Error(`no record ${id}`);
  }

  /**
   * Move a record from one state to another, setting `fields` with it — a
   * compare-and-swap: false when its state had changed meanwhile, so the
   * caller rereads instead of overwriting.
   */
  transition(id: string, from: R['state'], to: R['state'], fields: Partial<R> = {}): boolean {
    const doc = this.asDoc({ ...fields, state: to });
    checkWrite(this.store, doc, false);
    const outcome = this.sync(this.open().set(id, doc, [{ field: 'state', op: '=', value: from }]));
    if (outcome === 'missing') throw new Error(`no record ${id}`);
    return outcome === 'set';
  }

  /** The engine's driver answers at once; a promise here would be a driver mix-up. */
  private sync<T>(v: T | Promise<T>): T {
    if (v instanceof Promise) throw new Error(`${this.store.driver.name}: the engine's tables need a driver that answers synchronously`);
    return v;
  }

  /** Fields as a record: text, an empty or absent field left out. */
  private asDoc(fields: Partial<R>): Doc {
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  }

  private asRecord(r: Doc): R {
    const out = {} as Record<string, string>;
    for (const f of this.fields) out[f] = r[f] === undefined ? '' : String(r[f]);
    return out as unknown as R;
  }
}
