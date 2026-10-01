// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import FORCE_LEVELS_JSON from './config/force-levels.json' with { type: 'json' };

interface Family {
  name: string;
  levels: Record<string, string>;       // level (as string key) → intro
  aliases?: Record<string, number>;     // alias name → level (in this family)
}

interface Config { families: Family[]; }

// Load + validate at module init
const RAW: Config = FORCE_LEVELS_JSON as Config;

// Validation: throw on any drift
function validate(cfg: Config): void {
  const seenFamilyNames = new Set<string>();
  const seenAliasNames = new Set<string>();
  for (const f of cfg.families) {
    if (!f.name || !/^[A-Z][A-Z0-9-]*$/.test(f.name)) {
      throw new Error(`force-levels.json: invalid family name "${f.name}"`);
    }
    if (seenFamilyNames.has(f.name)) throw new Error(`force-levels.json: duplicate family "${f.name}"`);
    seenFamilyNames.add(f.name);

    const levels = Object.keys(f.levels);
    if (levels.length === 0) throw new Error(`force-levels.json: family "${f.name}" has no levels`);
    for (const k of levels) {
      const n = Number(k);
      if (!Number.isInteger(n)) throw new Error(`force-levels.json: family "${f.name}" has non-integer level "${k}"`);
      if (typeof f.levels[k] !== 'string' || f.levels[k].length === 0) {
        throw new Error(`force-levels.json: family "${f.name}" level ${k} has empty intro`);
      }
    }

    for (const [aliasName, aliasLevel] of Object.entries(f.aliases ?? {})) {
      if (!/^[A-Z][A-Z0-9-]*$/.test(aliasName)) throw new Error(`force-levels.json: invalid alias name "${aliasName}"`);
      if (seenAliasNames.has(aliasName)) throw new Error(`force-levels.json: duplicate alias "${aliasName}"`);
      if (seenFamilyNames.has(aliasName)) throw new Error(`force-levels.json: alias "${aliasName}" collides with a family name`);
      if (!(String(aliasLevel) in f.levels)) {
        throw new Error(`force-levels.json: alias "${aliasName}" points to level ${aliasLevel} not declared in family "${f.name}"`);
      }
      seenAliasNames.add(aliasName);
    }
  }
}
validate(RAW);

// Derivation
function deriveCanonical(family: string, level: number): string {
  if (level === 0) return family;
  if (level > 0)   return family + '!'.repeat(level);
  return '!'.repeat(-level) + family;
}

// Public API

/** The families as configured: name and level → phrase. */
export function forceLevelFamilies(): readonly { name: string; levels: Record<string, string> }[] {
  return RAW.families;
}

/** All family base names (e.g. ['MUST', 'ALWAYS', 'SHOULD', 'MAY']). */
export function getFamilyBases(): string[] {
  return RAW.families.map(f => f.name);
}

/** All alias names declared across all families (e.g. ['MUST-NOT', 'NON-NEGOTIABLE', 'NEVER']). */
export function getAliasNames(): string[] {
  return RAW.families.flatMap(f => Object.keys(f.aliases ?? {}));
}

/** Map an alias name to its canonical derived keyword. Throws if name is not a known alias. */
export function aliasToCanonical(name: string): string {
  for (const f of RAW.families) {
    if (f.aliases && name in f.aliases) {
      return deriveCanonical(f.name, f.aliases[name]);
    }
  }
  throw new Error(`aliasToCanonical: unknown alias "${name}"`);
}

/**
 * A force-level keyword in its canonical form: an alias (`NEVER`, `MUST-NOT`)
 * becomes its derived keyword (`!ALWAYS`, `!MUST`); any other keyword is
 * returned as is.
 */
export function toCanonicalKeyword(keyword: string): string {
  return getAliasNames().includes(keyword) ? aliasToCanonical(keyword) : keyword;
}

/**
 * All canonical force-level keywords for a specific family (e.g. 'ALWAYS').
 * Returns all derived forms (ALWAYS, !ALWAYS) for that family only.
 */
export function getCanonicalKeywordsForFamily(familyName: string): string[] {
  const family = RAW.families.find(f => f.name === familyName);
  if (!family) return [];
  return Object.keys(family.levels).map(k => deriveCanonical(familyName, Number(k)));
}

/**
 * All canonical force-level keywords (bases + derived forms for every level
 * declared), sorted by length descending (longer keywords match first in regex).
 */
export function getCanonicalKeywords(): string[] {
  const out: string[] = [];
  for (const f of RAW.families) {
    for (const k of Object.keys(f.levels)) {
      out.push(deriveCanonical(f.name, Number(k)));
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Return the family base name for a force-level keyword in any declension
 * (`AS`, `AS!`, `AS!!`, `!AS` → `AS`), or null when the keyword is not a
 * recognized force-level form. Lets consumers match a whole family by its
 * base without enumerating every `!`-declension.
 */
export function forceLevelBaseOf(keyword: string): string | null {
  const m = keyword.match(/^(!*)([A-Z][A-Z0-9]*)(!*)$/);
  if (!m) return null;
  const [, prefix, base, suffix] = m;
  if (prefix.length > 0 && suffix.length > 0) return null;
  return RAW.families.some(f => f.name === base) ? base : null;
}

/**
 * Parse a canonical force-level keyword (`MUST!!`, `!ALWAYS`, …) into its
 * family + numeric level, or null when it is not a force-level form. THE
 * single source of the declension grammar — `getIntroByKeyword` and the
 * DocumentBuilder both build on it.
 */
export function parseForceLevel(canonical: string): { family: string; level: number } | null {
  // Parse: <!*><base><!*> — but only one of prefix/suffix is allowed
  const m = canonical.match(/^(!*)([A-Z][A-Z0-9]*)(!*)$/);
  if (!m) return null;
  const [, prefix, base, suffix] = m;
  if (prefix.length > 0 && suffix.length > 0) return null;
  if (!RAW.families.some(f => f.name === base)) return null;
  return { family: base, level: prefix.length > 0 ? -prefix.length : suffix.length };
}

/**
 * Lookup the intro for a canonical keyword string. Returns null if the string
 * is not a recognized force-level or its level is not declared.
 */
export function getIntroByKeyword(canonical: string): string | null {
  const parsed = parseForceLevel(canonical);
  if (!parsed) return null;
  const family = RAW.families.find(f => f.name === parsed.family);
  return family?.levels[String(parsed.level)] ?? null;
}

/**
 * Regex source for the lexer's parametric force-level match.
 * Returns: "(!+)(MUST|ALWAYS|SHOULD|MAY)|(MUST|ALWAYS|SHOULD|MAY)(!*)"
 * Used inside KEYWORD_WITH_REST_RE alternation.
 */
export function buildForceLevelRegexSource(): string {
  const bases = getFamilyBases().map(escapeRegex).join('|');
  return `(!+)(${bases})|(${bases})(!*)`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
