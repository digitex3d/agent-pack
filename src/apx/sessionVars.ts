// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where variables are kept — the one seam behind `apx get` / `apx set`, and
 * behind the record of every `apx check`.
 *
 * The apx is the only way to a variable; how its values are kept is this
 * module's business alone. Today, as engine stores (engineStores.ts) under
 * the session's folder of the state directory, reached through the store
 * API like every other store: one of SESSION variables, shared by every
 * agent of the project, one of private variables per agent, one of the
 * checks the session's agents ran, one of the pieces they had carried out.
 * Nothing else knows these files — the grammar, the compiler and the prompts
 * only ever say `get`, `set` and `check`.
 */
import type { Collection, Doc, Filter } from '../storeDrivers/types.js';
import type { VarScope } from '../vars.js';
import { checksStore, engineStore, executorsStore, varsStore } from './engineStores.js';
import { checkWrite, open, type OpenStore, type StoreSpec } from './stores.js';

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

/** A record as the store keeps it: numbers as numbers, the rest text, an empty or absent field left out. */
function docOf(record: object): Doc {
  return Object.fromEntries(Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => [key, typeof value === 'number' ? value : String(value)]));
}

/** The engine's driver answers at once; a promise here would be a driver mix-up. */
function sync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error("the engine's tables need a driver that answers synchronously");
  return value;
}

/** One engine store of the session: opened once, every write checked against its slots. */
function table(store: OpenStore): { put(doc: Doc): void; get(key: string): Doc | null; find(filters: Filter[]): Doc[] } {
  let opened: Collection | null = null;
  const collection = (): Collection => opened ??= sync(open(store));
  return {
    put: doc => { checkWrite(store, doc, true); sync(collection().put(doc)); },
    get: key => sync(collection().get(key)),
    find: filters => sync(collection().find(filters)),
  };
}

const str = (value: unknown): string => value === undefined ? '' : String(value);

/** The variables `agent` sees in one session of a project; a store's file is created when first written. */
export function openSessionVars(projectRoot: string, sessionId: string, agent: string): SessionVars {
  const at = (spec: StoreSpec) => table(engineStore(projectRoot, sessionId, agent, spec));
  const vars: Record<VarScope, ReturnType<typeof table>> = { session: at(varsStore('session')), private: at(varsStore(`private/${agent}`)) };
  const checks = at(checksStore);
  const executors = at(executorsStore);
  return {
    read: (name, scope) => { const doc = vars[scope].get(name); return doc ? str(doc.value) : null; },
    write: (name, scope, record) => vars[scope].put(docOf({ name, ...record })),
    record: check => checks.put(docOf({ agent, ...check })),
    checks: cnd => checks.find([is('cnd', cnd), is('agent', agent)]).map(record => ({
      cnd: str(record.cnd), level: Number(record.level), round: Number(record.round), fingerprint: str(record.fingerprint), model: str(record.model),
      p: str(record.p), threshold: Number(record.threshold), outcome: record.outcome === 'open' ? 'open' : 'closed', at: str(record.at),
    })),
    executed: record => executors.put(docOf({ agent, ...record, ...(record.holds === undefined ? {} : { holds: String(record.holds) }) })),
    answers: exe => executors.find([is('exe', exe), is('agent', agent)])
      .filter(record => record.holds === 'true' || record.holds === 'false').map(record => record.holds === 'true'),
  };
}
