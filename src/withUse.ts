// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `WITH` — the one place its meaning is written down.
 *
 *   WITH pdf, #policy:decisions:   the lines nested below are under the skill `pdf`
 *       …                          and every policy whose APPLIES line has #decisions
 *   WITH pdf-report AS report:     one skill, its answer shaped as a template
 *   !WITH security, #skill:ocr:    the lines nested below are out of them
 *
 * A name, or a tag with its kind (`#policy:<tag>`, `#skill:<tag>`), resolves
 * among the skills and policies the compilation imports — a tag is expanded
 * here, at compile time, into the names it selects. A policy or a skill holds
 * only where a WITH names it, unless its APPLIES line gives it a perimeter of
 * its own: `universal`, `team:<team>`, `agent:<agent>`.
 *
 * Both renderers (the document's and the standalone one) read a WITH head
 * through `readWithHead`; they differ only in how they print an id.
 */
import { isWithHead, type Token } from './lexer.js';
import { parseForceLevel } from './forceLevelConfig.js';
import { FORMULAS, fill } from './formulas.js';
import { PERIMETER_FORMS, SCOPED_KINDS, perimeterOf } from './services/tags.js';
import type { Definition } from './definition.js';

/** What a WITH can name — the compilation's imported skills and policies — and the templates an AS may shape with. */
export interface WithScope {
  skills: Definition[];
  policies: Definition[];
  templates: Definition[];
}

/** A tag item of a WITH head: `#policy:<tag>` / `#skill:<tag>` — the kind it selects, and the tag. */
const KIND_TAG_RE = /^#(policy|skill):([a-zA-Z0-9][a-zA-Z0-9-]*)$/;

/**
 * A `WITH` head's rest, its block colon dropped: names and kind tags, comma
 * separated, then an optional `AS <template>` — null when it is none of these.
 */
export function splitWith(text: string): { items: string[]; template: string | null } | null {
  const m = text.trim().replace(/\s*:$/, '').match(/^(.+?)(?:\s+AS\s+(\S+))?$/);
  if (!m) return null;
  const items = m[1].split(',').map(s => s.trim());
  return items.every(s => /^#?[\w:-]+$/.test(s)) ? { items, template: m[2] ?? null } : null;
}

/** What is wrong with a WITH item's form, before anything resolves — null when it is well formed. */
export function withItemError(item: string): string | null {
  return item.startsWith('#') && !KIND_TAG_RE.test(item)
    ? `\`${item}\`: a tag in a WITH says which kind it selects — \`#policy:<tag>\` or \`#skill:<tag>\``
    : null;
}

/** Something a WITH head names that does not hold: an unknown name, tag or template, or an AS on no skill. */
export interface WithProblem {
  /** `with` (an item), `template` (its AS) — named by the compiler's unresolved message — or `as`, worded here. */
  kind: 'with' | 'template' | 'as';
  name: string;
  message?: string;
}

/** A WITH head read: whether it negates, the blocks it names (once each, in order), its AS, and what does not hold. */
export interface WithHead {
  negated: boolean;
  uses: Definition[];
  template: string | null;
  problems: WithProblem[];
}

/** Read a WITH head token against what the compilation imports — null for any other token. */
export function readWithHead(t: Token, scope: WithScope): WithHead | null {
  if (!isWithHead(t) || t.kind !== 'keyword') return null;
  const use = splitWith(t.rest);
  if (!use) return null;
  const negated = (parseForceLevel(t.keyword as string)?.level ?? 0) < 0;
  const uses: Definition[] = [];
  const problems: WithProblem[] = [];
  for (const item of use.items) {
    const tag = KIND_TAG_RE.exec(item);
    const found = tag
      ? (tag[1] === 'policy' ? scope.policies : scope.skills).filter(d => d.tags.includes(`#${tag[2]}`))
      : item.startsWith('#') ? [] : [...scope.skills, ...scope.policies].filter(d => d.name === item);
    if (found.length === 0 && !withItemError(item)) problems.push({ kind: 'with', name: item });
    for (const d of found) if (!uses.includes(d)) uses.push(d);
  }
  if (use.template) {
    if (!scope.templates.some(d => d.name === use.template)) problems.push({ kind: 'template', name: use.template });
    if (!negated && !(uses.length === 1 && uses[0].kind === 'skill')) {
      problems.push({ kind: 'as', name: use.template, message: `\`AS ${use.template}\` shapes the answer of one skill — this WITH names ${uses.length === 1 ? `the ${uses[0].kind} \`${uses[0].name}\`` : `${uses.length} blocks`}` });
    }
  }
  return { negated, uses, template: use.template, problems };
}

/** What an unresolved WITH item is told. */
export function unknownWithMessage(item: string): string {
  const tag = KIND_TAG_RE.exec(item);
  return tag
    ? `\`WITH ${item}\`: no imported ${tag[1]} has #${tag[2]} on its APPLIES line`
    : `unknown skill or policy \`${item}\` — IMPORT it FROM @main.skills or @main.policies, or FROM @harness.skills`;
}

/** The phrase a WITH head renders: each block it names with its id, joined — the force intro is the renderer's. */
export function withPhrase(uses: { kind: string; name: string; ref: string }[], shape?: { name: string; ref: string }): string {
  const W = FORMULAS.keywords.WITH;
  const named = uses.map(u => fill(u.kind === 'policy' ? W.policy : W.skill, { name: u.name, ref: u.ref }));
  const text = named.length > 1 ? `${named.slice(0, -1).join(', ')}${W.and}${named[named.length - 1]}` : named[0] ?? '';
  return shape ? fill(FORMULAS.keywords.AS.shaped, { text, name: shape.name, ref: shape.ref }) : text;
}

/**
 * The scoped blocks that hold nowhere: imported, with no perimeter on their
 * APPLIES line, and named by no positive WITH — each a compile error, so a
 * rule or a skill never sits silently unused.
 */
export function unappliedBlocks(blocks: Definition[], named: ReadonlySet<string>): Definition[] {
  return blocks.filter(b => SCOPED_KINDS.includes(b.kind) && b.scopes.length === 0 && !named.has(b.name));
}

/** What an unapplied policy or skill is told. */
export function unappliedMessage(block: { kind: string; name: string }): string {
  return `${block.kind} \`${block.name}\` applies nowhere — name it in a \`WITH ${block.name}:\` block, or give its APPLIES line ${PERIMETER_FORMS}`;
}

/** The line that says where a policy or a skill applies — its perimeter, or only under a WITH that names it. */
export function scopeLine(scopes: readonly string[]): string {
  const S = FORMULAS.keywords.APPLIES.scope;
  if (scopes.length === 0) return S.with;
  return scopes.map(token => {
    const { kind, name } = perimeterOf(token);
    return fill(S[kind], { name });
  }).join(' ');
}

/** A block's body opened by its scope line, when its kind is scoped (a policy, a skill) — else the body as it is. */
export function withScopeLine(kind: string, scopes: readonly string[], body: string): string {
  return SCOPED_KINDS.includes(kind) ? `${scopeLine(scopes)}\n${body}` : body;
}

/** The short scope of a scoped block in a listing: its perimeter tokens, or that only a WITH brings it. */
export function scopeLabel(scopes: readonly string[]): string {
  return scopes.length ? scopes.join(' ') : FORMULAS.keywords.APPLIES.scope.ls;
}

/**
 * Every WITH head of these sources, read without a document builder (the
 * standalone renderer): the names the positive ones select, and what does not
 * hold — each with the file it was written in.
 */
export function scanWith(sources: { path: string; tokens: Token[] }[], scope: WithScope): { named: Set<string>; problems: (WithProblem & { path: string })[] } {
  const named = new Set<string>();
  const problems: (WithProblem & { path: string })[] = [];
  for (const { path, tokens } of sources) {
    for (const t of tokens) {
      const head = readWithHead(t, scope);
      if (!head) continue;
      problems.push(...head.problems.map(p => ({ ...p, path })));
      if (!head.negated) for (const d of head.uses) named.add(d.name);
    }
  }
  return { named, problems };
}
