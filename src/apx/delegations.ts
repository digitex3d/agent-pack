// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The registry of the work a flow hands out, one record per piece, in the
 * session's folder, shared by every agent of the session. On disk, so it
 * outlives the conversation that started it. Two kinds of piece, one table:
 *
 *   - a background delegation (`dlg-…`, `DELEGATE~` / `FORK~`): started by the
 *     lead, delivered or blocked by whoever carries it out — inside an EACH, one
 *     piece per run (`dlg-…-<k>`), their results collected at the WAIT;
 *   - a contract (`ctr-…`, D16–18): a zone of the code a MARK bound to a spec —
 *     a promise that waits (`marked`) until a `DELEGATE <list> BY <agent>`
 *     starts it in a copy of its own; delivered from that copy, then merged.
 *
 *   marked ──start──▶ running ──deliver──▶ delivered ──merge──▶ merged   (a contract)
 *                        │  └──block────▶ blocked
 *                        └──ended───────▶ ended        (the agent stopped without a word: the lead decides)
 *   ended / running ──take | reassign──▶ running
 *
 * Nothing moves a piece by itself: a WAIT that reaches its limit leaves what is
 * still running as it is, and says so (D52).
 */
import { RecordTable } from './recordTable.js';

export const DELEGATION_STATES = ['marked', 'running', 'delivered', 'merged', 'blocked', 'ended'] as const;
export type DelegationState = typeof DELEGATION_STATES[number];

/** The states a WAIT returns on: the piece will not move without the lead. */
export const SETTLED_STATES: readonly DelegationState[] = ['delivered', 'merged', 'blocked', 'ended'];

/** One piece, as the table holds it. Every field is text: tabeli is flat. */
export interface DelegationRecord {
  /** The piece's id: `dlg-<8 hex>` for a background delegation (the compiled flow's, `meta.background`), `ctr-<8 hex>` for a contract. */
  dlg: string;
  flow: string;
  step: string;
  /** Its INTO variable — for a contract, the list its MARK fills; '' when none. */
  into: string;
  /** Who carries it out; '' for a fork of whoever runs the flow, or a contract not started yet. (Not `by`: tabeli keeps that name for itself.) */
  assignee: string;
  state: DelegationState;
  /** What it delivered, as JSON text — '' until then. */
  result: string;
  /** Why it was blocked; '' otherwise. */
  reason: string;
  /** ISO time it was last started — the contracts one DELEGATE started share it. */
  started_at: string;
  /** The agent that started it — or, for a contract, marked it. */
  author: string;
  /** A contract's MARK (`mrk-…`); '' for a background delegation. */
  mark: string;
  /** A contract's spec, JSON — an instance of its MARK's AS template. */
  spec: string;
  /** A contract's zones, in the base: `file:open-close;…` — set when it starts. */
  zone: string;
  /** The globs a contract may write beyond its zones — its MARK's WITHIN domain, comma separated. */
  writes: string;
  /** What a contract's delivery left out, `; ` separated; '' when nothing. */
  left_out: string;
  /** Why it left that out — the assignee's word. */
  why: string;
  /**
   * A background delegation's perimeter, set when it starts (D65): JSON, a list
   * of glob lists — a file it writes must match one glob of each (its step's
   * `@WITHIN`, its assignee's own); `[]` in it writes nothing. '' when none.
   */
  perimeter: string;
}

const FIELDS: (keyof DelegationRecord)[] = ['dlg', 'flow', 'step', 'into', 'assignee', 'state', 'result', 'reason', 'started_at', 'author', 'mark', 'spec', 'zone', 'writes', 'left_out', 'why', 'perimeter'];

/** The id of a background piece — or of one run of one inside an EACH (`dlg-<8 hex>-<k>`, D56). */
export const DELEGATION_ID_RE = /^dlg-[0-9a-f]{8}(?:-[1-9]\d*)?$/;

/** A piece id's background delegation, and its run inside an EACH — null when it is none. */
export function pieceOf(id: string): { work: string; run: number | null } {
  const m = /^(dlg-[0-9a-f]{8})(?:-([1-9]\d*))?$/.exec(id);
  return m ? { work: m[1], run: m[2] ? Number(m[2]) : null } : { work: id, run: null };
}

/** The records of one background delegation: the piece itself, or every run of it an EACH started. */
export function runsOf(all: readonly DelegationRecord[], work: string): DelegationRecord[] {
  return all.filter(r => r.dlg === work || pieceOf(r.dlg).work === work && pieceOf(r.dlg).run !== null)
    .sort((a, b) => (pieceOf(a.dlg).run ?? 0) - (pieceOf(b.dlg).run ?? 0));
}
/** The id of a contract. */
export const CONTRACT_ID_RE = /^ctr-[0-9a-f]{8}$/;
/** The id of a MARK — what a contract list is started and waited for by. */
export const MARK_ID_RE = /^mrk-[0-9a-f]{8}$/;

/** A fresh record: every field empty but those given. */
export function pieceRecord(fields: Partial<DelegationRecord> & Pick<DelegationRecord, 'dlg' | 'state'>): DelegationRecord {
  const out = Object.fromEntries(FIELDS.map(f => [f, ''])) as unknown as DelegationRecord;
  return { ...out, ...fields };
}

export class DelegationTable extends RecordTable<DelegationRecord> {
  /** Open (create on first use) the registry of `sessionId` under `projectRoot` — or the reason it cannot be. */
  static open(projectRoot: string, sessionId: string, engine: string | undefined): DelegationTable | string {
    const at = RecordTable.place(projectRoot, sessionId, engine, 'delegations.tbl', 'delegations');
    return typeof at === 'string' ? at : new DelegationTable(at.path, at.dir, FIELDS, 'dlg');
  }

  /** The contracts of a MARK the latest DELEGATE of it started — or, before any started, none. */
  batchOf(mark: string): DelegationRecord[] {
    const started = this.all().filter(r => r.mark === mark && r.state !== 'marked');
    const latest = started.reduce((max, r) => (r.started_at > max ? r.started_at : max), '');
    return started.filter(r => r.started_at === latest);
  }
}
