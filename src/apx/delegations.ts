// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The registry of what a flow started in the background (`DELEGATE~`,
 * `FORK~`): one record per piece, in the session's folder, shared by every
 * agent of the session — the lead starts a piece, whoever carries it out
 * delivers or blocks it, the lead waits for it (`apx wait`). On disk, so it
 * outlives the conversation that started it.
 *
 *   running ──deliver──▶ delivered
 *      │  └──block────▶ blocked
 *      └──ended───────▶ ended        (the agent stopped without a word: the lead decides)
 *   ended / running ──take | reassign──▶ running
 *
 * Nothing moves a piece by itself: a WAIT that reaches its limit leaves what is
 * still running as it is, and says so (D52).
 */
import { RecordTable } from './recordTable.js';

export const DELEGATION_STATES = ['running', 'delivered', 'blocked', 'ended'] as const;
export type DelegationState = typeof DELEGATION_STATES[number];

/** The states a WAIT returns on: the piece will not move without the lead. */
export const SETTLED_STATES: readonly DelegationState[] = ['delivered', 'blocked', 'ended'];

/** One piece, as the table holds it. Every field is text: tabeli is flat. */
export interface DelegationRecord {
  /** `dlg-<8 hex>` — the id the compiled flow gives it (`meta.background`). */
  dlg: string;
  flow: string;
  step: string;
  /** Its INTO variable; '' when it fills none. */
  into: string;
  /** Who carries it out; '' for a fork of whoever runs the flow. (Not `by`: tabeli keeps that name for itself.) */
  assignee: string;
  state: DelegationState;
  /** What it delivered, as JSON text — '' until then. */
  result: string;
  /** Why it was blocked; '' otherwise. */
  reason: string;
  /** ISO time it was last started. */
  started_at: string;
  /** The agent that started it. */
  author: string;
}

const FIELDS: (keyof DelegationRecord)[] = ['dlg', 'flow', 'step', 'into', 'assignee', 'state', 'result', 'reason', 'started_at', 'author'];

/** The id of a background piece. */
export const DELEGATION_ID_RE = /^dlg-[0-9a-f]{8}$/;

export class DelegationTable extends RecordTable<DelegationRecord> {
  /** Open (create on first use) the registry of `sessionId` under `projectRoot` — or the reason it cannot be. */
  static open(projectRoot: string, sessionId: string, engine: string | undefined): DelegationTable | string {
    const at = RecordTable.place(projectRoot, sessionId, engine, 'delegations.tbl', 'delegations');
    return typeof at === 'string' ? at : new DelegationTable(at.path, at.dir, FIELDS, 'dlg');
  }
}
