// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A table of records with a state, one per session — what the apx keeps of
 * the work it hands out: the instances of a team's contracts (contracts.ts),
 * the delegations a flow started in the background (delegations.ts). One
 * implementation for both: open, read, add, set, and move a record from one
 * state to another as a guarded set, so two agents never move the same
 * record twice. A collection of the `files` driver keeps it; every field is
 * text.
 */
import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { fileCollection } from '../storeDrivers/files/index.js';
import type { Collection, Doc } from '../storeDrivers/types.js';

export class RecordTable<R extends { state: string }> {
  private readonly collection: Collection;

  protected constructor(
    readonly path: string,
    readonly dir: string,
    private readonly fields: readonly (keyof R & string)[],
    /** The field that identifies a record — its id. */
    key: keyof R & string,
  ) {
    this.collection = fileCollection(path, key);
  }

  /** Where `file` of `sessionId` lives under `projectRoot` — created when first written. */
  protected static place(projectRoot: string, sessionId: string, file: string): { path: string; dir: string } {
    const dir = join(projectRoot, STATE_DIR, sessionId);
    return { path: join(dir, file), dir };
  }

  /** Every record, in the order written. */
  all(): R[] {
    return this.sync(this.collection.find([])).map(r => this.asRecord(r));
  }

  get(id: string): R | null {
    const r = this.sync(this.collection.get(id));
    return r ? this.asRecord(r) : null;
  }

  /** Add a record. Throws on a failure. */
  add(record: R): void {
    this.sync(this.collection.put(this.asDoc(record)));
  }

  /** Set fields on a record, unconditionally. */
  set(id: string, fields: Partial<R>): void {
    if (this.sync(this.collection.set(id, this.asDoc(fields))) === 'missing') throw new Error(`no record ${id}`);
  }

  /**
   * Move a record from one state to another, setting `fields` with it — a
   * compare-and-swap: false when its state had changed meanwhile, so the
   * caller rereads instead of overwriting.
   */
  transition(id: string, from: R['state'], to: R['state'], fields: Partial<R> = {}): boolean {
    const outcome = this.sync(this.collection.set(id, this.asDoc({ ...fields, state: to }), [{ field: 'state', op: '=', value: from }]));
    if (outcome === 'missing') throw new Error(`no record ${id}`);
    return outcome === 'set';
  }

  private sync<T>(v: T | Promise<T>): T {
    if (v instanceof Promise) throw new Error('the files driver answers synchronously');
    return v;
  }

  private asDoc(fields: Partial<R>): Doc {
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  }

  private asRecord(r: Doc): R {
    const out = {} as Record<string, string>;
    for (const f of this.fields) out[f] = r[f] === undefined ? '' : String(r[f]);
    return out as unknown as R;
  }
}
