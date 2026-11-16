// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { AdapterPlugin } from '../adapters/types.js';
import type { Config } from './config.js';
import claudeCodeAdapter from '../adapters/claude-code/index.js';
import claudeCodeApxAdapter from '../adapters/claude-code-apx/index.js';
import codexAdapter from '../adapters/codex/index.js';
import cursorAdapter from '../adapters/cursor/index.js';
import opencodeAdapter from '../adapters/opencode/index.js';
import acpAdapter, { acpTransport } from '../adapters/acp/index.js';
import { checkBudgetModels } from '../adapters/budget.js';
import { fromBuiltins } from './judge/builtins.js';
import { FORMULAS, fill } from './formulas.js';

/**
 * The adapters shipped with agent-pack, by name: a config names them
 * (`adapters: ['claude-code']`) instead of importing them, so it loads with a
 * global install and in projects that are not Node packages — with its
 * options, `{ name: 'opencode', models: { … } }`.
 */
// The options are each factory's own: it takes what its adapter declares.
type Factory = (opts?: any) => AdapterPlugin;

/** A harness's factory that also takes `acp: { … }`: its delegations then go through the ACP client, not its own CLI. */
const overAcp = (make: Factory): Factory => (opts?: Record<string, unknown>) => {
  if (opts?.acp === undefined) return make(opts);
  const { acp, ...own } = opts;
  return acpTransport(make(own), acp);
};

const BUILTIN_ADAPTERS: Record<string, Factory> = {
  'claude-code': overAcp(opts => claudeCodeAdapter(opts)),
  'claude-code-apx': overAcp(opts => claudeCodeApxAdapter(opts)),
  codex: overAcp(opts => codexAdapter(opts)),
  cursor: overAcp(opts => cursorAdapter(opts)),
  opencode: overAcp(opts => opencodeAdapter(opts)),
  acp: opts => acpAdapter(opts),
};

/**
 * A config entry as an adapter: a built-in by name, a built-in with its
 * options (`{ name, …options }` — `models` the model of each `BUDGET` tier,
 * checked), or an adapter object (`type: 'adapter'`) as is.
 */
export const resolveAdapter = fromBuiltins('adapter', BUILTIN_ADAPTERS, (name, opts) => {
  if (opts.models !== undefined) checkBudgetModels(name, opts.models);
});

/** Every adapter shipped with agent-pack, by name — the harnesses installed before any config names one (D66). */
export function builtinAdapters(): AdapterPlugin[] {
  return Object.values(BUILTIN_ADAPTERS).map(make => make());
}

/**
 * The config's adapters, each harness name taken once: a further harness an
 * adapter reaches (an acp server) cannot take the name of an installed one.
 * Throws, naming both.
 */
export function checkHarnessNames(adapters: readonly AdapterPlugin[]): AdapterPlugin[] {
  const installed = new Set([...Object.keys(BUILTIN_ADAPTERS), ...adapters.map(adapter => adapter.name)]);
  const reached = new Map<string, string>();
  for (const adapter of adapters) {
    for (const { name } of adapter.harnesses ?? []) {
      if (installed.has(name)) throw new Error(fill(FORMULAS.messages.harnesses.clash, { adapter: adapter.name, name }));
      const other = reached.get(name);
      if (other) throw new Error(fill(FORMULAS.messages.harnesses.twice, { adapter: adapter.name, other, name }));
      reached.set(name, adapter.name);
    }
  }
  return [...adapters];
}

/** A config entry as a judge — the judges' own table (judge/builtins.ts), shared with the apx. */
export { resolveJudge } from './judge/builtins.js';

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
    for (const adapter of adapters) {
      if (adapter.apiVersion !== 2) {
        throw new Error(`Adapter "${adapter.name}" requires apiVersion 2, got ${(adapter as { apiVersion: unknown }).apiVersion}`);
      }
      if (adapter.type !== 'adapter') {
        throw new Error(`Adapter "${adapter.name}" has invalid type "${adapter.type}" (expected "adapter")`);
      }
      if (seen.has(adapter.name)) {
        throw new Error(`Duplicate adapter name "${adapter.name}"`);
      }
      seen.add(adapter.name);
    }
    return new AdapterRegistry(adapters);
  }

  get(name: string): AdapterPlugin {
    const found = this.adapters.find(adapter => adapter.name === name);
    if (!found && name in BUILTIN_ADAPTERS) return resolveAdapter(name);
    if (!found) {
      const available = [...new Set([...this.list(), ...Object.keys(BUILTIN_ADAPTERS)])].join(', ');
      throw new Error(`Adapter "${name}" not found. Available: ${available}`);
    }
    return found;
  }

  list(): string[] {
    return this.adapters.map(adapter => adapter.name);
  }
}
