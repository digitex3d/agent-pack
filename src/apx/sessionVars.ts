// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where variables are kept — the one seam behind `apx get` / `apx set`, and
 * behind the record of every `apx check`.
 *
 * The apx is the only way to a variable; how its values are kept is this
 * module's business alone. Today, under the session's folder of the state
 * directory: one tabeli table of SESSION variables, shared by every agent of
 * the project, one table of private variables per agent, and one table of the
 * checks the session's agents ran. Nothing else knows these files, nor
 * tabeli's verbs — the grammar, the compiler and the prompts only ever say
 * `get`, `set` and `check`.
 */
import { join } from 'path';
import { STATE_DIR } from './paths.js';
import { openTable, queryTable, runTable, tabeliVersionError, upsertBy } from './tabeli.js';
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
}

/**
 * The variables `agent` sees in one session of a project. A table is opened —
 * created on first use by `engine`, the apx's tabeli — when first used.
 */
export function openSessionVars(projectRoot: string, sessionId: string, agent: string, engine: string | undefined): SessionVars {
  const dir = join(projectRoot, STATE_DIR, sessionId);
  const files: Record<VarScope | 'checks', string> = {
    session: join(dir, 'session.tbl'), private: join(dir, 'private', `${agent}.tbl`), checks: join(dir, 'checks.tbl'),
  };
  const table = (kind: VarScope | 'checks'): string => {
    // A table runs its own engine: it too must keep a value's bytes.
    const error = openTable(files[kind], engine) ?? tabeliVersionError(files[kind], ['help'], `upgrade it: ${engine ?? 'tabeli'} upgrade ${files[kind]}`);
    if (error) throw new Error(`${kind === 'checks' ? 'checks' : 'variables'}: ${error}`);
    return files[kind];
  };
  const added = (run: { status: number | null; error?: Error; stderr: string; stdout: string }): void => {
    if (run.status !== 0) throw new Error(`${run.error?.message ?? `${run.stderr}${run.stdout}`}`.trim());
  };
  return {
    read: (name, scope) => queryTable(table(scope), [`name=${name}`])[0]?.value ?? null,
    write: (name, scope, record) => added(upsertBy(table(scope), 'name', name, [`value=${record.value}`, `type=${record.type}`, `by=${record.by}`]).run),
    record: check => added(runTable(table('checks'), ['a', `agent=${agent}`, ...Object.entries(check).map(([k, v]) => `${k}=${v}`)])),
    checks: cnd => queryTable(table('checks'), [`cnd=${cnd}`, `agent=${agent}`]).map(r => ({
      cnd: r.cnd, level: Number(r.level), round: Number(r.round), fingerprint: r.fingerprint ?? '', model: r.model ?? '',
      p: r.p ?? '', threshold: Number(r.threshold), outcome: r.outcome === 'open' ? 'open' : 'closed', at: r.at ?? '',
    })),
  };
}
