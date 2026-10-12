// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge — a compile phase in which a model checks that `.ap` code is well
 * written. These are its data contracts: a rule (a `#judge` template), its
 * checks, the judge plugin that answers them, and the `judge` config key.
 */
import type { ApCheck } from '../apdoc/types.js';
import type { TemplateBlock } from '../apdoc/blocks.js';
import type { JUDGE_SCOPES } from '../services/tags.js';

/** One check of a rule — a template's slot rule as a neutral statement. */
export type JudgeCheck = ApCheck;

/**
 * A check written as a negative rule (`NEVER …`, `SHOULD-NOT …`): the judge is asked directly
 * whether the line does it — a yes breaks the rule. Every other check is asked
 * whether the line satisfies it.
 */
export function isDirect(check: JudgeCheck | JudgeQuestion): boolean {
  return !('question' in check) && (check.force.level ?? 0) < 0;
}

/** One reference example of a rule — an `EXAMPLE` line `<line> → <verdict>`. */
export interface JudgeExample {
  line: string;
  verdict: string;
}

/** A question asked as is — a checked condition's (`IF!`), built at compile time. */
export interface JudgeQuestion {
  id: string;
  question: string;
}

/** A rule: a TEMPLATE tagged `#judge`, applied to every line of its layout's primitive. */
export interface JudgeRule {
  /** The template's address (`<namespace>/<name>`) — unique, even when two libraries share a name. */
  id: string;
  /**
   * The keyword of the lines it judges — the first word of the layout (`DO {action}` → `DO`);
   * null when the layout names none (`{line}`): every line of its scope.
   */
  primitive: string | null;
  /**
   * `#executed`: only the lines a delegate or a program carries out; `#program`: only a
   * program's; `#agent`: only the agent's own (src/executor.ts). Absent: every line of its primitive.
   */
  scope?: (typeof JUDGE_SCOPES)[number];
  template: TemplateBlock;
  checks: JudgeCheck[];
  /** What a judged line is, for the judge — the description of the template's slot. */
  role?: string;
  /** The template's EXAMPLE lines written `<line> → <verdict>`, sent with every line it judges. */
  examples: JudgeExample[];
}

/**
 * A judge: answers, for one line of text (`state`), the probability (0..1) that
 * each check holds — a rule's statement in the judge's own wording, or a
 * question asked as is. `model` pins the model version once known; the answer names
 * the model that answered. Errors never carry a credential.
 */
export interface JudgePlugin {
  type: 'judge';
  name: string;
  ask(state: string, checks: (JudgeCheck | JudgeQuestion)[], model?: string): Promise<{ model: string; answers: Record<string, number> }>;
  /** The largest state, in characters, the judge reads — a larger one is never sent. Absent: no limit. */
  maxStateChars?: number;
}

/**
 * Why a judge failed, as the phase acts on it. `offline`: the judge cannot be
 * reached or refuses the caller (transport, timeout, key missing or rejected) —
 * no request follows. `line`: only this request failed (rate limit, server
 * error, bad request, malformed answer) — that line stays not judged, the rest
 * of the queue goes on. The phase reads `kind` — a plugin may throw any error
 * carrying it; an error without `kind: 'line'` counts as `offline`.
 */
export class JudgeError extends Error {
  constructor(readonly kind: 'offline' | 'line', message: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

/** What to do with a line no saved verdict covers when the judge cannot be reached. */
export type JudgeOffline = 'warn' | 'error';

/** The resolved `judge` config key — absent (null) turns the phase off. */
export interface JudgeConfig {
  adapter: JudgePlugin;
  /** A check answered below this probability is reported. */
  threshold: number;
  offline: JudgeOffline;
  /** Absolute path of the judge lock. */
  lock: string;
  /** Requests in flight at most. */
  concurrency: number;
}

/**
 * The resolved `checks` config key — the judge of checked conditions (`IF!`,
 * `IF!!`, `UNTIL!`, `UNTIL!!`) while the agent works, apart from the
 * compile-time `judge`. Absent (null): `IF!` falls back to `IF` with a
 * warning, `IF!!` fails the compilation.
 */
export interface ChecksConfig {
  adapter: JudgePlugin;
  /** A condition answered at or above this probability is open; below, closed. */
  threshold: number;
  /** How many closed answers in a row a checked UNTIL takes before it stops. */
  rounds: number;
}
