// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { FORMULAS } from './formulas.js';
/**
 * Sequence primitives — the fourth render family, alongside force-levels,
 * bullet-groups, and enums.
 *
 * A *sequence block* is a keyword whose consecutive siblings (or, for a
 * container, whose child blocks) form an ordered or unordered list, and whose
 * body is rendered recursively by the same tree renderer. STEP is the first
 * member; adding another sequential-recursive construct is one entry here, with
 * zero renderer changes — the same contract as adding a BY or a CONTEXT today.
 */
export interface SequencePrimitive {
  /** The block-opener keyword (e.g. `STEP`). */
  keyword: string;
  /** Plural header rendered above the list (e.g. `Steps` → `Steps:`). */
  header: string;
  /** true → numbered list (`1.`, `2.`, …); false → bulleted (`-`). */
  ordered: boolean;
}

export const SEQUENCE_PRIMITIVES: SequencePrimitive[] = [
  { keyword: 'STEP', header: FORMULAS.keywords.STEP.list, ordered: true },
];

export function sequencePrimitiveFor(keyword: string): SequencePrimitive | null {
  return SEQUENCE_PRIMITIVES.find(p => p.keyword === keyword) ?? null;
}
