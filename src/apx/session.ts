// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The harness session an apx runs in: the id the harness puts in the variable
 * its adapter names (the document's `meta.sessionEnv`) — the one rule the
 * variables, the contracts and the call log follow — and what the session
 * keeps between calls (`Session`).
 */
import { join } from 'node:path';
import { sessionFile } from './paths.js';
import { isRecord } from '../guards.js';
import { readJsonFile, writeFileAtomic } from '../services/fs.js';

/** A session id as it may name a folder: no separator, never `.` or `..`. */
const SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** Why there is no session: no adapter names its variable, the variable is not set, or its value names no folder. */
const NO_SESSION = { noAdapter: 'noAdapter', notSet: 'notSet', unusable: 'unusable' } as const;

type NoSession = typeof NO_SESSION[keyof typeof NO_SESSION];

/** The session id the harness gives under `sessionEnv` — or why there is none. */
export function harnessSession(sessionEnv: string | undefined): { id: string } | { missing: NoSession } {
  if (!sessionEnv) return { missing: NO_SESSION.noAdapter };
  const id = process.env[sessionEnv];
  if (!id) return { missing: NO_SESSION.notSet };
  if (!SESSION_ID_RE.test(id)) return { missing: NO_SESSION.unusable };
  return { id };
}

/** What a session keeps for one agent: the number of its last call, and the call that last showed each block, by key. */
interface AgentState {
  call: number;
  shown: Record<string, number>;
}

/** A session's file: each agent's state, by name — one harness session serves several agents. */
type SessionState = Record<string, AgentState>;

/** An agent's state as a file holds it — a fresh one when the file says nothing usable. */
function agentStateOf(value: unknown): AgentState {
  if (!isRecord(value) || !Number.isInteger(value.call) || !isRecord(value.shown)) return { call: 0, shown: {} };
  const shown = Object.fromEntries(Object.entries(value.shown).filter(([, call]) => Number.isInteger(call)));
  return { call: value.call as number, shown: shown as Record<string, number> };
}

/**
 * What one agent's harness session keeps between its calls to the apx: the
 * number of the current call and, for each block the dashboard showed, the
 * number of the call that showed it last — call numbers and keys alone, never
 * a word of the envelope. Kept in a JSON file beside the call log, one per
 * harness session; with no session id it remembers nothing, so nothing is
 * shown lately. A file that cannot be read or written never fails a call: the
 * session then starts afresh, or is not kept.
 */
export class Session {
  private constructor(private readonly path: string | null, private readonly agent: string, private readonly state: SessionState) {}

  /** The session `agent` runs in — the harness's id under `sessionEnv` — in the project at `projectRoot`. */
  static open(projectRoot: string, sessionEnv: string | undefined, agent: string): Session {
    const session = harnessSession(sessionEnv);
    if (!('id' in session)) return new Session(null, agent, {});
    const path = join(projectRoot, sessionFile(session.id));
    return new Session(path, agent, Session.read(path));
  }

  /** The session file's state — empty when there is none yet, or it holds no JSON object: the session starts afresh. */
  private static read(path: string): SessionState {
    const parsed = readJsonFile(path);
    return isRecord(parsed) ? (parsed as SessionState) : {};
  }

  /** This agent's state, read once into the session's. */
  private get own(): AgentState {
    this.state[this.agent] = agentStateOf(this.state[this.agent]);
    return this.state[this.agent];
  }

  /** Count this call: its number is one more than the last one's. */
  count(): void {
    this.own.call += 1;
  }

  /** Forget every block shown: `start` — the agent reads its definition again. */
  clear(): void {
    this.own.shown = {};
  }

  /** How many calls ago the block was shown last — null when it was not shown lately. */
  ago(key: string): number | null {
    const shownAt = this.own.shown[key];
    return shownAt === undefined ? null : this.own.call - shownAt;
  }

  /** Record the blocks this call showed, drop those shown `recall` calls ago or more, and keep the session. */
  showed(keys: readonly string[], recall: number): void {
    const own = this.own;
    for (const key of keys) own.shown[key] = own.call;
    own.shown = Object.fromEntries(Object.entries(own.shown).filter(([, call]) => own.call - call < recall));
    this.save();
  }

  /** Write the session's file — whole, then moved into place, so a reader never sees half of it. */
  private save(): void {
    if (this.path === null) return;
    try {
      writeFileAtomic(this.path, `${JSON.stringify(this.state)}\n`);
    } catch {
      // A session that cannot be kept never fails a call: the next one starts afresh.
    }
  }
}
