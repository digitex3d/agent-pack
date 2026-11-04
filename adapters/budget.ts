// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `BUDGET <tier>` as a model of a harness: each adapter maps the tiers of the
 * language (`cheap`, `moderate`, `costly`) to models of its own harness — its
 * built-in mapping, or the one a project config gives it
 * (`adapters: [{ name: 'opencode', models: { cheap: '…' } }]`). The source
 * never names a model; a tier the adapter maps to none runs on the harness's
 * own default.
 */
import type { AgentBundle } from './types.js';
import type { AgentBlock } from '../src/apdoc/blocks.js';
import { enumPrimitiveFor } from '../src/primitives.js';

/** The model of each `BUDGET` tier, on one harness — a tier left out has none. */
export type BudgetModels = Partial<Record<string, string>>;

/** The tiers of `BUDGET`, as the language declares them. */
export function budgetTiers(): string[] {
  return Object.keys(enumPrimitiveFor('BUDGET')?.values ?? {});
}

/** The `BUDGET` tier an agent declares — null when it declares none. */
export function budgetOf(b: AgentBundle): string | null {
  return (b.structure?.root() as AgentBlock | null | undefined)?.budget ?? null;
}

/** The model a tier maps to on a harness — null when there is no tier, or the harness maps it to none. */
export function modelOfTier(models: BudgetModels | undefined, tier: string | null | undefined): string | null {
  return (tier && models?.[tier]) || null;
}

/** The model an agent's tier maps to on a harness — null when it declares no tier, or the harness maps it to none. */
export function budgetModel(models: BudgetModels | undefined, b: AgentBundle): string | null {
  return modelOfTier(models, budgetOf(b));
}

/**
 * A config's `models` for one adapter, checked: an object from tiers to model
 * ids. Throws, naming the adapter, on anything else.
 */
export function checkBudgetModels(adapter: string, raw: unknown): BudgetModels {
  const tiers = budgetTiers();
  const example = `{ name: '${adapter}', models: { ${tiers.map(t => `${t}: '<model>'`).join(', ')} } }`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`adapters: ${adapter}'s models map each BUDGET tier to a model of its harness — ${example}`);
  for (const [tier, model] of Object.entries(raw as Record<string, unknown>)) {
    if (!tiers.includes(tier)) throw new Error(`adapters: ${adapter}'s models: \`${tier}\` is no BUDGET tier — the tiers: ${tiers.join(', ')}`);
    if (typeof model !== 'string' || model.trim() === '') throw new Error(`adapters: ${adapter}'s models.${tier} must be a model id of its harness, e.g. ${example}`);
  }
  return raw as BudgetModels;
}
