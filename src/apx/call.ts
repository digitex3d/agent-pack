// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The envelope a call to an apx may end with: `--call '<json>'`, last on the
 * line — the goal of the work, the situation now, why this call. Its shape is
 * the built-in `call` template's (templates/library/apx/call.ap): the
 * compiler renders it into every document as the introduction to calling the
 * apx, which `start` prints to an agent that misses its quiz question. The
 * apx takes the envelope off the words and keeps it as received, for the call
 * log; it never changes what a call is served.
 */
import { FORMULAS, fill } from '../formulas.js';
import { errorMessage } from '../errors.js';

/** The built-in template that shapes the envelope — and the key of its introduction in a document's intros. */
export const CALL_TEMPLATE = 'call';

/** The line that says how to call an apx with the envelope, `cmd` being the command that runs it. */
export function callFraming(cmd: string): string {
  return fill(FORMULAS.apx.call.intro, { cmd });
}

/** The flag that opens the envelope: everything after it is its JSON. */
const CALL_FLAG = '--call';

/** A call's words, the envelope taken off: the command any verb sees, and the envelope's text — null without one. */
interface CallWords { command: string[]; envelope: string | null }

/** An envelope as received — parsed, or its raw text when it is no JSON — and, then, that it is none. */
export interface ReceivedEnvelope { call: unknown; problem: string | null }

/**
 * Take the envelope off a call's words: the first `--call` and everything
 * after it — words the shell split joined back with one space.
 */
export function takeEnvelope(words: readonly string[]): CallWords {
  const at = words.indexOf(CALL_FLAG);
  if (at < 0) return { command: [...words], envelope: null };
  return { command: words.slice(0, at), envelope: words.slice(at + 1).join(' ') };
}

/** An envelope as received: parsed when it is JSON, else its text, with why it is none. */
export function readEnvelope(envelope: string): ReceivedEnvelope {
  try {
    return { call: JSON.parse(envelope), problem: null };
  } catch (caught) {
    return { call: envelope, problem: fill(FORMULAS.apx.call.notJson, { error: errorMessage(caught) }) };
  }
}
