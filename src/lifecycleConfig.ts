// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Lifecycle-hook config loader.
 *
 * Lifecycle hooks (`ON-AGENT-PROMPTED`, `ON-TASK-COMPLETED`, …) are syntactic
 * sugar: each is an alias that desugars into a canonical module-level
 * `WHEN <phase text>` keyword and behaves exactly like one.
 *
 * The phase table lives in `config/lifecycles.json` — the single source of
 * truth, mirroring `force-levels.json`. New phases are added there with zero
 * code change: the lexer derives its keyword set from `getLifecycleAliases()`
 * and the desugar pass maps each alias to its canonical WHEN rest.
 *
 * `ON-INVOKE` is a lifecycle entry here too, so the legacy hardcoded alias is
 * gone — one table owns every phase.
 */

import LIFECYCLES_JSON from './config/lifecycles.json' with { type: 'json' };

interface Lifecycle {
  alias: string;   // ON-* keyword written in source
  when: string;    // canonical WHEN rest it expands to
}

interface Config { lifecycles: Lifecycle[]; }

const RAW: Config = LIFECYCLES_JSON as Config;

function validate(cfg: Config): void {
  const seen = new Set<string>();
  for (const l of cfg.lifecycles) {
    if (!l.alias || !/^ON-[A-Z][A-Z0-9-]*$/.test(l.alias)) {
      throw new Error(`lifecycles.json: invalid alias "${l.alias}" (must match ON-<UPPER>)`);
    }
    if (seen.has(l.alias)) throw new Error(`lifecycles.json: duplicate alias "${l.alias}"`);
    seen.add(l.alias);
    if (typeof l.when !== 'string' || l.when.length === 0) {
      throw new Error(`lifecycles.json: alias "${l.alias}" has empty when text`);
    }
  }
}
validate(RAW);

/** All lifecycle alias keywords (e.g. ['ON-INVOKE', 'ON-AGENT-PROMPTED', …]). */
export function getLifecycleAliases(): string[] {
  return RAW.lifecycles.map(l => l.alias);
}

/** Canonical WHEN rest for a lifecycle alias, or null when not a known alias. */
export function lifecycleToWhen(alias: string): string | null {
  return RAW.lifecycles.find(l => l.alias === alias)?.when ?? null;
}
