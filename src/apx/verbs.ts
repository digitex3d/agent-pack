// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The verbs of an apx — what its first word may be: the engine's own, and the
 * kinds it serves (`<kind> <operation> [<id>] …`, src/apx/service.ts). No
 * imports, so the compiler reads the lists without the engine.
 */
export const APX_VERBS = ['start', 'scope', 'ls', 'get', 'set', 'refs', 'find', 'md', 'flow', 'run', 'check', 'contract', 'wait', 'guard', 'version', 'help'] as const;
export type ApxVerb = typeof APX_VERBS[number];

/** The flag of `ls` that prints the listing as JSON — what the chat's launcher reads (listing.ts). */
export const JSON_FLAG = '--json';

/** The words a verb takes as an argument: `count` asks `ls` and `store` for how many, `json` asks `get`, `store` and `dimension` for their answer as JSON. */
export const ARGUMENT = { count: 'count', json: 'json' } as const;

/** The words that make an answer one a program reads: the dashboard never follows it. */
export const DATA_FLAGS: readonly string[] = [JSON_FLAG, ARGUMENT.json];

/** Whether a word of a call is one of a typed list of words. */
export function isOneOf<Word extends string>(words: readonly Word[], word: string): word is Word {
  return (words as readonly string[]).includes(word);
}

/** The flags that ask for `help`, as the verb does. */
export const HELP_FLAGS = ['-h', '--help'] as const;

/**
 * The commands whose answer the dashboard never follows (src/apx/dashboard.ts):
 * help and version say what the apx is; run answers with a program's output,
 * guard with the hook's verdict — both read by a program. Any call holding one
 * of the DATA_FLAGS joins them. So does `start` while it asks its quiz — the
 * answers come with the next call — and `get` when it prints a variable's
 * value: only the engine knows when (engine.ts).
 */
export const DASHBOARD_EXEMPT: readonly (ApxVerb | typeof HELP_FLAGS[number])[] = ['help', ...HELP_FLAGS, 'version', 'run', 'guard'];

/** The kinds the apx serves, each by its name — the registry (src/apx/services) holds one service per kind. */
export const APX_SERVICE_KINDS = ['store', 'dimension', 'delegate'] as const;
