// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The domain formulas of a document, judged (D44): for each formula line of a
 * DOMAIN (`WRITES! <formula> [IN <glob>, …]`), the judge of the lines — the
 * config's `judge` — is asked, file by file, the probability that the file
 * belongs to the formula: the files of its IN, or every file of the project.
 * The probabilities go on the block — the apx carries them — and the machine
 * verdicts into the domain file's unit, so the next run asks only about files
 * that are new or changed (or all of them, when the formula changes); a human
 * decision in the lock wins. Without a judge a formula is an error.
 */
import { readFileSync } from 'node:fs';
import type { ApDocument } from '../apdoc/document.js';
import type { DomainBlock } from '../apdoc/blocks.js';
import type { BundleContext } from '../dispatch/types.js';
import type { LintError } from '../lint.js';
import { formulaQuestion, noJudgeMessage, type DomainFormula } from '../domains.js';
import { projectFiles, relativeWithin } from '../services/fs.js';
import { matchesAnyGlob } from '../services/glob.js';
import { resolve } from 'node:path';
import type { JudgeRun } from './phase.js';

/** The 1-based line of a formula in its domain file — the first line of its keyword, its `!`s and its text. */
function formulaLine(file: string, f: DomainFormula): number {
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  const head = new RegExp(`^\\s*${f.keyword}!{${f.level}}\\s`);
  const i = lines.findIndex(l => head.test(l) && l.includes(f.formula));
  return i + 1 || 1;
}

/** A file's text as the judge reads it — empty for a binary file: its path alone tells. */
function textOf(path: string): string {
  try {
    const text = readFileSync(path, 'utf-8');
    return text.includes('\0') ? '' : text;
  } catch {
    return '';
  }
}

/**
 * Judge the formulas of the document's domains. Returns the errors — a formula
 * with no judge, a file the judge could not answer for when the config says
 * `offline: 'error'` — and the domains some file of which stayed unjudged: a
 * file not judged stays outside, and the run warns of it.
 */
export async function judgeDomainFormulas(doc: ApDocument, ctx: BundleContext, run: JudgeRun | null | undefined, projectRoot: string): Promise<{ errors: LintError[]; unjudged: Set<string> }> {
  const errors: LintError[] = [];
  const unjudged = new Set<string>();
  for (const d of doc.byKind('domain') as DomainBlock[]) {
    if (d.formulas.length === 0) continue;
    const file = ctx.domains.find(e => e.name === d.name)?.path ?? null;
    if (!run) {
      for (const f of d.formulas) errors.push({ file: file ?? d.address, line: file ? formulaLine(file, f) : 1, message: noJudgeMessage(f) });
      unjudged.add(d.name);
      continue;
    }
    d.thresholds = run.domains;
    const unit = file ? run.file(file, ctx.sources) : null;
    // The judge's own lock is no file of any domain.
    const lock = relativeWithin(projectRoot, run.options.lock);
    for (const f of d.formulas) {
      const question = formulaQuestion(f);
      const candidates = projectFiles(projectRoot, rel => rel !== lock && (f.globs.length === 0 || matchesAnyGlob(rel, f.globs)));
      const verdicts = await Promise.all(candidates.map(async rel => [rel, await run.fileVerdict(question, rel, textOf(resolve(projectRoot, rel)))] as const));
      const p: Record<string, number> = {};
      let missed: string | null = null;
      for (const [rel, v] of verdicts) {
        if (!('p' in v)) { missed ??= v.reason; continue; }
        p[rel] = v.p;
        run.usedKeys.add(v.key);
        if (unit && v.machine !== undefined) unit.verdicts.set(v.key, v.machine);
      }
      f.p = p;
      if (unit) unit.rejudged = true;
      if (missed !== null) {
        unjudged.add(d.name);
        if (unit) unit.incomplete = true;
        const diagnostic: LintError = {
          file: file ?? d.address, line: file ? formulaLine(file, f) : 1,
          severity: run.options.offline === 'error' ? 'error' : 'warning', source: 'judge',
          message: `DOMAIN ${d.name}: ${f.keyword}${'!'.repeat(f.level)} ${f.formula}: some files not judged yet — ${missed}; they stay outside the domain`,
        };
        if (diagnostic.severity === 'error') errors.push(diagnostic);
        else run.warn({ ...diagnostic, code: 'domain-formula' });
      }
    }
  }
  return { errors, unjudged };
}
