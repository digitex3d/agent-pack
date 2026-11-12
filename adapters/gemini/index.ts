// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { noulJudge } from '../noul.js';
import type { JudgePlugin } from '../../src/judge/types.js';

/**
 * Gemini Decision 1 (Google's Decisions API) as the judge — the only place that knows it.
 *
 * `POST /v1beta/decisions`, the line as `input`, the key in `x-goog-api-key`
 * from `GEMINI_API_KEY` or `~/.config/gemini/key`. A yes/no answer is capped to
 * 0.01..0.99 by the service: no threshold above 0.99 ever passes. Google answers
 * a bad key with a 400 naming `API_KEY_INVALID`, so that 400 takes the judge
 * offline too. The rest is every decisions API's (../noul.ts).
 */
export interface GeminiOptions {
  url?: string;   // default: https://generativelanguage.googleapis.com/v1beta/decisions
  model?: string; // default: gemini-decision-1
}

/**
 * The largest state Gemini is sent, in characters: it reads 262 144 tokens,
 * input and questions together; at roughly four characters a token, 780 000
 * characters (~195k tokens) leaves room for the questions, as Jev's limit does.
 */
export const GEMINI_MAX_STATE_CHARS = 780_000;

export default function geminiJudge(opts: GeminiOptions = {}): JudgePlugin {
  return noulJudge({
    name: 'gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/decisions',
    model: 'gemini-decision-1',
    keyEnv: 'GEMINI_API_KEY',
    keyFile: '.config/gemini/key',
    headers: key => ({ 'x-goog-api-key': key }),
    inputField: 'input',
    criteriaFields: { yes: 'true_description', no: 'false_description' },
    rejectsKey: (status, text) => status === 401 || status === 403 || (status === 400 && text.includes('API_KEY_INVALID')),
    maxStateChars: GEMINI_MAX_STATE_CHARS,
  }, opts);
}
