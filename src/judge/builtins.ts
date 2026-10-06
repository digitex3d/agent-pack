// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judges shipped with agent-pack, by name — the one table both the
 * compiler (`judge`, `checks` config keys) and the apx (`check`, which loads
 * the judge the apx records by name) resolve through. It imports the judges
 * alone, so the apx engine bundles it without the harness adapters.
 */
import jevJudge from '../../adapters/jev/index.js';
import type { JudgePlugin } from './types.js';

/** The judges shipped with agent-pack, by name (`judge: { adapter: 'jev' }`). */
const BUILTIN_JUDGES: Record<string, () => JudgePlugin> = {
  jev: () => jevJudge(),
};

/** A config entry as a plugin of one kind: a built-in by name, or a plugin object as is. */
export function fromBuiltins<T>(kind: string, builtins: Record<string, () => T>): (entry: T | string) => T {
  return entry => {
    if (typeof entry !== 'string') return entry;
    const make = builtins[entry];
    if (!make) throw new Error(`Unknown ${kind} "${entry}" — built-in ${kind}s: ${Object.keys(builtins).join(', ')}`);
    return make();
  };
}

/** A config entry as a judge: a built-in by name, or a judge object as is. */
export const resolveJudge = fromBuiltins('judge', BUILTIN_JUDGES);
