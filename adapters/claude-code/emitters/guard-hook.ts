// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The perimeter, kept by Claude Code (D65): one hook of the project, in
 * `.claude/settings.json`, that asks the apx before every write and stops one
 * outside the perimeter of the work in progress — for the main conversation
 * and, the settings' hooks running inside subagents too, for every agent it
 * hands work to. After a write in a contract's copy, the same script asks
 * whether the file stays within the contract, and hands the warning back.
 *
 * What Claude Code sends and expects is this file's alone: `agent_id` and
 * `agent_type` in the hook's input say a subagent writes, and which one;
 * `permissionDecision: "deny"` stops the write. The check is the apx's
 * (`guard`, src/apx/engine.ts).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { RUNTIME_DIR, APX_DIR } from '../../../src/apx/paths.js';

/** Where the hook's script is written, from the project root. */
export const GUARD_HOOK = `${RUNTIME_DIR}/hooks/claude-code-guard.mjs`;

/** The project settings Claude Code reads its hooks from. */
export const SETTINGS_FILE = '.claude/settings.json';

/** The tools that write a file. */
const WRITE_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit';

/** The command of one of the hook's two moments. */
const command = (moment: 'before' | 'after') => `node "$CLAUDE_PROJECT_DIR"/${GUARD_HOOK} ${moment}`;

/** Whether a hook entry of the settings is agent-pack's — the one it writes and removes. */
const isOurs = (entry: unknown): boolean =>
  JSON.stringify(entry ?? '').includes(GUARD_HOOK);

/**
 * Install the hook in the project's settings when some agent works under a
 * perimeter, remove it when none does — only agent-pack's own entries, the
 * rest of the file as it is. Returns the files written; a settings file that
 * is not JSON is left alone, and said.
 */
export function installGuardHook(projectRoot: string, needed: boolean): { touched: string[]; problem: string | null } {
  const file = resolve(projectRoot, SETTINGS_FILE);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed;
    } catch {
      return { touched: [], problem: `${SETTINGS_FILE} is not a JSON object — the perimeter hook was not ${needed ? 'installed' : 'removed'}; fix the file and bundle again` };
    }
  } else if (!needed) return { touched: [], problem: null };
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? { ...(settings.hooks as Record<string, unknown[]>) } : {}) as Record<string, unknown[]>;
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(e => !isOurs(e));
    if (needed) kept.push({ matcher: WRITE_TOOLS, hooks: [{ type: 'command', command: command(event === 'PreToolUse' ? 'before' : 'after') }] });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next = { ...settings, ...(Object.keys(hooks).length > 0 ? { hooks } : {}) };
  if (Object.keys(hooks).length === 0) delete (next as Record<string, unknown>).hooks;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const touched: string[] = [];
  if (!existsSync(file) || readFileSync(file, 'utf-8') !== text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    touched.push(SETTINGS_FILE);
  }
  if (needed) {
    const script = resolve(projectRoot, GUARD_HOOK);
    if (!existsSync(script) || readFileSync(script, 'utf-8') !== guardHookScript()) {
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, guardHookScript());
      touched.push(GUARD_HOOK);
    }
  }
  return { touched, problem: null };
}

/** The hook's script: before a write, the apx's `guard` decides; after one in a contract's copy, it warns. */
export function guardHookScript(): string {
  return `// Written by agent-pack (adapter claude-code) — do not edit: \`agent-pack bundle all\` writes it again.
// Before every write, asks an apx whether the file stays within the perimeter of the work in
// progress in this session, and stops it when it does not (D65). After a write in a contract's
// copy, asks whether the file stays within the contract, and hands the warning back.
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

const moment = process.argv[2];
let input;
// An input it cannot read is a check it cannot make: before a write, that stops the write (fail closed).
try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch {
  if (moment !== 'after') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'agent-pack could not read the hook input, so it could not check the perimeter of this write' } }));
  process.exit(0);
}
const tool = input?.tool_input ?? {};
const file = tool.file_path ?? tool.notebook_path;
const project = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
if (!project || typeof file !== 'string') process.exit(0);
const apxDir = join(project, '${APX_DIR}');
if (!existsSync(apxDir)) process.exit(0);
// The writer's own apx when it is an agent of the project; any other one reads the same session.
const who = typeof input.agent_type === 'string' ? input.agent_type : '';
const any = readdirSync(apxDir).filter(f => f.endsWith('.apx')).sort()[0];
const apx = who && existsSync(join(apxDir, who + '.apx')) ? join(apxDir, who + '.apx') : any && join(apxDir, any);
if (!apx) process.exit(0);
const rel = relative(project, file).split(sep).join('/');
const args = ['guard', rel, ...(who ? ['--agent', who] : []), ...(input.agent_id ? ['--subagent'] : []), ...(moment === 'after' ? ['--after'] : [])];
const r = spawnSync(process.execPath, [apx, ...args], {
  cwd: project, encoding: 'utf-8',
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID || input.session_id || '' },
});
const said = ((r.stdout || '') + (r.stderr || '')).trim();
if (r.status === 0) process.exit(0);
if (moment === 'after') {
  if (r.status === 3) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: said } }));
  process.exit(0);
}
// Before a write: outside the perimeter, or the check itself failed — either way the write does not happen (fail closed).
const reason = r.status === 3 ? said : 'agent-pack could not check the perimeter of this write: ' + (said || 'the apx did not answer');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
`;
}
