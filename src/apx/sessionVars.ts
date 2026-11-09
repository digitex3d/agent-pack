// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where variables are kept — the one seam behind `apx get` / `apx set`, and
 * behind the record of every `apx check`.
 *
 * The apx is the only way to a variable; how its values are kept is this
 * module's business alone. Today, under the session's folder of the state
 * directory, as collections of the `files` driver: one of SESSION variables,
 * shared by every agent of the project, one of private variables per agent,
 * one of the checks the session's agents ran, one of the pieces they had
 * carried out. Nothing else knows these files — the grammar, the compiler and
 * the prompts only ever say `get`, `set` and `check`.
 */
import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { fileCollection } from '../storeDrivers/files/index.js';
import type { Collection, Doc, Filter } from '../storeDrivers/types.js';
import type { VarScope } from '../vars.js';

/** What a write records beside the value: its template (or '') and the agent that wrote it. */
export interface VarWrite {
  value: string;
  type: string;
  by: string;
}

/**
 * One `apx check`, as the session records it: the condition, who ran it, the
 * round, a fingerprint of the state (never the state), the judge's model and
 * probability, the threshold and the outcome. The agent's own opinion is never
 * asked, so never recorded.
 */
export interface CheckRecord {
  cnd: string;
  level: number;
  round: number;
  /** sha256 of the state text — '' when no state was built. */
  fingerprint: string;
  /** '' when the judge was not asked, or did not answer. */
  model: string;
  p: string;
  threshold: number;
  outcome: 'open' | 'closed';
  at: string;
}

/**
 * One piece a delegate answered or a program ran, as the session records it:
 * its contract, who carried it out, a fingerprint of its input (never the
 * input), and how it went.
 */
export interface ExecutorRecord {
  exe: string;
  executor: number;
  /** Who carried it out: the delegate's name, or `program`. */
  who: string;
  fingerprint: string;
  outcome: 'answered' | 'ran' | 'refused' | 'timeout' | 'broken';
  /** A condition's answer, when one came back. */
  holds?: boolean;
  at: string;
}

/**
 * One agent's view of a session's variables: read one by name and scope (null
 * when never stored), write one (the last write wins). A private variable is
 * the agent's alone; a SESSION one, every agent's. Every check the agent runs
 * is recorded, and read back — oldest first — to count its rounds. All throw
 * on a failure.
 */
export interface SessionVars {
  read(name: string, scope: VarScope): string | null;
  write(name: string, scope: VarScope, record: VarWrite): void;
  record(check: CheckRecord): void;
  checks(cnd: string): CheckRecord[];
  /** Record one delegation or program run (src/executor.ts). */
  executed(record: ExecutorRecord): void;
  /** A condition's answers in this session, oldest first — how many rounds its loop has run. */
  answers(exe: string): boolean[];
}

const is = (field: string, value: string): Filter => ({ field, value, op: '=' });

/** A record as the collection keeps it: every field text. */
function textDoc(record: object): Doc {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
}

/** The files driver answers at once; a promise here would be a driver mix-up. */
function sync<T>(v: T | Promise<T>): T {
  if (v instanceof Promise) throw new Error('the files driver answers synchronously');
  return v;
}

/** The variables `agent` sees in one session of a project; a collection is created when first written. */
export function openSessionVars(projectRoot: string, sessionId: string, agent: string): SessionVars {
  const dir = join(projectRoot, STATE_DIR, sessionId);
  const vars: Record<VarScope, Collection> = {
    session: fileCollection(join(dir, 'session.json'), 'name'),
    private: fileCollection(join(dir, 'private', `${agent}.json`), 'name'),
  };
  const checks = fileCollection(join(dir, 'checks.json'), null);
  const executors = fileCollection(join(dir, 'executors.json'), null);
  return {
    read: (name, scope) => { const doc = sync(vars[scope].get(name)); return doc ? String(doc.value ?? '') : null; },
    write: (name, scope, record) => { sync(vars[scope].put(textDoc({ name, ...record }))); },
    record: check => { sync(checks.put(textDoc({ agent, ...check }))); },
    checks: cnd => sync(checks.find([is('cnd', cnd), is('agent', agent)])).map(r => ({
      cnd: String(r.cnd), level: Number(r.level), round: Number(r.round), fingerprint: String(r.fingerprint ?? ''), model: String(r.model ?? ''),
      p: String(r.p ?? ''), threshold: Number(r.threshold), outcome: r.outcome === 'open' ? 'open' : 'closed', at: String(r.at ?? ''),
    })),
    executed: record => { sync(executors.put(textDoc({ agent, ...record }))); },
    answers: exe => sync(executors.find([is('exe', exe), is('agent', agent)]))
      .filter(r => r.holds === 'true' || r.holds === 'false').map(r => r.holds === 'true'),
  };
}
