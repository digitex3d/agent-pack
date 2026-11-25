// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import FORCE_LEVELS_JSON from './config/force-levels.json' with { type: 'json' };
import { FORMULAS, fill } from './formulas.js';
import { isCount } from './guards.js';

interface Family {
  name: string;
  levels: Record<string, string>;       // level (as string key) → intro
  aliases?: Record<string, number>;     // alias name → level (in this family)
  costs?: Record<string, number>;       // level (as string key) → what forgetting such a line costs
}

interface Config { families: Family[]; noRuleCost: number; }

// Load + validate at module init
const RAW: Config = FORCE_LEVELS_JSON as Config;

/**
 * The families whose lines are no rule — a shape (`AS`), a memory (`MEM`): those
 * force-levels.json gives no costs. Every other family's line is a rule of the
 * block it is in.
 */
const NON_RULE_FAMILIES: readonly string[] = RAW.families.filter(family => family.costs === undefined).map(family => family.name);

/** A rule family — one with costs — has a cost for each of its levels, and only for them. */
function validateCosts(family: Family): void {
  const SAY = FORMULAS.messages.forceLevels;
  const costs = family.costs;
  if (costs === undefined) return;
  for (const level of Object.keys(family.levels)) {
    if (!isCount(costs[level])) throw new Error(fill(SAY.needsCost, { family: family.name, level, rule: FORMULAS.messages.numbers.count }));
  }
  for (const level of Object.keys(costs)) {
    if (!(level in family.levels)) throw new Error(fill(SAY.undeclaredCost, { family: family.name, level }));
  }
}

// Validation: throw on any drift
function validate(cfg: Config): void {
  const seenFamilyNames = new Set<string>();
  const seenAliasNames = new Set<string>();
  for (const family of cfg.families) {
    if (!family.name || !/^[A-Z][A-Z0-9-]*$/.test(family.name)) {
      throw new Error(`force-levels.json: invalid family name "${family.name}"`);
    }
    if (seenFamilyNames.has(family.name)) throw new Error(`force-levels.json: duplicate family "${family.name}"`);
    seenFamilyNames.add(family.name);

    const levels = Object.keys(family.levels);
    if (levels.length === 0) throw new Error(`force-levels.json: family "${family.name}" has no levels`);
    for (const levelKey of levels) {
      const levelNumber = Number(levelKey);
      if (!Number.isInteger(levelNumber)) throw new Error(`force-levels.json: family "${family.name}" has non-integer level "${levelKey}"`);
      if (typeof family.levels[levelKey] !== 'string' || family.levels[levelKey].length === 0) {
        throw new Error(`force-levels.json: family "${family.name}" level ${levelKey} has empty intro`);
      }
    }

    for (const [aliasName, aliasLevel] of Object.entries(family.aliases ?? {})) {
      if (!/^[A-Z][A-Z0-9-]*$/.test(aliasName)) throw new Error(`force-levels.json: invalid alias name "${aliasName}"`);
      if (seenAliasNames.has(aliasName)) throw new Error(`force-levels.json: duplicate alias "${aliasName}"`);
      if (seenFamilyNames.has(aliasName)) throw new Error(`force-levels.json: alias "${aliasName}" collides with a family name`);
      if (!(String(aliasLevel) in family.levels)) {
        throw new Error(`force-levels.json: alias "${aliasName}" points to level ${aliasLevel} not declared in family "${family.name}"`);
      }
      seenAliasNames.add(aliasName);
    }
    validateCosts(family);
  }
}
validate(RAW);
if (!isCount(RAW.noRuleCost)) throw new Error(fill(FORMULAS.messages.forceLevels.noRuleCost, { rule: FORMULAS.messages.numbers.count }));

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

/**
 * What forgetting a line of `family` at `level` costs — null when the family's
 * lines are no rule (`AS`, `MEM`) or the level is not declared.
 */
export function ruleCost(family: string, level: number): number | null {
  return RAW.families.find(candidate => candidate.name === family)?.costs?.[String(level)] ?? null;
}

/** Whether a keyword, in any declension or alias (`MUST!`, `NEVER`), opens a rule line — never a shape (`AS`) or a memory (`MEM`). */
export function isRuleKeyword(keyword: string): boolean {
  const family = forceLevelBaseOf(toCanonicalKeyword(keyword));
  return family !== null && !NON_RULE_FAMILIES.includes(family);
}

