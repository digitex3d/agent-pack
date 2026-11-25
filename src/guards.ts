// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Type guards on values of unknown shape: the one place each is written.
 * No imports: the apx engine bundles this module.
 */

/** Whether a value is a plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a finite number — not NaN, not an infinity. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a finite number above zero. */
export function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** Whether a value is a count: a whole number ≥ 1 — its words: `FORMULAS.messages.numbers.count`. */
export function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}
