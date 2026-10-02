// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where variables are kept — the one seam behind `apx get` / `apx set`.
 *
 * The apx is the only way to a variable; how its values are kept is this
 * module's business alone. Today, under the session's folder of the state
 * directory: one tabeli table of SESSION variables, shared by every agent of
 * the project, and one table of private variables per agent. Nothing else knows
 * these files, nor tabeli's verbs — the grammar, the compiler and the prompts
 * only ever say `get` and `set`.
 */
import { join } from 'path';
import { STATE_DIR } from './paths.js';
import { openTable, queryTable, tabeliVersionError, upsertBy } from './tabeli.js';
import type { VarScope } from '../vars.js';

/** What a write records beside the value: its template (or '') and the agent that wrote it. */
export interface VarWrite {
  value: string;
  type: string;
  by: string;
}

/**
 * One agent's view of a session's variables: read one by name and scope (null
 * when never stored), write one (the last write wins). A private variable is
 * the agent's alone; a SESSION one, every agent's. Both throw on a failure.
 */
export interface SessionVars {
  read(name: string, scope: VarScope): string | null;
  write(name: string, scope: VarScope, record: VarWrite): void;
}

/** The variables `agent` sees in one session of a project. A table is opened — created on first use — when first used. */
export function openSessionVars(projectRoot: string, sessionId: string, agent: string): SessionVars {
  const dir = join(projectRoot, STATE_DIR, sessionId);
  const files: Record<VarScope, string> = { session: join(dir, 'session.tbl'), private: join(dir, 'private', `${agent}.tbl`) };
  const table = (scope: VarScope): string => {
    // A table runs its own engine: it too must keep a value's bytes.
    const error = openTable(files[scope]) ?? tabeliVersionError(files[scope], ['help']);
    if (error) throw new Error(`variables: ${error}`);
    return files[scope];
  };
  return {
    read: (name, scope) => queryTable(table(scope), [`name=${name}`])[0]?.value ?? null,
    write: (name, scope, record) => {
      const { run } = upsertBy(table(scope), 'name', name, [`value=${record.value}`, `type=${record.type}`, `by=${record.by}`]);
      if (run.status !== 0) throw new Error(`${run.error?.message ?? `${run.stderr}${run.stdout}`}`.trim());
    },
  };
}
