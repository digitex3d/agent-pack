// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The pretty reporter — the compiler's output on a terminal, after rustc and
 * cargo: each diagnostic once, as a head (`error[code]: what`), where it is
 * (`--> file:line:col`), the source line with the span underlined, and the
 * hint after it (`= help: …`); the files written only with `--verbose`; a last
 * line that says how the build ended and how long it took. Outside the core:
 * the core reports through `src/report.ts` and never imports this.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';
import { CompileError, type BuildSummary, type Diagnostic, type Reporter } from '../../src/report.js';
import { errorMessage } from '../../src/errors.js';

export interface PrettyOptions {
  /** The project root — paths are shown from it. */
  root: string;
  /** List every file written. */
  verbose?: boolean;
  /** Colour the output (default: on). */
  color?: boolean;
}

/** The part of a message after its first ` — ` is the hint: what to do about it. */
const HINT = ' — ';

export function prettyReporter({ root, verbose = false, color = true }: PrettyOptions): Reporter {
  const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const red = paint('1;31'), yellow = paint('1;33'), blue = paint('1;34'), green = paint('1;32'), cyan = paint('36'), dim = paint('2'), bold = paint('1');
  const out = (line = '') => process.stderr.write(`${line}\n`);

  const started = Date.now();
  const seen = new Set<string>();
  const sources = new Map<string, string[] | null>();
  let errors = 0;
  let warnings = 0;
  const written: string[] = [];

  const shown = (path: string) => relative(root, path) || path;
  const linesOf = (file: string): string[] | null => {
    if (!sources.has(file)) {
      try { sources.set(file, readFileSync(file, 'utf-8').split('\n')); } catch { sources.set(file, null); }
    }
    return sources.get(file)!;
  };

  /** The source line of a diagnostic, the one before it, and the span underlined. */
  const excerpt = (d: Diagnostic): string[] => {
    const lines = linesOf(d.file);
    const text = lines?.[d.line - 1];
    if (text === undefined) return [];
    const width = String(d.line).length;
    const gutter = (n: number | null) => blue(`${n === null ? ' '.repeat(width) : String(n).padStart(width)} |`);
    const start = d.col ? d.col - 1 : text.length - text.trimStart().length;
    const end = d.endCol ? d.endCol - 1 : d.col ? start + (/^\S+/.exec(text.slice(start))?.[0].length ?? 1) : text.trimEnd().length;
    const before = lines![d.line - 2];
    return [
      gutter(null),
      ...(before?.trim() ? [`${gutter(d.line - 1)} ${before}`] : []),
      `${gutter(d.line)} ${text}`,
      `${gutter(null)} ${' '.repeat(start)}${(d.severity === 'warning' ? yellow : red)('^'.repeat(Math.max(1, end - start)))}`,
    ];
  };

  const show = (d: Diagnostic): void => {
    const key = [d.severity, d.file, d.line, d.col, d.code, d.message].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    const warning = d.severity === 'warning';
    if (warning) warnings++; else errors++;
    const cut = d.message.indexOf(HINT);
    const title = cut < 0 ? d.message : d.message.slice(0, cut);
    const hint = cut < 0 ? null : d.message.slice(cut + HINT.length);
    const head = (warning ? yellow : red)(`${warning ? 'warning' : 'error'}${d.code ? `[${d.code}]` : ''}`);
    out(`${head}${bold(`: ${title}`)}`);
    out(`  ${blue('-->')} ${shown(d.file)}:${d.line}${d.col ? `:${d.col}` : ''}`);
    for (const line of excerpt(d)) out(line);
    if (hint) out(`${' '.repeat(String(d.line).length)} ${blue('=')} ${bold('help')}: ${hint}`);
    out();
  };

  return {
    diagnostics: list => list.forEach(show),
    info: message => out(`${cyan('  •')} ${message}`),
    note: message => out(dim(message)),
    written: path => {
      written.push(path);
      if (verbose) console.log(dim(`    ${shown(path)}`));
    },
    failed: (error, subject) => {
      // A compilation's errors are shown once, whichever agent met them first.
      if (error instanceof CompileError) { error.diagnostics.forEach(show); return; }
      errors++;
      out(`${red('error')}${bold(`: ${subject ? `${subject}: ` : ''}${errorMessage(error)}`)}`);
      out();
    },
    done: ({ agents, adapters, files, failures }: BuildSummary) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const warned = warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
      if (failures > 0 || errors > 0) {
        out(`${red('error')}${bold(`: build failed — ${errors} error${errors === 1 ? '' : 's'}${warned}; ${failures} step${failures === 1 ? '' : 's'} did not complete`)}`);
        return;
      }
      const listed = verbose || files === 0 ? '' : dim(' (--verbose lists them)');
      out(`${green('    Finished')} ${agents} agent${agents === 1 ? '' : 's'} × ${adapters} adapter${adapters === 1 ? '' : 's'} → ${files} file${files === 1 ? '' : 's'} in ${seconds}s${warned}${listed}`);
    },
  };
}
