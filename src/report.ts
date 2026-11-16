// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * What the compiler has to say, and nothing of how it is shown. The core
 * reports through the `Reporter` in use — diagnostics as data, a build's steps
 * as calls — and never writes to the console itself; the CLI picks how they
 * read (`reporters/`). The plain reporter here is the default: one line each,
 * as agent-pack always printed — for CI, pipes and tests.
 */
import { formatErrors, type LintError } from './lint.js';

/** A diagnostic of the compiler: where, how bad, what — and the rule or check that said it. */
export type Diagnostic = LintError;

/**
 * A compilation stopped by its errors. They travel as data; the message is
 * their plain text, for whoever only reads a message.
 */
export class CompileError extends Error {
  constructor(readonly label: string, readonly diagnostics: Diagnostic[]) {
    super(`${label} failed: ${diagnostics.length} lint error(s):\n${formatErrors(diagnostics)}`);
    this.name = 'CompileError';
  }
}

/** The end of a `bundle all`: what it built, and how many things failed. */
export interface BuildSummary {
  agents: number;
  adapters: number;
  files: number;
  failures: number;
}

/** Where the compiler's output goes. */
export interface Reporter {
  /** Warnings or errors found — a reporter may show each once. */
  diagnostics(list: Diagnostic[]): void;
  /** One thing the build did or found, in a line. */
  info(message: string): void;
  /** A line of a phase's own, already worded (the judge's summary, a usage). */
  note(message: string): void;
  /** A file the build wrote. */
  written(path: string): void;
  /** Something that failed — what (an agent on an adapter, AGENTS.md…), and why; a `CompileError` carries its diagnostics. */
  failed(error: unknown, subject?: string): void;
  /** The end of a `bundle all`. */
  done(summary: BuildSummary): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One line each, as agent-pack always printed them. */
export const plainReporter: Reporter = {
  diagnostics: list => { if (list.length > 0) console.error(formatErrors(list)); },
  info: message => console.error(`[agent-pack] ${message}`),
  note: message => console.error(message),
  written: path => console.log(path),
  failed: (error, subject) => console.error(subject ? `[agent-pack] failed ${subject}: ${messageOf(error)}` : messageOf(error)),
  done: ({ agents, adapters, files, failures }) => {
    const suffix = failures > 0 ? ` (${failures} error(s))` : '';
    console.error(`[agent-pack] bundled ${agents} agent(s) × ${adapters} adapter(s) → ${files} file(s)${suffix}`);
  },
};

let current: Reporter = plainReporter;

/** The reporter the compiler reports through. */
export function reporter(): Reporter {
  return current;
}

/** Report through `next` from now on — the CLI's choice. */
export function useReporter(next: Reporter): void {
  current = next;
}
