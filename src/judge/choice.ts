// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * How a choice the judge answers is decided — the one rule the compiler (a
 * file's domain at build time) and the apx (a new file's at dispatch) share:
 * the top option wins when it reaches the threshold and leads the runner-up by
 * the margin; otherwise the choice is nobody's but the developer's (grey).
 * No imports: the apx engine bundles this module.
 */

export type Choice =
  | { choice: string; p: number }
  | { grey: [string, string]; p: [number, number] };

/** The options of a distribution, most probable first. */
export function rankedOptions(distribution: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(distribution).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Decide a distribution over options — see the module comment. An empty distribution is grey between nothing. */
export function decideChoice(distribution: Readonly<Record<string, number>>, threshold: number, margin: number): Choice {
  const ranked = rankedOptions(distribution);
  const [top, second] = [ranked[0] ?? ['', 0], ranked[1] ?? ['', 0]];
  if (ranked.length > 0 && top[1] >= threshold && top[1] - second[1] >= margin) return { choice: top[0], p: top[1] };
  return { grey: [top[0], second[0]], p: [top[1], second[1]] };
}
