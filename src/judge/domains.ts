// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The domains of a project's files, given at build time (D44): under
 * `STRATEGY contracts` the lead's DOMAINS dimension says which domain each
 * file of its FOR belongs to — one domain per file, a value of its template's
 * ENUM. The judge answers it as a choice for every file whose entry in the
 * dimension's cache is not fresh (`DimensionCache`, the same cache the apx
 * serves); a clear answer is written to the cache, a grey one is the
 * developer's — recorded in the judge lock, which wins and survives the cache.
 * The files a run creates get theirs from the apx at dispatch, the same way.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ApDocument } from '../apdoc/document.js';
import type { DimensionBlock } from '../apdoc/blocks.js';
import { DimensionCache, dimensionDefHash, dimensionTemplates, fingerprint } from '../apx/dimensions.js';
import { DOMAIN_QUESTION, domainKey, domainOptions, domainChoices, domainEntry, domainOf } from './domainCache.js';
export { DOMAIN_QUESTION, domainKey, domainOptions, domainEntry };
import { matchesAnyGlob } from '../services/glob.js';
import { projectFiles } from '../services/fs.js';
import { lineOfName, type LintError } from '../lint.js';
import { decideChoice, rankedOptions } from './choice.js';
import type { JudgeRun } from './phase.js';

/** A file the judge left grey: the developer chooses. */
export interface UndecidedDomain {
  /** From the project root. */
  file: string;
  options: string[];
  /** The two options the judge hesitated between, most probable first, each with its probability. */
  between: [string, string];
  p: [number, number];
  /** The lock key of the decision. */
  key: string;
}

export interface DomainTagging {
  errors: LintError[];
  warnings: LintError[];
  undecided: UndecidedDomain[];
  /** What the run did: files in the FOR, taken from the cache as fresh, decided by a saved decision, asked, decided by the judge. */
  stats: { files: number; fresh: number; decided: number; asked: number; judged: number };
}

/**
 * Tag every file of the dimension's FOR: fresh entries are kept; a saved
 * decision of the lock is written; the rest are asked, the clear ones written,
 * the grey ones returned for the developer. A judge offline is an error — a
 * team of contracts cannot build without the domains.
 */
export async function tagDomains(doc: ApDocument, dim: DimensionBlock, teamFile: string, run: JudgeRun, projectRoot: string): Promise<DomainTagging> {
  const out: DomainTagging = { errors: [], warnings: [], undecided: [], stats: { files: 0, fresh: 0, decided: 0, asked: 0, judged: 0 } };
  const options = domainOptions(doc, dim);
  if (!options) return out; // the compiler reports the template's shape
  const defhash = dimensionDefHash(dim, dimensionTemplates(doc, dim));
  const cache = new DimensionCache(projectRoot, defhash);
  const files = projectFiles(projectRoot, rel => matchesAnyGlob(rel, dim.globs));
  out.stats.files = files.length;
  const atTeam = (message: string, severity?: 'warning'): LintError => ({ file: teamFile, line: lineOfName(teamFile, dim.name), message, ...(severity ? { severity } : {}) });
  const seen = new Set<string>();
  await Promise.all(files.map(async file => {
    const hash = fingerprint(readFileSync(join(projectRoot, file), 'utf-8'));
    const entry = cache.read(file);
    if (entry && entry.hash === hash && Array.isArray(entry.value)) {
      out.stats.fresh++;
      seen.add(domainOf(entry, options.slot) ?? '');
      return;
    }
    const key = domainKey(defhash, hash);
    const decided = run.lock.decision(key)?.choice;
    run.usedKeys.add(key);
    if (decided && options.values.includes(decided)) {
      cache.write(domainEntry(dim, file, hash, options.slot, decided, 'human'));
      out.stats.decided++;
      seen.add(decided);
      return;
    }
    out.stats.asked++;
    const answer = await run.askChoice(readFileSync(join(projectRoot, file), 'utf-8'), DOMAIN_QUESTION, domainChoices(options));
    if ('offline' in answer) { out.errors.push(atTeam(`DOMAINS ${dim.name}: the judge cannot give \`${file}\` its domain — ${answer.offline}`)); return; }
    if ('failed' in answer) { out.errors.push(atTeam(`DOMAINS ${dim.name}: the judge failed on \`${file}\` — ${answer.failed}`)); return; }
    const verdict = decideChoice(answer.distribution, run.options.threshold, run.options.margin);
    if ('choice' in verdict) {
      cache.write(domainEntry(dim, file, hash, options.slot, verdict.choice, `judge:${run.options.adapter.name}`));
      out.stats.judged++;
      seen.add(verdict.choice);
      return;
    }
    const ranked = rankedOptions(answer.distribution);
    out.undecided.push({ file, options: ranked.map(([o]) => o), between: verdict.grey, p: verdict.p, key });
  }));
  for (const value of options.values) {
    if (!seen.has(value)) out.warnings.push(atTeam(`DOMAINS ${dim.name}: no file of ${dim.globs.join(' ')} has the domain \`${value}\``, 'warning'));
  }
  out.undecided.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** Record the developer's choice for a grey file: in the lock (the source) and in the cache (what the apx serves). */
export function decideDomain(doc: ApDocument, dim: DimensionBlock, run: JudgeRun, projectRoot: string, undecided: UndecidedDomain, choice: string): void {
  const options = domainOptions(doc, dim)!;
  const defhash = dimensionDefHash(dim, dimensionTemplates(doc, dim));
  const hash = fingerprint(readFileSync(join(projectRoot, undecided.file), 'utf-8'));
  run.lock.decide(undecided.key, choice);
  new DimensionCache(projectRoot, defhash).write(domainEntry(dim, undecided.file, hash, options.slot, choice, 'human'));
}

/** What a grey file is told when nobody decides: the two options and how the judge split. */
export function undecidedMessage(dim: DimensionBlock, u: UndecidedDomain): string {
  return `DOMAINS ${dim.name}: \`${u.file}\` — ${u.between[0]} (${u.p[0].toFixed(2)}) or ${u.between[1]} (${u.p[1].toFixed(2)})? Run \`agent-pack bundle all\` on a terminal to decide, or add the decision to the judge lock`;
}
