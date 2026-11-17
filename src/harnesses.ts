// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The harnesses a delegation can go to (D66): `DELEGATE … BY <harness>:<agent>`
 * hands the task to an agent of the project as another harness runs it, from
 * outside — as that harness's adapter describes in its `invoke.ap` recipe.
 *
 * Three lists, one source each:
 *   - installed: the adapters agent-pack ships, and any adapter object a config holds;
 *   - enabled:   the config's `adapters:` — the harnesses the project compiles for;
 *   - delegable: the enabled ones with a recipe (`invocation`).
 *
 * A harness a delegation names is a dependency of the compilation: enabled,
 * with a recipe, and its CLI on the PATH — or the build fails, saying which.
 *
 * Declarative throughout: this module reads recipes and checks names; the
 * command is run by the agent, with its own shell, as the compiled text says.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AdapterPlugin, Invocation } from '../adapters/types.js';
import type { BudgetModels } from '../adapters/budget.js';
import { builtinAdapters } from './adapter-registry.js';
import { parseTemplate } from './shapeCompiler.js';
import { fill } from './formulas.js';
import { modelOfTier } from '../adapters/budget.js';
import type { HarnessInvocation } from './delegation.js';

export { HARNESS_SEP, splitHarness, type HarnessInvocation } from './delegation.js';

/** One harness, as `agent-pack harness list` shows it. */
export interface HarnessRow {
  name: string;
  enabled: boolean;
  /** Its recipe read, or why it is not delegable — null when it has a recipe. */
  invocation: HarnessInvocation | null;
  problem: string | null;
  /** Whether its CLI is an executable on the PATH (or, written as a path, an executable file) — null when it has no recipe. */
  onPath: boolean | null;
  /** How its recipe reaches it: `cli`, its own CLI, or a transport such as `acp` — null when it has no recipe. */
  transport: string | null;
  /** The model of each `BUDGET` tier on this harness (adapters/budget.ts) — empty when it maps none. */
  models: Record<string, string>;
}

/** Whether a command written as a path (it holds a `/`) is named that way, rather than looked up on the PATH. */
const isPath = (cli: string): boolean => cli.includes('/');

/** Whether `cli` is an executable file — at its path when written as one, else in one of the PATH's folders — looked up, never run. */
export function onPath(cli: string, path = process.env.PATH ?? ''): boolean {
  const executable = (file: string): boolean => {
    // A missing or non-executable file is the answer itself: no.
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  };
  if (isPath(cli)) return executable(cli);
  return path.split(delimiter).filter(Boolean).some(dir => executable(join(dir, cli)));
}

/** A harness's recipe, read — or why it cannot be: an adapter's own, or one of the further harnesses it reaches. */
export function readInvocation(harness: { name: string; invocation?: Invocation }): { invocation: HarnessInvocation } | { problem: string } {
  const { name, invocation: inv } = harness;
  if (!inv) return { problem: `${name} has no launch recipe — it cannot be delegated to` };
  let text: string;
  try { text = readFileSync(inv.recipe, 'utf-8'); } catch { return { problem: `${name}: its recipe ${inv.recipe} cannot be read` }; }
  const parsed = parseTemplate(text);
  const body = parsed?.bodyLayout?.trim();
  if (!parsed || !body) return { problem: `${name}: its recipe ${inv.recipe} is no TEMPLATE with a BODY — the BODY is the command line` };
  // The recipe's own slots, filled now; the delegation's (`{project}`, `{prompt}`, …) are the apx's, at start.
  const command = fill(body, inv.fills);
  return {
    invocation: {
      command, cli: inv.cli,
      rules: parsed.slots.flatMap(slot => slot.rules),
      carry: inv.carry ?? [],
      ...optionalOf(inv),
    },
  };
}

