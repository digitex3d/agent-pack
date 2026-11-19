// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The harness session an apx runs in: the id the harness puts in the variable
 * its adapter names (the document's `meta.sessionEnv`) — the one rule the
 * variables, the contracts and the call log follow. No imports: the apx engine
 * bundles this module.
 */

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