/** The cost of a block, or a trigger, that holds no rule line. */
export const NO_RULE_COST: number = RAW.noRuleCost;

/** All family base names (e.g. ['MUST', 'ALWAYS', 'SHOULD', 'MAY']). */
export function getFamilyBases(): string[] {
  return RAW.families.map(family => family.name);
}

/** All alias names declared across all families (e.g. ['MUST-NOT', 'NON-NEGOTIABLE', 'NEVER']). */
export function getAliasNames(): string[] {
  return RAW.families.flatMap(family => Object.keys(family.aliases ?? {}));
}

/** Map an alias name to its canonical derived keyword. Throws if name is not a known alias. */
export function aliasToCanonical(name: string): string {
  for (const family of RAW.families) {
    if (family.aliases && name in family.aliases) {
      return deriveCanonical(family.name, family.aliases[name]);
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
 * A level of a family as an author writes it: a negative one by its alias when it has one
 * (`ALWAYS` at -1 → `NEVER`), else its derived keyword (`MUST!`). Not a family: the word itself.
 */
export function writtenKeyword(family: string, level: number): string {
  const familyEntry = RAW.families.find(candidate => candidate.name === family);
  if (!familyEntry) return family;
  const alias = level < 0 ? Object.entries(familyEntry.aliases ?? {}).find(([, aliasLevel]) => aliasLevel === level)?.[0] : undefined;
  return alias ?? deriveCanonical(family, level);
}

/**
 * All canonical force-level keywords for a specific family (e.g. 'ALWAYS').
 * Returns all derived forms (ALWAYS, !ALWAYS) for that family only.
 */
export function getCanonicalKeywordsForFamily(familyName: string): string[] {
  const family = RAW.families.find(candidate => candidate.name === familyName);
  if (!family) return [];
  return Object.keys(family.levels).map(levelKey => deriveCanonical(familyName, Number(levelKey)));
}

/**
 * All canonical force-level keywords (bases + derived forms for every level
 * declared), sorted by length descending (longer keywords match first in regex).
 */
export function getCanonicalKeywords(): string[] {
  const out: string[] = [];
  for (const family of RAW.families) {
    for (const levelKey of Object.keys(family.levels)) {
      out.push(deriveCanonical(family.name, Number(levelKey)));
    }
  }
  return out.sort((left, right) => right.length - left.length);
}

/**
 * Return the family base name for a force-level keyword in any declension
 * (`AS`, `AS!`, `AS!!`, `!AS` → `AS`), or null when the keyword is not a
 * recognized force-level form. Lets consumers match a whole family by its
 * base without enumerating every `!`-declension.
 */
export function forceLevelBaseOf(keyword: string): string | null {
  return parseForceLevel(keyword)?.family ?? null;
}

/**
 * THE declension grammar, family-blind: `<!*>BASE<!*>` → the base and its
 * signed level (−n for a `!` prefix, +n for a suffix); null when the word has
 * both or is no such form. The force levels (below) and the levels of a
 * condition head (`IF!`, `UNTIL!!` — lexer.splitControl) both build on it.
 */
export function splitBangs(word: string): { base: string; level: number } | null {
  const match = word.match(/^(!*)([A-Z][A-Z0-9]*)(!*)$/);
  if (!match) return null;
  const [, prefix, base, suffix] = match;
  if (prefix.length > 0 && suffix.length > 0) return null;
  return { base, level: prefix.length > 0 ? -prefix.length : suffix.length };
}

/**
 * Parse a canonical force-level keyword (`MUST!!`, `!ALWAYS`, …) into its
 * family + numeric level, or null when it is not a force-level form —
 * `getIntroByKeyword` and the DocumentBuilder both build on it.
 */
export function parseForceLevel(canonical: string): { family: string; level: number } | null {
  const split = splitBangs(canonical);
  if (!split || !RAW.families.some(family => family.name === split.base)) return null;
  return { family: split.base, level: split.level };
}

/**
 * Lookup the intro for a canonical keyword string. Returns null if the string
 * is not a recognized force-level or its level is not declared.
 */
export function getIntroByKeyword(canonical: string): string | null {
  const parsed = parseForceLevel(canonical);
  if (!parsed) return null;
  const family = RAW.families.find(candidate => candidate.name === parsed.family);
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
