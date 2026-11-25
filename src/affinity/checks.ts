// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The shape checks buildIndex and openIndex share on what they are handed.
 */
import { isPositive } from '../guards.js';

/** Whether a value is an array of strings. */
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Whether a value is a weight: a finite number above zero. */
export const isWeight = isPositive;

/** Whether a value is a weight or zero — a unit's weight, zero when every background text holds it. */
export function isWeightOrZero(value: unknown): value is number {
  return value === 0 || isPositive(value);
}
