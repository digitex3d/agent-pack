// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The verbs of an apx — what its first word may be. A store is reached by its
 * name in the same place, so none may be named like one of these: the compiler
 * refuses it. A dimension is reached by its id, after the verb `dimension`. No imports, so the compiler reads the list without the
 * engine.
 */
export const APX_VERBS = ['start', 'scope', 'ls', 'get', 'set', 'refs', 'find', 'md', 'flow', 'run', 'input', 'answer', 'check', 'dimension', 'version', 'help'] as const;
export type ApxVerb = typeof APX_VERBS[number];
