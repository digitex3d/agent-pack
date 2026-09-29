// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { FORMULAS, introOf } from './formulas.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { lex } from './lexer.js';
import { stripAbout } from './services/text.js';
import { teamRootForAgentFile } from './services/teamMetadata.js';

/**
 * Strip only a leading `ABOUT …` metadata line (and the blank line after it),
 * preserving everything else — including markdown headings (`# Mission`).
 *
 * Deliberately split from the lexer-based {@link stripAbout}: that stripper
 * classifies `#` lines as comments and drops them, which is correct for `.ap`
 * source but wrong for a `team.ap` shared block, which is authored as plain
 * markdown and injected verbatim — its `#` headings must survive. The two form
 * a matched pair; keep them in sync.
 */
function stripAboutPreservingMarkdown(content: string): string {
  return content.replace(/^[ \t]*ABOUT[ \t]+[^\n]*\n+/, '');
}


/** Filename of a team's shared block, injected into every member's bundle. */
export const TEAM_SHARED_FILE = 'team.ap';

/**
 * Bundle switches: `runtime` (on) — the agent-kind introduction ahead of every
 * bundle; `apxCompress` (off) — the apx data line gzipped instead of compact
 * JSON (`bundle --apx-compress` / `--no-apx-compress` override it).
 */
export function defaultBundleConfig(): Record<string, boolean> {
  return { runtime: true, apxCompress: false };
}

/**
 * Resolve the framework defaults injected ahead of every bundle (the
 * agent-pack runtime). Project- and team-scoped shared blocks are resolved
 * elsewhere — see {@link resolveTeamShared} — because they are keyed off the
 * agent's location, not a fixed framework path.
 */
export function resolveBundleDefaults(
  bundleConfig: Record<string, boolean>,
): string {
  if (bundleConfig.runtime === false) return '';
  return `${FORMULAS.blocks.runtime.heading}\n\n${introOf('agent')}\n\n`;
}

/**
 * True when the file carries no compilable content — every non-blank token the
 * lexer emits is a comment (an inert, stub-only file). Reuses the lexer's
 * comment classification so "what is a comment" stays defined once, in the
 * lexer.
 */
function isCommentOnly(content: string): boolean {
  return lex(content)
    .filter(token => token.kind !== 'blank')
    .every(token => token.kind === 'comment');
}

/**
 * Resolve the shared block injected into every member of an agent's team: the
 * optional `team.ap` file at the team root, sibling of `flows.ap`. The content
 * is injected verbatim (a leading ABOUT line stripped, no section header) — the
 * same shape the project-wide shared block used to take, now scoped to one
 * team. Markdown headings the author writes (e.g. `# Mission`) are preserved.
 *
 * Returns '' for a standalone agent, a team with no `team.ap`, an empty file,
 * or a comment-only file (the scaffolded stub is inert until edited). The file
 * is optional: a missing `team.ap` is a no-op, never an error.
 *
 * Scope is team-only by design. The project level receives no injected shared
 * block; a future project scope would be a second resolution appended here.
 *
 * Takes the agent's `.ap` FILE path: its team root is the file's own directory
 * when that holds a `flows.ap`, else the agent is standalone.
 */
export function resolveTeamShared(agentFilePath: string): string {
  const teamRoot = teamRootForAgentFile(agentFilePath);
  if (!teamRoot) return '';

  const file = resolve(teamRoot, TEAM_SHARED_FILE);
  if (!existsSync(file)) return '';

  const content = stripAboutPreservingMarkdown(readFileSync(file, 'utf-8')).trim();
  if (!content || isCommentOnly(content)) return '';
  return `${content}\n\n`;
}
