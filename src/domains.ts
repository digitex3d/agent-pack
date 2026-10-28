// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A DOMAIN's lines (D44) — the one reading of them, for the lint, the block and
 * the perimeter:
 *
 *   WRITES IN src/web/**, src/shared/ui.ts   the files work within it may write
 *   READS  IN src/**                          the ones it may only read
 *   WRITES! <formula> [IN <glob>, …]          a formula a judge decides, file by file
 *
 * Lines add up. A line holds a formula, an IN, or both; the `!`s weigh the
 * formula's judgement as IF's do — `!` the agent decides the uncertain files,
 * `!!` the judge alone. A formula needs a judge — the config's `judge`, the one
 * that checks the lines (D34): the compilation asks it, for each file of the
 * formula's IN (the whole project without one), the probability that the file
 * belongs to the formula. Without a judge a formula is an error — never a
 * fallback on its IN. The thresholds `domains: { in, out }` turn the
 * probabilities into files: at or above `in` within, at or below `out` outside,
 * between them — under `!` — the agent decides, in context.
 * No imports from the compiler: the apx engine bundles this module.
 */
import { splitList } from './lists.js';
import { lex, type DomainLine } from './lexer.js';

/** A DOMAIN line as written: its formula (null: globs only) and the globs of its IN. */
export interface DomainLineParts {
  formula: string | null;
  globs: string[];
}

/** `<formula> IN <glob>, …`, `IN <glob>, …` or `<formula>` — the first uppercase IN opens the globs. */
const IN_RE = /^(?:(.*?)\s+)?IN\s+(\S.*)$/;

/** A DOMAIN line's rest as its formula and its globs. */
export function parseDomainLine(rest: string): DomainLineParts {
  const text = rest.trim();
  const m = IN_RE.exec(text);
  if (!m) return { formula: text || null, globs: [] };
  return { formula: m[1]?.trim() || null, globs: splitList(m[2]) };
}

/** What is wrong with a DOMAIN line — null when it holds. `level` is its `!`s. */
export function domainLineIssue(keyword: DomainLine, level: number, parts: DomainLineParts): string | null {
  const head = `${keyword}${'!'.repeat(level)}`;
  if (parts.formula === null && parts.globs.length === 0) return `${head} needs its files — \`${keyword} IN <glob>, …\`, or a formula a judge decides: \`${keyword}! <formula>\``;
  if (parts.formula === null) return level > 0 ? `${head} IN …: the \`!\`s weigh a formula's judgement, and this line has none — write \`${keyword} IN ${parts.globs.join(', ')}\`` : null;
  if (level === 0) return `${keyword} ${parts.formula}: a formula is decided by a judge — say how much it weighs: \`${keyword}! <formula>\` (the agent decides the uncertain files) or \`${keyword}!! <formula>\` (the judge alone)`;
  return null;
}

/** A formula line with no judge in the config: the compilation's error — a judge decides it, or its files are written. */
export function noJudgeMessage(f: Pick<DomainFormula, 'keyword' | 'level' | 'formula'>): string {
  return `${f.keyword}${'!'.repeat(f.level)} ${f.formula}: a domain formula needs a judge — add \`judge\` to the config (the judge of the lines decides it, file by file), or write its files: \`${f.keyword} IN <glob>, …\``;
}

/** The probabilities that split a formula's files: at or above `in` within, at or below `out` outside. */
export interface DomainThresholds {
  in: number;
  out: number;
}

export const DEFAULT_DOMAIN_THRESHOLDS: DomainThresholds = { in: 0.8, out: 0.2 };

/** A formula line of a DOMAIN, and — once judged — the probability of each file it was asked about. */
export interface DomainFormula {
  keyword: DomainLine;
  /** Its `!`s: 1 the agent decides the uncertain files, 2 the judge alone. */
  level: 1 | 2;
  formula: string;
  /** The globs of its IN — the files the judge is asked about; empty: every file of the project. */
  globs: string[];
  /** File (from the project root) → the probability it belongs; absent until judged. */
  p?: Record<string, number>;
}

/** A DOMAIN's lines as written: the globs of its plain lines, and its formula lines. */
export function domainLines(body: string): { writes: string[]; reads: string[]; formulas: DomainFormula[] } {
  const out = { writes: [] as string[], reads: [] as string[], formulas: [] as DomainFormula[] };
  for (const t of lex(body)) {
    if (t.kind !== 'keyword' || t.indent !== 0 || (t.keyword !== 'WRITES' && t.keyword !== 'READS') || !t.rest) continue;
    const parts = parseDomainLine(t.rest);
    const level = t.level ?? 0;
    if (parts.formula !== null && (level === 1 || level === 2)) out.formulas.push({ keyword: t.keyword as DomainLine, level, formula: parts.formula, globs: parts.globs });
    else if (parts.formula === null) (t.keyword === 'WRITES' ? out.writes : out.reads).push(...parts.globs);
  }
  return out;
}

/** What a judged formula puts within: the files at or above `in`, and — under `!` — the uncertain ones with their probability. */
export function formulaFiles(f: DomainFormula, t: DomainThresholds): { within: string[]; uncertain: Record<string, number> } {
  const within: string[] = [];
  const uncertain: Record<string, number> = {};
  for (const [file, p] of Object.entries(f.p ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (p >= t.in) within.push(file);
    else if (f.level === 1 && p > t.out) uncertain[file] = p;
  }
  return { within, uncertain };
}

/** The question the judge answers for one file: the probability that it belongs to the formula. */
export function formulaQuestion(f: Pick<DomainFormula, 'keyword' | 'formula'>): { id: string; question: string } {
  const what = f.keyword === 'WRITES' ? 'work within this domain may write' : 'work within this domain may only read';
  return { id: `domain-${f.keyword.toLowerCase()}`, question: `The domain's ${f.keyword} line says the files ${what}: "${f.formula}". Does the file in the state — its path, then its text — belong to them?` };
}
