// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The services of the apx, by kind — the one table the engine dispatches
 * through and the help lists. A served kind is an entry here.
 */
import { storeService } from './store.js';
import { dimensionService } from './dimension.js';
import { delegateService } from './delegate.js';
import { pluginService } from './plugin.js';
import type { ApxService } from '../service.js';
import type { ApDocument } from '../../apdoc/document.js';

export const APX_SERVICES: readonly ApxService[] = [storeService, dimensionService, delegateService];

/** The services an agent's apx answers with: the builtin ones, then one per plugin whose blocks it holds. */
export function servicesOf(doc: ApDocument): ApxService[] {
  return [...APX_SERVICES, ...Object.values(doc.meta.plugins ?? {}).map(pluginService)];
}

export function serviceOf(kind: string, doc: ApDocument): ApxService | null {
  return servicesOf(doc).find(s => s.kind === kind) ?? null;
}