/** What a recipe declares only when its harness has it: the shape and model flags, the intro, the transport. */
function optionalOf(inv: Invocation): Pick<HarnessInvocation, 'shape' | 'model' | 'intro' | 'transport'> {
  return {
    ...(inv.shape ? { shape: inv.shape } : {}),
    ...(inv.model ? { model: inv.model } : {}),
    ...(inv.intro ? { intro: inv.intro } : {}),
    ...(inv.transport ? { transport: inv.transport } : {}),
  };
}

/** One harness as a row: its recipe read, its CLI looked up, the models its tiers map to. */
function rowOf(harness: { name: string; invocation?: Invocation; models?: BudgetModels }, enabled: boolean, path?: string): HarnessRow {
  const { name, models } = harness;
  const read = readInvocation(harness);
  const invocation = 'invocation' in read ? read.invocation : null;
  return {
    name, enabled, invocation, problem: 'problem' in read ? read.problem : null,
    onPath: invocation ? onPath(invocation.cli, path) : null,
    transport: invocation ? invocation.transport ?? 'cli' : null,
    models: Object.fromEntries(Object.entries(models ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

/** Every harness installed — the built-ins, then any adapter object the config holds — with what the config enables. */
export function harnessesOf(enabled: readonly AdapterPlugin[], path?: string): HarnessRow[] {
  const byName = new Map<string, AdapterPlugin>();
  for (const adapter of builtinAdapters()) byName.set(adapter.name, adapter);
  for (const adapter of enabled) byName.set(adapter.name, adapter);
  const on = new Set(enabled.map(adapter => adapter.name));
  // Each adapter, then the further harnesses it reaches (an acp server), enabled with it.
  return [...byName.values()].flatMap(adapter => [
    rowOf(adapter, on.has(adapter.name), path),
    ...(adapter.harnesses ?? []).map(reached => rowOf(reached, on.has(adapter.name), path)),
  ]);
}

/**
 * The model of each agent on a harness: the one its `BUDGET` tier maps to there
 * — what the apx fills a recipe's `{model}` with. An agent with no tier, or a
 * tier the harness maps to none, is left out: it runs on the harness's default.
 */
export function agentModels(row: HarnessRow, agents: readonly { name: string; budget?: string | null }[]): Record<string, string> {
  return Object.fromEntries(agents.flatMap(agent => { const model = modelOfTier(row.models, agent.budget); return model ? [[agent.name, model]] : []; }));
}

/** Why the model of `agent` on `harness` falls back to the harness's own default although the agent declares a tier — or null (D66). */
export function modelProblem(harness: string, agent: { name: string; budget?: string | null } | undefined, rows: readonly HarnessRow[]): string | null {
  const row = rows.find(harnessRow => harnessRow.name === harness);
  if (!agent?.budget || !row || modelOfTier(row.models, agent.budget)) return null;
  return `BY ${harness}:${agent.name}: \`${agent.name}\` declares BUDGET ${agent.budget}, and ${harness} maps no model to it — it runs on ${harness}'s own default model; `
    + `map the tier in agent-pack.config.mjs: adapters: [{ name: '${harness}', models: { ${agent.budget}: '<model>' } }]`;
}

/** Why a delegation cannot go to `harness` — the dependency it does not satisfy — or null. */
export function harnessProblem(harness: string, rows: readonly HarnessRow[]): string | null {
  const row = rows.find(harnessRow => harnessRow.name === harness);
  if (!row) return `no harness is called \`${harness}\` — the harnesses installed: ${rows.map(harnessRow => harnessRow.name).join(', ')}`;
  if (!row.enabled) return `the harness \`${harness}\` is not enabled — add '${harness}' to \`adapters:\` in agent-pack.config.mjs`;
  if (!row.invocation) return row.problem ?? `${harness} cannot be delegated to`;
  if (!row.onPath && isPath(row.invocation.cli)) return `the harness \`${harness}\` runs \`${row.invocation.cli}\`, and no executable file is there — install it, fix its path, or delegate to another harness`;
  if (!row.onPath) return `the harness \`${harness}\` needs its CLI, \`${row.invocation.cli}\`, on the PATH — install it, or delegate to another harness`;
  return null;
}
