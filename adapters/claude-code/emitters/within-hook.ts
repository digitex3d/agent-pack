// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The warning a member of a team of contracts gets from Claude Code as soon as
 * it writes, in its copy, outside what its contract admits — a `PostToolUse`
 * hook in its frontmatter, so no other agent and no settings file carries it.
 * The hook never touches the write: it asks the agent's apx (`contract within`)
 * and hands its words back as `additionalContext`. What Claude Code sends and
 * expects is this file's alone; the check is the apx's.
 */
import { RUNTIME_DIR, WORK_DIR, APX_DIR } from '../../../src/apx/paths.js';
import { resolve } from 'path';
import type { ApDocument } from '../../../src/apdoc/document.js';
import type { TeamBlock } from '../../../src/apdoc/blocks.js';

/** Where the hook's script is written, from the project root. */
export const WITHIN_HOOK = `${RUNTIME_DIR}/hooks/claude-code-within.mjs`;

/** Whether an agent works in copies — a member, or the lead, of a team of contracts. */
export function worksInCopies(doc: ApDocument | undefined): boolean {
  return (doc?.byKind('team')[0] as TeamBlock | undefined)?.strategy === 'contracts';
}

/** The hook's script, for an agent that works in copies — written beside its definition by every Claude Code adapter. */
export function withinHookFiles(doc: ApDocument | undefined, projectRoot: string): { path: string; content: string }[] {
  return worksInCopies(doc) ? [{ path: resolve(projectRoot, WITHIN_HOOK), content: withinHookScript() }] : [];
}

/** The `hooks:` lines of the agent's frontmatter — YAML, indented as Claude Code reads it. */
export function withinHookYaml(agent: string): string[] {
  return [
    'hooks:',
    '  PostToolUse:',
    '    - matcher: "Write|Edit|MultiEdit"',
    '      hooks:',
    '        - type: command',
    `          command: node "$CLAUDE_PROJECT_DIR"/${WITHIN_HOOK} ${agent}`,
  ];
}

/** The hook's script: from the path written, the instance and the file; silent unless the apx says it is outside. */
export function withinHookScript(): string {
  return `// Written by agent-pack (adapter claude-code) — do not edit: \`agent-pack bundle all\` writes it again.
// A PostToolUse hook: when an agent of a team of contracts writes in its copy, it asks the
// agent's apx whether the file stays within the contract, and hands the warning back.
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, relative, sep } from 'path';

const agent = process.argv[2];
let input;
try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
const file = input?.tool_input?.file_path;
const project = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
if (!agent || !project || typeof file !== 'string') process.exit(0);
const rel = relative(project, file).split(sep).join('/');
const prefix = '${WORK_DIR}/';
if (!rel.startsWith(prefix)) process.exit(0);
const [ctr, ...inCopy] = rel.slice(prefix.length).split('/');
if (!/^ctr-[0-9a-f]{8}$/.test(ctr) || inCopy.length === 0) process.exit(0);
const r = spawnSync(process.execPath, [join(project, '${APX_DIR}', \`\${agent}.apx\`), 'contract', 'within', ctr, inCopy.join('/')], {
  cwd: project, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID || input.session_id || '' },
});
if (r.status !== 3) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: (r.stdout || '').trim() } }));
`;
}
