// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A table of records with a state, one per session — what the apx keeps of
 * the work it hands out: the instances of a team's contracts (contracts.ts),
 * the delegations a flow started in the background (delegations.ts). One
 * implementation for both: open, read, add, set, and move a record from one
 * state to another as a tabeli compare-and-swap, so two agents never move the
 * same record twice. Every field is text: tabeli is flat.
 */
import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { fieldArgs, openTable, queryTable, runTable, tabeliVersionError } from './tabeli.js';

export class RecordTable<R extends { state: string }> {
  protected constructor(
    readonly path: string,
    readonly dir: string,
    private readonly fields: readonly (keyof R & string)[],
    /** The field that identifies a record — its id. */
    private readonly key: keyof R & string,
  ) {}

  /** Where `file` of `sessionId` lives under `projectRoot`, opened (created on first use) — or the reason it cannot be. */
  protected static place(projectRoot: string, sessionId: string, engine: string | undefined, file: string, label: string): { path: string; dir: string } | string {
    const dir = join(projectRoot, STATE_DIR, sessionId);
    const path = join(dir, file);
    const error = openTable(path, engine) ?? tabeliVersionError(path, ['help'], `upgrade it: ${engine ?? 'tabeli'} upgrade ${path}`);
    return error ? `${label}: ${error}` : { path, dir };
  }

  /** Every record, in the order written. */
  all(): R[] {
    return queryTable(this.path, []).map(r => this.asRecord(r));
  }

  get(id: string): R | null {
    const [r] = queryTable(this.path, [`${this.key}=${id}`]);
    return r ? this.asRecord(r) : null;
  }

  /** Add a record. Throws on a failure. */
  add(record: R): void {
    this.ok(runTable(this.path, ['a', ...this.fields.map(f => `${f}=${record[f]}`)]));
  }

  /** Set fields on a record, unconditionally. */
  set(id: string, fields: Partial<R>): void {
    this.ok(runTable(this.path, ['s', this.rowOf(id), ...fieldArgs(fields)]));
  }

  /**
   * Move a record from one state to another, setting `fields` with it — a
   * compare-and-swap: false when its state had changed meanwhile (tabeli's
   * exit 4), so the caller rereads instead of overwriting.
   */
  transition(id: string, from: R['state'], to: R['state'], fields: Partial<R> = {}): boolean {
    const run = runTable(this.path, ['s', this.rowOf(id), `state=${to}`, ...fieldArgs(fields), 'if', `state=${from}`]);
    if (run.status === 4) return false;
    this.ok(run);
    return true;
  }

  private rowOf(id: string): string {
    const [r] = queryTable(this.path, [`${this.key}=${id}`]);
    if (!r) throw new Error(`no record ${id}`);
    return String(r.id);
  }


  private asRecord(r: Record<string, string>): R {
    const out = {} as Record<string, string>;
    for (const f of this.fields) out[f] = r[f] ?? '';
    return out as unknown as R;
  }

  private ok(run: ReturnType<typeof runTable>): void {
    if (run.status !== 0) throw new Error(`${run.error?.message ?? `${run.stderr}${run.stdout}`}`.trim());
  }
}
