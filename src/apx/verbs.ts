// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The verbs of an apx — what its first word may be: the engine's own, and the
 * kinds it serves (`<kind> <operation> [<id>] …`, src/apx/service.ts). No
 * imports, so the compiler reads the lists without the engine.
 */
export const APX_VERBS = ['start', 'scope', 'ls', 'get', 'set', 'refs', 'find', 'md', 'flow', 'run', 'check', 'contract', 'wait', 'guard', 'version', 'help'] as const;
export type ApxVerb = typeof APX_VERBS[number];

/** The kinds the apx serves, each by its name — the registry (src/apx/services) holds one service per kind. */
export const APX_SERVICE_KINDS = ['store', 'dimension', 'delegate'] as const;
