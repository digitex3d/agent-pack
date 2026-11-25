// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The call log: every call of an apx, once, as one JSON line in
 * `.agent-pack/log/calls.jsonl`. It tells what was called, never with which
 * data: of the command only its verb is kept — and, in a unit, the agent its
 * first word names — never a value typed on the line, read from stdin or kept
 * in a store — and the keys of the blocks the dashboard showed after the
 * answer (ids alone, in the order printed). Logging never fails a call, and
 * nothing reads the log to decide anything.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ApDocument } from '../apdoc/document.js';
import type { ReceivedEnvelope } from './call.js';
import { CALL_LOG_FILE, LOG_DIR } from './paths.js';
import { harnessSession } from './session.js';
import { APX_SERVICE_KINDS, APX_VERBS } from './verbs.js';

/** The words a call's verb may be: anything else on the line is never logged. */
const VERBS: ReadonlySet<string> = new Set([...APX_VERBS, ...APX_SERVICE_KINDS]);

/** What a call to log is: its words, the envelope taken off, the envelope as received, and where the project is. */
interface CallLogInit {
  words: readonly string[];
  envelope: ReceivedEnvelope | null;
  projectRoot: string;
}

/**
 * One call being served, and its line in the log: the branch that serves it
 * says who serves it (`servedBy`), and the line is written once, as the call
 * ends (`write`).
 */
export class CallLog {
  private agent = '';
  private sessionEnv: string | undefined;
  private shown: string[] = [];
  private readonly holders = new Set<string>();

  constructor(private readonly init: CallLogInit) {}

  /** The agents and teams a unit holds: its first word may name one. */
  holds(held: Iterable<string>): void {
    for (const name of held) this.holders.add(name);
  }

  /** Who serves the call, from which document — the session variable it names. */
  servedBy(agent: string, doc: ApDocument | null): void {
    this.agent = agent;
    this.sessionEnv = doc?.meta.sessionEnv;
  }

  /** The keys of the blocks the dashboard showed after the answer, in the order printed — none when it showed nothing. */
  showed(keys: readonly string[]): void {
    this.shown = [...keys];
  }

  /** Write the call's line, with the exit code it ended with — a log that cannot be written is left unwritten, silently. */
  write(exit: number): void {
    const session = harnessSession(this.sessionEnv);
    const entry = {
      at: new Date().toISOString(),
      session: 'id' in session ? session.id : '',
      agent: this.agent,
      command: this.command(),
      call: this.init.envelope?.call ?? null,
      problem: this.init.envelope?.problem ?? null,
      shown: this.shown,
      exit,
    };
    try {
      mkdirSync(join(this.init.projectRoot, LOG_DIR), { recursive: true });
      appendFileSync(join(this.init.projectRoot, CALL_LOG_FILE), `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging never fails a call.
    }
  }

  /** The verb alone — after the agent a unit's first word names — and only a known one: never what follows it. */
  private command(): string[] {
    const [first = '', ...rest] = this.init.words;
    const held = this.holders.has(first);
    const [verb = ''] = held ? rest : [first];
    return [...(held ? [first] : []), ...(VERBS.has(verb) ? [verb] : [])];
  }
}
