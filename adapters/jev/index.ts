// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { JudgeError, type JudgeCheck, type JudgePlugin } from '../../src/judge/types.js';

/**
 * Jev (TypeSafe AI) as the judge — the only place that knows Jev.
 *
 * One request per line: `POST /v1/systemone` with the line as `state` and one
 * yes/no (`noul`) question per check; the answer is the probability of "yes".
 * The model is `jev-latest` until the caller pins the version Jev reported
 * (e.g. `jev-1.13.0`), which the direct API accepts as `model`.
 *
 * The API key comes from `TYPESAFE_API_KEY`, else `~/.config/typesafe/key` —
 * never from the config. It is an opaque token: no message, error or log of
 * this adapter ever carries it (every text from outside is scrubbed of it).
 *
 * Failures are typed for the phase: no key, unreachable, timed out, or key
 * rejected (401/403) take the judge offline; anything else fails only this
 * line — a 429 or 5xx after one retry.
 */
export interface JevOptions {
  url?: string;   // default: https://api.typesafe.ai/v1/systemone
  model?: string; // default: jev-latest
}

const URL_DEFAULT = 'https://api.typesafe.ai/v1/systemone';
const MODEL_DEFAULT = 'jev-latest';
/** How long one request may take before Jev counts as unreachable. */
const TIMEOUT_MS = 30_000;
/** The wait before the one retry of a 429 or 5xx. */
const RETRY_DELAY_MS = 1_000;

/** The API key, or null — read at each request, never kept beyond it. */
function readKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  const file = resolve(homedir(), '.config/typesafe/key');
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() || null : null;
}

/** A text from outside (an error, a response body) with the key masked out. */
function scrub(text: string, key: string): string {
  return text.split(key).join('***');
}

/** The question one check becomes. */
function questionOf(check: JudgeCheck): { type: 'noul'; instructions: string } {
  return { type: 'noul', instructions: `Does the line satisfy this rule: "${check.statement}"?` };
}

export default function jevJudge(opts: JevOptions = {}): JudgePlugin {
  const url = opts.url ?? URL_DEFAULT;
  return {
    type: 'judge',
    name: 'jev',
    async ask(state, checks, model) {
      const key = readKey();
      if (!key) throw new JudgeError('offline', 'jev: no API key — set TYPESAFE_API_KEY or write it to ~/.config/typesafe/key');
      // Question ids are positional: a check id is the caller's, not Jev's.
      const questions = Object.fromEntries(checks.map((c, i) => [`q${i + 1}`, questionOf(c)]));
      const post = async (): Promise<{ res: Response; text: string }> => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model ?? opts.model ?? MODEL_DEFAULT, state, questions }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          return { res, text: await res.text().catch(() => '') };
        } catch (err) {
          throw new JudgeError('offline', `jev: unreachable — ${scrub(err instanceof Error ? err.message : String(err), key)}`);
        }
      };
      const retryable = (status: number): boolean => status === 429 || status >= 500;
      let { res, text } = await post();
      if (retryable(res.status)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        ({ res, text } = await post());
      }
      if (!res.ok) {
        const kind = res.status === 401 || res.status === 403 ? 'offline' : 'line';
        throw new JudgeError(kind, `jev: HTTP ${res.status} — ${scrub(text, key).slice(0, 300)}`);
      }
      let body: { model?: unknown; answers?: Record<string, { noul?: unknown }> };
      try {
        body = JSON.parse(text);
      } catch {
        throw new JudgeError('line', `jev: the answer is not JSON — ${scrub(text, key).slice(0, 300)}`);
      }
      const answers: Record<string, number> = {};
      checks.forEach((c, i) => {
        const p = body.answers?.[`q${i + 1}`]?.noul;
        if (typeof p !== 'number' || p < 0 || p > 1) throw new JudgeError('line', `jev: the answer has no probability for question q${i + 1} (${c.id})`);
        answers[c.id] = p;
      });
      return { model: typeof body.model === 'string' ? body.model : model ?? opts.model ?? MODEL_DEFAULT, answers };
    },
  };
}
