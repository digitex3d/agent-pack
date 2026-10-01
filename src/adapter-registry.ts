// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { AdapterPlugin } from '../adapters/types.js';
import { Config } from './config.js';
import claudeCodeAdapter from '../adapters/claude-code/index.js';
import claudeCodeApxAdapter from '../adapters/claude-code-apx/index.js';
import cursorAdapter from '../adapters/cursor/index.js';
import junieAdapter from '../adapters/junie/index.js';
import jevJudge from '../adapters/jev/index.js';
import type { JudgePlugin } from './judge/types.js';

/**
 * The adapters shipped with agent-pack, by name: a config names them
 * (`adapters: ['claude-code']`) instead of importing them, so it loads with a
 * global install and in projects that are not Node packages.
 */
const BUILTIN_ADAPTERS: Record<string, () => AdapterPlugin> = {
  'claude-code': () => claudeCodeAdapter(),
  'claude-code-apx': () => claudeCodeApxAdapter(),
  cursor: () => cursorAdapter(),
  junie: () => junieAdapter(),
};

/** The judges shipped with agent-pack, by name (`judge: { adapter: 'jev' }`). */
const BUILTIN_JUDGES: Record<string, () => JudgePlugin> = {
  jev: () => jevJudge(),
};

/** A config entry as a plugin of one kind: a built-in by name, or a plugin object as is. */
function fromBuiltins<T>(kind: string, builtins: Record<string, () => T>): (entry: T | string) => T {
  return entry => {
    if (typeof entry !== 'string') return entry;
    const make = builtins[entry];
    if (!make) throw new Error(`Unknown ${kind} "${entry}" — built-in ${kind}s: ${Object.keys(builtins).join(', ')}`);
    return make();
  };
}

/** A config entry as an adapter: a built-in by name, or an adapter object as is. */
export const resolveAdapter = fromBuiltins('adapter', BUILTIN_ADAPTERS);

/** A config entry as a judge: a built-in by name, or a judge object as is. */
export const resolveJudge = fromBuiltins('judge', BUILTIN_JUDGES);

export class AdapterRegistry {
  private adapters: AdapterPlugin[];

  private constructor(adapters: AdapterPlugin[]) {
    this.adapters = adapters;
  }

  static fromConfig(config: Config): AdapterRegistry {
    return AdapterRegistry.load(config.adapters);
  }

  static load(adapters: AdapterPlugin[]): AdapterRegistry {
    const seen = new Set<string>();
    for (const a of adapters) {
      if (a.apiVersion !== 2) {
        throw new Error(`Adapter "${a.name}" requires apiVersion 2, got ${(a as { apiVersion: unknown }).apiVersion}`);
      }
      if (a.type !== 'adapter') {
        throw new Error(`Adapter "${a.name}" has invalid type "${a.type}" (expected "adapter")`);
      }
      if (seen.has(a.name)) {
        throw new Error(`Duplicate adapter name "${a.name}"`);
      }
      seen.add(a.name);
    }
    return new AdapterRegistry(adapters);
  }

  get(name: string): AdapterPlugin {
    const found = this.adapters.find(a => a.name === name);
    if (!found && name in BUILTIN_ADAPTERS) return resolveAdapter(name);
    if (!found) {
      const available = [...new Set([...this.list(), ...Object.keys(BUILTIN_ADAPTERS)])].join(', ');
      throw new Error(`Adapter "${name}" not found. Available: ${available}`);
    }
    return found;
  }

  list(): string[] {
    return this.adapters.map(a => a.name);
  }
}
