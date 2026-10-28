// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where a policy, a skill or a dimension holds: its APPLIES perimeter
 * (`universal`, `team:<team>`, `agent:<agent>`), or only where a decorator
 * names it — `@WITH pdf` (src/decorators.ts). A scoped block that holds
 * nowhere is an error for a policy or a skill, a warning for a dimension.
 */
import { FORMULAS, fill } from './formulas.js';
import { PERIMETER_FORMS, PERIMETER_KINDS, SCOPED_KINDS, perimeterOf } from './services/tags.js';
import type { Definition } from './definition.js';

/**
 * The scoped blocks that hold nowhere: imported, with no perimeter on their
 * APPLIES line, and named by no decorator — an error for a policy or a
 * skill, so a rule never sits silently unused; a warning for a dimension,
 * which the apx serves all the same.
 */
export function unappliedBlocks(blocks: Definition[], named: ReadonlySet<string>): Definition[] {
  return blocks.filter(b => SCOPED_KINDS.includes(b.kind) && b.scopes.length === 0 && !named.has(b.name));
}

/** What an unapplied block is told, and how loud: a policy or a skill an error; a dimension — no perimeter to give, served all the same — a warning. */
export function unappliedIssue(block: { kind: string; name: string }): { message: string; severity?: 'warning' } {
  const perimeter = PERIMETER_KINDS.includes(block.kind);
  const or = perimeter ? ` where it applies, or give its APPLIES line ${PERIMETER_FORMS}` : ' above the lines that read it';
  return { message: `${block.kind} \`${block.name}\` applies nowhere — name it with \`@WITH ${block.name}\`${or}`, ...(perimeter ? {} : { severity: 'warning' as const }) };
}

/** The line that says where a policy, a skill or a dimension applies — its perimeter, or only where `@WITH` names it. */
export function scopeLine(scopes: readonly string[]): string {
  const S = FORMULAS.keywords.APPLIES.scope;
  if (scopes.length === 0) return S.with;
  return scopes.map(token => {
    const { kind, name } = perimeterOf(token);
    return fill(S[kind], { name });
  }).join(' ');
}

/** A block's body opened by its scope line, when its kind is scoped (a policy, a skill, a dimension) — else the body as it is. */
export function withScopeLine(kind: string, scopes: readonly string[], body: string): string {
  return SCOPED_KINDS.includes(kind) ? `${scopeLine(scopes)}\n${body}` : body;
}

/** The short scope of a scoped block in a listing: its perimeter tokens, or that only `@WITH` brings it. */
export function scopeLabel(scopes: readonly string[]): string {
  return scopes.length ? scopes.join(' ') : FORMULAS.keywords.APPLIES.scope.ls;
}
