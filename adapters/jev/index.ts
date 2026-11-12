// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { noulJudge } from '../noul.js';
import type { JudgePlugin } from '../../src/judge/types.js';

/**
 * Jev (TypeSafe AI) as the judge — the only place that knows Jev.
 *
 * `POST /v1/systemone`, the line as `state`, the key as a Bearer token from
 * `TYPESAFE_API_KEY` or `~/.config/typesafe/key`. The model is `jev-latest`
 * until the caller pins the version Jev reported (e.g. `jev-1.13.0`), which
 * the direct API accepts as `model`. The rest is every decisions API's (../noul.ts).
 */
export interface JevOptions {
  url?: string;   // default: https://api.typesafe.ai/v1/systemone
  model?: string; // default: jev-latest
}

/**
 * The largest state Jev is sent, in characters: Jev reads about 32k tokens; at
 * roughly four characters a token, 96 000 characters (~24k tokens) leaves room
 * for the questions and the model's own framing.
 */
export const JEV_MAX_STATE_CHARS = 96_000;

export default function jevJudge(opts: JevOptions = {}): JudgePlugin {
  return noulJudge({
    name: 'jev',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    keyEnv: 'TYPESAFE_API_KEY',
    keyFile: '.config/typesafe/key',
    headers: key => ({ Authorization: `Bearer ${key}` }),
    inputField: 'state',
    criteriaFields: { yes: 'true', no: 'false' },
    maxStateChars: JEV_MAX_STATE_CHARS,
  }, opts);
}
