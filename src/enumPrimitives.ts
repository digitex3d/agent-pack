// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { ENUM_PRIMITIVES, EnumPrimitive, enumPrimitiveFor } from './primitives.js';
import type { BundleContext } from './dispatch/types.js';

/**
 * Rewrite `KEYWORD <arg>` lines for every registered EnumPrimitive.
 * Preserves leading indentation. Unknown args produce a lint warning and
 * leave the line untouched.
 *
 * Matches at line start (with optional indent) only — not mid-line — to
 * avoid clobbering prose that happens to mention the keyword.
 */
export function applyEnumPrimitives(text: string, ctx?: BundleContext): string {
  let out = text;
  for (const prim of ENUM_PRIMITIVES) {
    out = rewriteOne(out, prim, ctx);
  }
  return out;
}

/**
 * Validate one enum value; on an unknown value push the ONE canonical lint
 * warning (shared by the md rewrite pass and the DocumentBuilder) and return
 * false.
 */
export function validateEnumValue(prim: EnumPrimitive, value: string, ctx?: BundleContext): boolean {
  if (prim.values[value]) return true;
  ctx?.lintErrors.push({
    file: '<body>',
    line: 0,
    message: `${prim.keyword}: unknown value "${value}" (allowed: ${Object.keys(prim.values).join(', ')})`,
    severity: 'warning',
  });
  return false;
}

function rewriteOne(text: string, prim: EnumPrimitive, ctx?: BundleContext): string {
  const re = new RegExp(`^(\\s*)${prim.keyword}\\s+(\\S+)\\s*$`, 'gm');
  return text.replace(re, (match, indent: string, arg: string) => {
    if (!validateEnumValue(prim, arg, ctx)) return match;
    return `${indent}${renderEnumValue(prim, arg, ctx)}`;
  });
}

/**
 * Render one enum value: the active adapter's harness-native string when it
 * declares one (BundleContext.renderings), the neutral prose otherwise.
 * Adapters may only override values the core declares — an adapter-only value
 * never validates, so the allowed set stays a single source of truth.
 */
function renderEnumValue(prim: EnumPrimitive, arg: string, ctx?: BundleContext): string {
  return ctx?.renderings?.[prim.keyword]?.[arg] ?? prim.values[arg]();
}

/**
 * Chapter legend for an enum's modes: `legendIntro` followed by one bullet per
 * value, each rendered through the same adapter-override lookup as the line
 * rewrite. Consumed by chapters whose strategy declares `legendEnum` (the flow
 * chapter explains CONTEXT this way). Returns '' for an unknown keyword.
 */
export function renderEnumLegend(keyword: string, ctx?: BundleContext): string {
  const prim = enumPrimitiveFor(keyword);
  if (!prim) return '';
  const intro = prim.legendIntro ?? `${prim.keyword} modes:`;
  const rows = Object.keys(prim.values).map(
    v => `- \`${v}\` — ${renderEnumValue(prim, v, ctx)}`,
  );
  return [intro, ...rows].join('\n');
}
