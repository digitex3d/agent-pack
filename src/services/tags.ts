// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Single source of truth for all tag-related logic in agent-pack.
 *
 * Generic string-similarity helpers (Levenshtein, areSimilar, findSimilar) live
 * in `./text.ts` and are imported here for tag-conflict detection.
 *
 * Sections:
 *   1. Types
 *   2. Constants
 *   3. Pure utilities — parsing & normalisation
 *   4. Composable — stateful registry
 *   5. Exports
 */

import { findSimilar } from './text.js';
import { splitList } from '../lists.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface LibraryIndexError {
  /** Absolute path of the offending module file. */
  file: string;
  message: string;
  /** Always 'error' for Stage A — kept as field for future warnings. */
  severity: 'error';
}

interface TagRegistrationResult {
  ok: boolean;
}

interface TagRegistrySnapshot {
  byTag: Record<string, string[]>;
  errors: LibraryIndexError[];
}

/**
 * Node of the FCA-derived tag hierarchy. Each node represents a concept
 * (a set of tags with identical module support); `tag` is the canonical
 * label, `aliases` carry the other tags that share the same module set.
 */
export interface TagNode {
  tag: string;
  aliases: string[];
  members: string[];
  children: TagNode[];
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * The canonical tag regex.
 *
 * Matches a classic flat hashtag: `#` + a slug that starts with an
 * alphanumeric character and contains only alphanumeric characters and hyphens.
 *
 * This is the same rule enforced by the lint validator and produced by every
 * tag-emitting code path (derive, normalize, render).
 */
const TAG_RE = /^#[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/**
 * A perimeter token of an `APPLIES` line — where a policy or a skill holds
 * with no `WITH` naming it: `universal`, `team:<team>` or `agent:<agent>`.
 */
const PERIMETER_RE = /^(?:universal|(?:team|agent):[a-z0-9][a-z0-9-]*)$/;

/** The perimeter forms, as every message names them. */
const PERIMETER_FORMS = 'universal, team:<team> or agent:<agent>';

/** The blocks whose APPLIES line may carry a perimeter — where they hold with no WITH naming them. */
const PERIMETER_KINDS: readonly string[] = ['policy', 'skill'];

/** The blocks that hold only where something names them: a perimeter on their APPLIES line, or a WITH — a dimension, which has no APPLIES line, by a WITH alone. */
const SCOPED_KINDS: readonly string[] = [...PERIMETER_KINDS, 'dimension'];

/** The tag that makes a template a judge rule (src/judge/rules.ts). */
export const JUDGE_TAG = '#judge';

/**
 * The scopes a judge rule may take, each its own tag (`#executed`, …): the
 * lines a delegate or a program carries out, only a program's, only the agent's.
 */
export const JUDGE_SCOPES = ['executed', 'program', 'agent'] as const;

/**
 * The tags the language itself reads — a judge rule and its scope. An author
 * does not coin them, so they never conflict with a similar tag: `#agent` and
 * `#agent-pack` both stand.
 */
export const LANGUAGE_TAGS: ReadonlySet<string> = new Set([JUDGE_TAG, ...JUDGE_SCOPES.map(scope => `#${scope}`)]);

// ────────────────────────────────────────────────────────────────────────────
// Pure utilities — parsing & normalisation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert an arbitrary raw string into a TAG_RE-valid slug.
 *
 * Transformation rules (applied in order):
 *   1. Lowercase the string.
 *   2. Replace underscores and whitespace runs with hyphens.
 *   3. Strip any character that is not [a-z0-9-].
 *   4. Collapse consecutive hyphens into one.
 *   5. Trim leading/trailing hyphens.
 *   6. Prepend `#` if not already present.
 *
 * Returns null when the input produces an empty slug after transformation
 * (e.g. a string that is entirely punctuation).
 */
function normalizeTag(raw: string): string | null {
  let slug = raw.startsWith('#') ? raw.slice(1) : raw;
  slug = slug.toLowerCase();
  slug = slug.replace(/[_\s]+/g, '-');
  slug = slug.replace(/[^a-z0-9-]/g, '');
  slug = slug.replace(/-+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  if (slug === '' || !/^[a-z0-9]/.test(slug)) return null;
  return `#${slug}`;
}

/**
 * Read the payloads of a block's APPLIES lines — the one reader of the line:
 * comma-separated tokens, each a `#tag` or a perimeter (`PERIMETER_RE`);
 * anything else is `invalid` — the lint's to report, never guessed at.
 */
function parseApplies(payloads: readonly string[]): { tags: string[]; scopes: string[]; invalid: string[] } {
  const tags: string[] = [];
  const scopes: string[] = [];
  const invalid: string[] = [];
  for (const tok of payloads.flatMap(payload => splitList(payload))) {
    if (TAG_RE.test(tok)) { if (!tags.includes(tok)) tags.push(tok); }
    else if (PERIMETER_RE.test(tok)) { if (!scopes.includes(tok)) scopes.push(tok); }
    else invalid.push(tok);
  }
  return { tags, scopes, invalid };
}

/** A perimeter token's parts: `team:delivery` → `{ kind: 'team', name: 'delivery' }`. */
function perimeterOf(token: string): { kind: 'universal' | 'team' | 'agent'; name: string } {
  const [kind, name = ''] = token.split(':');
  return { kind: kind as 'universal' | 'team' | 'agent', name };
}

/**
 * Render a sorted list of tags as the payload of an `APPLIES` line.
 *
 * Output: `APPLIES #coding, #typescript` (comma-separated, sorted — src/lists.ts).
 * When the list is empty, returns an empty string so callers can skip the line.
 */
function renderTagsLine(tags: string[]): string {
  if (tags.length === 0) return '';
  const sorted = [...tags].sort();
  return `APPLIES ${sorted.join(', ')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure utilities — FCA-derived hierarchy
// ────────────────────────────────────────────────────────────────────────────

function setKey(modules: ReadonlySet<string>): string {
  return [...modules].sort().join('\0');
}

function isStrictSuperset(superset: ReadonlySet<string>, subset: ReadonlySet<string>): boolean {
  if (superset.size <= subset.size) return false;
  for (const member of subset) if (!superset.has(member)) return false;
  return true;
}

interface Concept {
  tag: string;
  aliases: string[];
  modules: Set<string>;
}

function pickCanonicalTag(tags: string[]): { tag: string; aliases: string[] } {
  const sorted = [...tags].sort((left, right) => {
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  });
  return { tag: sorted[0], aliases: sorted.slice(1) };
}

function mergeIntoConcepts(byTag: ReadonlyMap<string, ReadonlySet<string>>): Concept[] {
  const groups = new Map<string, string[]>();
  for (const tag of byTag.keys()) {
    const key = setKey(byTag.get(tag)!);
    const list = groups.get(key) ?? [];
    list.push(tag);
    groups.set(key, list);
  }
  const concepts: Concept[] = [];
  for (const [, tagsInGroup] of groups) {
    const { tag, aliases } = pickCanonicalTag(tagsInGroup);
    concepts.push({ tag, aliases, modules: new Set(byTag.get(tag)!) });
  }
  return concepts;
}

function pickPrimaryParent(parents: Concept[]): Concept {
  const sorted = [...parents].sort((left, right) => {
    if (left.modules.size !== right.modules.size) return left.modules.size - right.modules.size;
    return left.tag.localeCompare(right.tag);
  });
  return sorted[0];
}

function sortNodes(nodes: TagNode[]): TagNode[] {
  return [...nodes].sort((left, right) => {
    if (left.members.length !== right.members.length) return right.members.length - left.members.length;
    return left.tag.localeCompare(right.tag);
  });
}

/**
 * Build a forest of TagNode from a `tag → modules` map using
 * FCA-style subset implication:
 *
 *   1. Concepts with identical module sets are merged (canonical + aliases).
 *   2. Concept A subsumes concept B iff modules(A) ⊋ modules(B).
 *   3. A is a direct (cover) parent of B iff there is no C with A ⊃ C ⊃ B.
 *   4. When B has multiple direct parents, the one with the smallest module
 *      set wins (tie-break: alphabetical) — reduces the DAG to a forest.
 *   5. Roots and children are ordered by descending member count, then alpha.
 */
export function buildHierarchy(byTag: ReadonlyMap<string, ReadonlySet<string>>): TagNode[] {
  const concepts = mergeIntoConcepts(byTag);
  if (concepts.length === 0) return [];

  const directParents = new Map<Concept, Concept[]>();
  for (const concept of concepts) {
    const strictSupers = concepts.filter(candidate => candidate !== concept && isStrictSuperset(candidate.modules, concept.modules));
    const direct = strictSupers.filter(parent =>
      !strictSupers.some(between => between !== parent && isStrictSuperset(parent.modules, between.modules) && isStrictSuperset(between.modules, concept.modules)),
    );
    directParents.set(concept, direct);
  }

  const nodeOf = new Map<Concept, TagNode>();
  for (const concept of concepts) {
    nodeOf.set(concept, { tag: concept.tag, aliases: concept.aliases, members: [...concept.modules], children: [] });
  }

  const roots: TagNode[] = [];
  for (const concept of concepts) {
    const parents = directParents.get(concept)!;
    if (parents.length === 0) {
      roots.push(nodeOf.get(concept)!);
      continue;
    }
    const primary = pickPrimaryParent(parents);
    nodeOf.get(primary)!.children.push(nodeOf.get(concept)!);
  }

  for (const node of nodeOf.values()) node.children = sortNodes(node.children);
  return sortNodes(roots);
}

// ────────────────────────────────────────────────────────────────────────────
// Composable — stateful registry
// ────────────────────────────────────────────────────────────────────────────

/**
 * Factory that creates an isolated, stateful tag registry.
 *
 * Usage pattern:
 *   const tags = useTagRegistry();
 *   tags.register(key, file, parsedTags);
 *   const { byTag, errors } = tags.snapshot();
 *
 * `byTag` and `errors` are private to the closure; consumers read them only
 * via `snapshot()`, which returns a deep copy — mutations after the call do
 * not retroactively change a previously obtained snapshot.
 */
function useTagRegistry() {
  const byTag = new Map<string, string[]>();
  const errors: LibraryIndexError[] = [];

  /**
   * Attempt to register `tags` under `moduleKey`.
   *
   * Transactional: if any tag fails the similarity check, no tag from this
   * module is registered (early-return before mutating `byTag`).
   *
   * Returns { ok: false } when:
   *   - tags is empty ("module has no tag")
   *   - any tag is too similar to an already-registered tag (a language tag never is)
   */
  function register(moduleKey: string, file: string, tags: string[]): TagRegistrationResult {
    if (tags.length === 0) {
      errors.push({
        file,
        severity: 'error',
        message: 'module has no tag — its APPLIES line must declare ≥ 1 #tag',
      });
      return { ok: false };
    }

    // Similarity check — must pass ALL tags before mutating state (transactional).
    for (const tag of tags) {
      // Tags already in the registry are safe (same tag shared by multiple modules).
      if (byTag.has(tag) || LANGUAGE_TAGS.has(tag)) continue;
      const conflict = findSimilar(tag, [...byTag.keys()].filter(knownTag => !LANGUAGE_TAGS.has(knownTag)));
      if (conflict !== null) {
        errors.push({
          file,
          severity: 'error',
          message: `tag "${tag}" is too similar to existing "${conflict}". Pick one and rename.`,
        });
        return { ok: false };
      }
    }

    // All tags passed — commit to registry.
    for (const tag of tags) {
      const existing = byTag.get(tag);
      if (existing) {
        existing.push(moduleKey);
      } else {
        byTag.set(tag, [moduleKey]);
      }
    }

    return { ok: true };
  }

  /**
   * Build the FCA-derived hierarchy from the current `byTag` snapshot.
   */
  function hierarchy(): TagNode[] {
    const view = new Map<string, Set<string>>();
    for (const [tag, modules] of byTag) view.set(tag, new Set(modules));
    return buildHierarchy(view);
  }

  /**
   * Return an immutable snapshot of the current registry state.
   *
   * Deep-copies both `byTag` entries and `errors` so that subsequent
   * `register()` calls do not mutate a snapshot already obtained.
   */
  function snapshot(): TagRegistrySnapshot {
    return {
      byTag: Object.fromEntries(Array.from(byTag, ([tag, moduleKeys]) => [tag, [...moduleKeys]])),
      errors: [...errors],
    };
  }

  return { register, hierarchy, snapshot };
}

// ────────────────────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────────────────────

export {
  // types
  type LibraryIndexError,
  type TagRegistrationResult,
  type TagRegistrySnapshot,
  // constants
  TAG_RE,
  PERIMETER_RE,
  PERIMETER_FORMS,
  PERIMETER_KINDS,
  SCOPED_KINDS,
  // parse & normalise
  normalizeTag,
  parseApplies,
  perimeterOf,
  renderTagsLine,
  // composable
  useTagRegistry,
};
// TagNode and buildHierarchy are already exported inline at their declarations.
