// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The affinity engine: matches a free text against opaque keys through a
 * prebuilt word table, with no model at call time. Its only entry point —
 * nothing outside this folder imports past it. Pure: no file, network, clock
 * or randomness at call time, and no npm package.
 */
export { type AffinityIndex, buildIndex, type Entry } from './build.js';
export { type Affinity, type Mark, type Match, type MatchOptions, openIndex } from './match.js';
