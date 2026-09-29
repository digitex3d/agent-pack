// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { lex } from './lexer.js';

/**
 * Per S9: vars live in a dedicated `vars.ap` file co-located with the
 * consumer (project / team / agent). The file uses one or more
 * `VAR <key> = <value>` lines.
 *
 * Vars are interpolated into source via the existing `{{key}}` substitution
 * (see `src/vars.ts:applyVars`). This module is the parser/loader bridging
 * the file format to the var map.
 *
 * No hierarchy / override semantics yet: callers merge the maps in their
 * own order if they need it.
 */

const VAR_LINE_RE = /^([A-Za-z_]\w*)\s*=\s*(.*)$/;

/** Parse `VAR <key> = <value>` lines from a source string. */
export function parseVarsAp(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of lex(content)) {
    if (t.kind !== 'keyword' || t.keyword !== 'VAR' || t.indent !== 0) continue;
    const m = t.rest.match(VAR_LINE_RE);
    if (!m) continue;
    out[m[1]] = stripQuotes(m[2].trim());
  }
  return out;
}

/** Read and parse `<dir>/vars.ap` if present; otherwise return empty map. */
export function loadVarsAp(dir: string): Record<string, string> {
  const p = resolve(dir, 'vars.ap');
  if (!existsSync(p)) return {};
  return parseVarsAp(readFileSync(p, 'utf-8'));
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1);
  }
  return s;
}
