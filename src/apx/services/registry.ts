// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The services of the apx, by kind — the one table the engine dispatches
 * through and the help lists. A served kind is an entry here.
 */
import { storeService } from './store.js';
import { dimensionService } from './dimension.js';
import { askService } from './ask.js';
import type { ApxService } from '../service.js';

export const APX_SERVICES: readonly ApxService[] = [storeService, dimensionService, askService];

export function serviceOf(kind: string): ApxService | null {
  return APX_SERVICES.find(s => s.kind === kind) ?? null;
}
