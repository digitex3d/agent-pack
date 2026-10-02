// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { lex } from './lexer.js';
import { parseVarLine, type VarScope } from './vars.js';
import { teamRootForAgentFile } from './services/teamMetadata.js';
import type { LintError } from './lint.js';

/**
 * `vars.ap` — the declarations of variables (D32, I7), one file per level: the
 * project root, a team's folder, an agent's folder. Only `VAR` lines:
 *
 *   VAR board = Product                  a constant, substituted at compile time
 *   VAR draft                            a private variable — an agent's vars.ap only
 *   SESSION VAR plan AS impl-plan        shared by the session's agents — a team's or the project's
 *
 * A constant at a deeper level overrides the same name above it (project <
 * team < agent); a variable is declared once, anywhere — a second declaration
 * is an error. The grammar of a line is `parseVarLine`'s; which scope a level
 * takes, `scopeLevelError`'s.
 */

/** The file name, at every level. */
export const VARS_FILE = 'vars.ap';

/** Whether a path is a vars.ap. */
export function isVarsFile(path: string): boolean {
  return basename(path) === VARS_FILE;
}

/** Where a vars.ap sits — how far its declarations reach. */
export type VarsLevel = 'project' | 'team' | 'agent';

/** A vars.ap of one level. */
export interface VarsFile {
  path: string;
  level: VarsLevel;
}

/** A variable as a vars.ap declares it: its name, scope, template (or none), and where. */
export interface VariableDecl {
  name: string;
  scope: VarScope;
  type: string | null;
  file: string;
  line: number;
}

/** A variable of a vars.ap, with the level it sits at: `vars.ap (team)`. */
export type PlacedVariable = VariableDecl & { where: string };

/** A vars.ap, read: its constants, its variables, and what is wrong with it. */
export interface VarsAp {
  constants: Record<string, string>;
  variables: VariableDecl[];
  errors: LintError[];
}

/**
 * Why a variable of `scope` may not be declared at `level`, or null when it
 * may: a private one belongs to one agent — its own vars.ap; a SESSION one is
 * shared — a team's or the project's vars.ap, where every reader sees it.
 */
export function scopeLevelError(scope: VarScope, level: VarsLevel): string | null {
  if (scope === 'private' && level !== 'agent') {
    return `a private variable belongs to one agent — declare it in the agent's ${VARS_FILE} or body, or write SESSION VAR`;
  }
  if (scope === 'session' && level === 'agent') {
    return `a SESSION variable is shared — declare it in a team's or the project's ${VARS_FILE}, where every agent that reads it sees it`;
  }
  return null;
}

/** Parse — and lint — the `VAR` lines of a vars.ap. Nothing else may stand in it. */
export function parseVarsAp(content: string, file: string = VARS_FILE): VarsAp {
  const out: VarsAp = { constants: {}, variables: [], errors: [] };
  const err = (line: number, message: string) => out.errors.push({ file, line, message });
  const seen = new Map<string, number>();
  for (const t of lex(content)) {
    if (t.kind === 'blank' || t.kind === 'comment') continue;
    const decl = t.kind === 'keyword' && t.indent === 0 ? parseVarLine(t.keyword, t.rest) : null;
    if (!decl) {
      err(t.line, `${VARS_FILE} holds only VAR lines at the start of the line: "${('raw' in t ? t.raw : '').trim()}"`);
      continue;
    }
    if ('error' in decl) { err(t.line, decl.error); continue; }
    const first = seen.get(decl.name);
    if (first !== undefined) { err(t.line, `\`${decl.name}\` is declared twice in ${VARS_FILE} (first at line ${first})`); continue; }
    seen.set(decl.name, t.line);
    if (decl.form === 'constant') {
      out.constants[decl.name] = decl.value;
    } else if (decl.block) {
      err(t.line, `\`${decl.name}:\` assigns a block's outcome while the agent works — it goes in a body, never in ${VARS_FILE}`);
    } else {
      out.variables.push({ name: decl.name, scope: decl.scope, type: decl.type, file, line: t.line });
    }
  }
  return out;
}

/**
 * The vars.ap files an agent reads, outermost first: the project's, its team's,
 * its own folder's — those that exist, each once (a team member's folder is its
 * team's: that file is the team's).
 */
export function varsFilesFor(agentFile: string, projectRoot: string): VarsFile[] {
  const levels: [string | null, VarsLevel][] = [[projectRoot, 'project'], [teamRootForAgentFile(agentFile), 'team'], [dirname(agentFile), 'agent']];
  const files: VarsFile[] = [];
  for (const [dir, level] of levels) {
    const path = dir ? resolve(dir, VARS_FILE) : null;
    if (path && existsSync(path) && !files.some(f => f.path === path)) files.push({ path, level });
  }
  return files;
}
