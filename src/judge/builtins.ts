// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judges shipped with agent-pack, by name — the one table both the
 * compiler (`judge`, `checks` config keys) and the apx (`check`, which loads
 * the judge the apx records by name) resolve through. It imports the judges
 * alone, so the apx engine bundles it without the harness adapters.
 */
import jevJudge from '../../adapters/jev/index.js';
import geminiJudge from '../../adapters/gemini/index.js';
import type { JudgePlugin } from './types.js';

/** The judges shipped with agent-pack, by name (`judge: { adapter: 'jev' }`). */
const BUILTIN_JUDGES: Record<string, () => JudgePlugin> = {
  jev: () => jevJudge(),
  gemini: () => geminiJudge(),
};

/** A built-in named with its options: `{ name: '<built-in>', …options }`. */
export interface BuiltinEntry {
  name: string;
  [option: string]: unknown;
}

/**
 * A config entry as a plugin of one kind: a built-in by name, a built-in with
 * its options (`{ name, …options }`, no `type`) — `check` throws on options
 * it refuses — or a plugin object (it has a `type`) as is.
 */
export function fromBuiltins<T>(
  kind: string,
  // The options are each factory's own: it takes what its plugin declares.
  builtins: Record<string, (opts?: any) => T>,
  check: (name: string, opts: Record<string, unknown>) => void = () => {},
): (entry: T | BuiltinEntry | string) => T {
  return entry => {
    if (typeof entry === 'object' && entry !== null && 'type' in entry) return entry as T;
    const name = typeof entry === 'string' ? entry : (entry as BuiltinEntry | null)?.name;
    if (typeof name !== 'string') throw new Error(`a ${kind} is a built-in name, { name: '<built-in>', …options }, or a ${kind} object with its type`);
    const make = builtins[name];
    if (!make) throw new Error(`Unknown ${kind} "${name}" — built-in ${kind}s: ${Object.keys(builtins).join(', ')}`);
    if (typeof entry === 'string') return make();
    const { name: _, ...opts } = entry as BuiltinEntry;
    check(name, opts);
    return make(opts);
  };
}

/** A config entry as a judge: a built-in by name, or a judge object as is. */
export const resolveJudge = fromBuiltins('judge', BUILTIN_JUDGES);
