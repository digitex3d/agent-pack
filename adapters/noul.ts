// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { JudgeError, isDirect, type JudgeCheck, type JudgeQuestion, type JudgePlugin, type JudgeAnswer } from '../src/judge/types.js';

/**
 * A judge over a decisions API — one request per line, the line as the input
 * and one yes/no (`noul`) question per check; the answer is the probability of
 * "yes". Every such service shares this; a provider (`jev/`, `gemini/`) names
 * only what is its own: where, how the key travels, and its field names.
 *
 * The API key comes from the provider's environment variable, else its key
 * file — never from the config. It is an opaque token: no message, error or
 * log ever carries it (every text from outside is scrubbed of it).
 *
 * Failures are typed for the phase: no key, unreachable, timed out, or key
 * rejected take the judge offline; anything else fails only this line — a 429
 * or 5xx after one retry.
 */
export interface NoulProvider {
  name: string;
  url: string;
  model: string;
  /** The environment variable, then the file under the home directory, holding the key. */
  keyEnv: string;
  keyFile: string;
  /** The request headers that carry the key. */
  headers(key: string): Record<string, string>;
  /** The body field the line goes in (`state`, `input`). */
  inputField: string;
  /** The criteria field names for what yes and no mean. */
  criteriaFields: { yes: string; no: string };
  /** Whether a failed response means the key is rejected — the judge goes offline. Default: 401, 403. */
  rejectsKey?(status: number, text: string): boolean;
  maxStateChars: number;
}

/** How long one request may take before the service counts as unreachable. */
const TIMEOUT_MS = 30_000;
/** The wait before the one retry of a 429 or 5xx. */
const RETRY_DELAY_MS = 1_000;

/** The API key, or null — read at each request, never kept beyond it. */
function readKey(p: NoulProvider): string | null {
  const env = process.env[p.keyEnv]?.trim();
  if (env) return env;
  const file = resolve(homedir(), p.keyFile);
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() || null : null;
}

/** A text from outside (an error, a response body) with the key masked out. */
function scrub(text: string, key: string): string {
  return text.split(key).join('***');
}

/**
 * The question one check becomes — a question as is; a negative rule (`NEVER x`)
 * asked directly about the state's `line` ("Does `line` x?"), with what yes and
 * no mean when the rule says it; any other rule's statement in the judge's wording.
 */
function questionOf(check: JudgeCheck | JudgeQuestion, fields: NoulProvider['criteriaFields']): { type: 'noul'; instructions: string; criteria?: Record<string, string> } {
  if ('question' in check) return { type: 'noul', instructions: check.question };
  if (!isDirect(check)) return { type: 'noul', instructions: `Does the line satisfy this rule: "${check.statement}"?` };
  const { yes, no } = check.criteria ?? {};
  const criteria = { ...(yes ? { [fields.yes]: yes } : {}), ...(no ? { [fields.no]: no } : {}) };
  return { type: 'noul', instructions: `Does \`line\` ${check.statement}?`, ...(yes || no ? { criteria } : {}) };
}

export function noulJudge(p: NoulProvider, opts: { url?: string; model?: string } = {}): JudgePlugin {
  const url = opts.url ?? p.url;
  const rejectsKey = p.rejectsKey ?? ((status: number) => status === 401 || status === 403);
  return {
    type: 'judge',
    name: p.name,
    maxStateChars: p.maxStateChars,
    async ask(state, checks, model) {
      const key = readKey(p);
      if (!key) throw new JudgeError('offline', `${p.name}: no API key — set ${p.keyEnv} or write it to ~/${p.keyFile}`);
      const sent = model ?? opts.model ?? p.model;
      // Question ids are positional: a check id is the caller's, not the service's.
      const questions = Object.fromEntries(checks.map((c, i) => [`q${i + 1}`, questionOf(c, p.criteriaFields)]));
      const post = async (): Promise<{ res: Response; text: string }> => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { ...p.headers(key), 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: sent, [p.inputField]: state, questions }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          return { res, text: await res.text().catch(() => '') };
        } catch (err) {
          throw new JudgeError('offline', `${p.name}: unreachable — ${scrub(err instanceof Error ? err.message : String(err), key)}`);
        }
      };
      const retryable = (status: number): boolean => status === 429 || status >= 500;
      let { res, text } = await post();
      if (retryable(res.status)) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        ({ res, text } = await post());
      }
      if (!res.ok) {
        const kind = rejectsKey(res.status, text) ? 'offline' : 'line';
        throw new JudgeError(kind, `${p.name}: HTTP ${res.status} — ${scrub(text, key).slice(0, 300)}`);
      }
      let body: { model?: unknown; answers?: Record<string, { noul?: unknown }> };
      try {
        body = JSON.parse(text);
      } catch {
        throw new JudgeError('line', `${p.name}: the answer is not JSON — ${scrub(text, key).slice(0, 300)}`);
      }
      const answers: Record<string, JudgeAnswer> = {};
      checks.forEach((c, i) => {
        const yes = body.answers?.[`q${i + 1}`]?.noul;
        if (typeof yes !== 'number' || yes < 0 || yes > 1) throw new JudgeError('line', `${p.name}: the answer has no probability for question q${i + 1} (${c.id})`);
        // A direct question answers whether the line breaks the rule: the check holds on a no.
        answers[c.id] = isDirect(c) ? 1 - yes : yes;
      });
      return { model: typeof body.model === 'string' ? body.model : sent, answers };
    },
  };
}
