// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The perimeter, kept before every write (D65) — a real project, the real
 * `bundle all`, the apx's `guard` and the Claude Code hook script run as the
 * harness runs them:
 *
 *   - a piece started in the background carries its perimeter: its step's
 *     `@WITHIN`, its assignee's own
 *   - a subagent named as a piece's assignee is held to it; one that cannot
 *     be told apart, to every piece in progress; the main conversation to none
 *   - a domain that only READS writes nothing; every agent keeps its own `@WITHIN`
 *   - the hook lives in `.claude/settings.json`, beside what the developer wrote
 *     there, once; it goes when no agent works under a perimeter
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };

const proj = mkdtempSync(join(tmpdir(), 'ap-guard-'));
const SESSION = 'guard-session';
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', input: opts.input, env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: proj } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd(), stdout: r.stdout };
};
const apx = (args, input) => run([join(proj, '.agent-pack', 'apx', 'lead.apx'), ...args], { input });
const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
const bundle = () => ok(run([CLI, 'bundle', 'all']), 'bundle all');
const guard = (path, ...flags) => apx(['guard', path, ...flags]);
const team = join(proj, 'agents', 'teams', 'site');
const agent = (name, within) => write(join(team, `${name}.ap`), [
  ...(within ? [`IMPORT ${within} FROM @main.domains`, '', `@WITHIN ${within}`] : []),
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work',
]);

try {
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
  write(join(proj, 'src', 'web', 'app.ts'), ['export const app = 1;']);
  write(join(proj, 'docs', 'guide.md'), ['# guide']);
  write(join(proj, 'library', 'domains', 'web.ap'), ['EXPORT DOMAIN web:', '    ABOUT  the web app', '    WRITES IN src/web/**']);
  write(join(proj, 'library', 'domains', 'docs.ap'), ['EXPORT DOMAIN docs:', '    ABOUT  the documentation, read only', '    READS IN docs/**']);
  write(join(proj, 'library', 'vars', 'site.ap'), ['EXPORT SESSION VAR built', 'EXPORT SESSION VAR read', 'EXPORT SESSION VAR sketch']);
  // The developer's own settings: they stay as they are.
  write(join(proj, '.claude', 'settings.json'), [JSON.stringify({
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }, null, 2)]);
  agent('lead'); agent('builder', 'web'); agent('reader', 'docs'); agent('helper');
  write(join(team, 'site.ap'), teamSource('site', ['lead', 'builder', 'reader', 'helper'], [
    'IMPORT built, read, sketch FROM @main.vars',
    'IMPORT web FROM @main.domains',
    'ABOUT  builds the site',
    'WHEN asked to build:',
    '    RUN build',
    'FLOW build:',
    '    STEP build and read:',
    '        DELEGATE~ build the page INTO built BY builder',
    '        DELEGATE~ read the guide INTO read BY reader',
    '        WAIT built, read',
    '    @WITHIN web',
    '    STEP sketch:',
    '        FORK~ sketch the next page INTO sketch',
    '        WAIT sketch',
  ]));
  bundle();

  // --- the settings: the hook once, beside the developer's own ---
  const settings = () => JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8'));
  let s = settings();
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'the rest of the file is left as it was');
  assert.equal(s.hooks.PreToolUse.length, 2, 'the developer\'s hook, then agent-pack\'s');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  has(JSON.stringify(s.hooks.PreToolUse[1]), 'Write|Edit|MultiEdit|NotebookEdit', 'claude-code-guard.mjs before');
  has(JSON.stringify(s.hooks.PostToolUse), 'claude-code-guard.mjs after');
  assert.ok(existsSync(join(proj, '.agent-pack', 'hooks', 'claude-code-guard.mjs')), 'the script beside it');
  const again = run([CLI, 'bundle', 'all']);
  assert.ok(!again.out.includes('settings.json →'), `a second build leaves it as it is:\n${again.out}`);
  assert.deepEqual(settings(), s, 'idempotent');
  console.log('guard: settings passed.');

  // --- the flow's ids, from the compiled flow ---
  const flw = ok(apx(['ls', 'kind=flow']), 'ls').match(/(flw-[0-9a-f]{8})/)[1];
  const text = ok(apx(['get', flw]), 'get flow');
  const [builtId, readId, sketchId] = [...text.matchAll(/delegate start (dlg-[0-9a-f]{8})/g)].map(m => m[1]);
  assert.ok(builtId && readId && sketchId, text);

  // --- nothing in progress: only an agent's own @WITHIN holds ---
  assert.equal(guard('src/api/x.ts', '--subagent').code, 0, 'no work in progress, no agent named: nothing to keep');
  let r = guard('src/api/x.ts', '--agent', 'builder', '--subagent');
  assert.equal(r.code, 3, r.out);
  has(r.out, 'src/api/x.ts: outside builder\'s own perimeter (src/web/**)', 'say so in your delivery');
  assert.equal(guard('src/web/new.ts', '--agent', 'builder', '--subagent').code, 0);
  // In a contract's copy, which mirrors the project root, the path inside the copy is what its own @WITHIN judges.
  const inCopy = p => `.agent-pack/work/ctr-0123abcd/${p}`;
  r = guard(inCopy('src/web/new.ts'), '--agent', 'builder', '--subagent');
  assert.equal(r.code, 0, `within its own perimeter, in a copy:\n${r.out}`);
  r = guard(inCopy('src/api/x.ts'), '--agent', 'builder', '--subagent');
  assert.equal(r.code, 3, r.out);
  has(r.out, `${inCopy('src/api/x.ts')}: outside builder's own perimeter (src/web/**)`);
  r = guard('docs/guide.md', '--agent', 'reader', '--subagent');
  assert.equal(r.code, 3, 'a domain that only READS writes nothing');
  has(r.out, 'it writes nothing');
  assert.equal(guard('anything.txt', '--agent', 'helper', '--subagent').code, 0, 'an agent with no @WITHIN has no perimeter');

  // --- two pieces in progress: each assignee is held to its own; a writer no piece names, to both ---
  ok(apx(['delegate', 'start', builtId]), 'start built');
  ok(apx(['delegate', 'start', readId]), 'start read');
  assert.equal(guard('src/web/page.ts', '--agent', 'builder', '--subagent').code, 0, 'builder, within its piece');
  r = guard('src/web/page.ts', '--subagent');
  assert.equal(r.code, 3, 'a subagent it cannot tell apart: every piece in progress holds');
  has(r.out, `the work in progress ${readId}`, 'could not be told apart from it', 'it writes nothing');
  assert.equal(guard('src/api/x.ts').code, 0, 'the main conversation — whoever runs the flow — is held to none');

  // --- the fork works within its step's @WITHIN ---
  ok(apx(['delegate', 'deliver', readId, '-'], 'read'), 'deliver read');
  ok(apx(['delegate', 'deliver', builtId, '-'], 'built'), 'deliver built');
  ok(apx(['delegate', 'start', sketchId]), 'start sketch');
  assert.equal(guard('src/web/next.ts', '--subagent').code, 0, 'the fork, within web');
  r = guard('docs/next.md', '--subagent');
  assert.equal(r.code, 3, r.out);
  has(r.out, `the work in progress ${sketchId} (sketch)`, 'src/web/**');
  // Handed to another agent, a piece takes that agent's perimeter as well.
  ok(apx(['delegate', 'reassign', sketchId, 'reader']), 'reassign');
  r = guard('src/web/next.ts', '--agent', 'reader', '--subagent');
  assert.equal(r.code, 3, 'reader carries it out now: its own domain writes nothing');
  ok(apx(['delegate', 'deliver', sketchId, '-'], 'sketch'), 'deliver sketch');
  console.log('guard: pieces and perimeters passed.');

  // --- the hook script, as Claude Code runs it ---
  const hook = (moment, input) => run([join(proj, '.agent-pack', 'hooks', 'claude-code-guard.mjs'), moment], { input: JSON.stringify(input) });
  const event = (extra, file) => ({ session_id: SESSION, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(proj, file) }, ...extra });
  r = hook('before', event({ agent_id: 'a1', agent_type: 'builder' }, 'src/api/x.ts'));
  assert.equal(r.code, 0, r.out);
  const denied = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, 'deny');
  has(denied.permissionDecisionReason, "outside builder's own perimeter");
  r = hook('before', event({ agent_id: 'a1', agent_type: 'builder' }, 'src/web/ok.ts'));
  assert.equal(r.stdout, '', 'within: the hook says nothing');
  r = hook('before', event({}, 'src/api/x.ts'));
  assert.equal(r.stdout, '', 'the main conversation writes freely');
  // An input it cannot read stops the write before it happens, and is let be after it (fail closed).
  const script = join(proj, '.agent-pack', 'hooks', 'claude-code-guard.mjs');
  r = run([script, 'before'], { input: 'not json' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', 'unreadable input: denied');
  assert.equal(run([script, 'after'], { input: 'not json' }).stdout, '', 'after a write there is nothing to stop');
  console.log('guard: hook script passed.');

  // --- no agent under a perimeter: the hook goes, the developer's stays ---
  for (const name of ['builder', 'reader']) agent(name);
  write(join(team, 'site.ap'), teamSource('site', ['lead', 'builder', 'reader', 'helper'], [
    'ABOUT  builds the site', 'WHEN asked to build:', '    RUN build', 'FLOW build:', '    STEP build:', '        DELEGATE build the page BY builder',
  ]));
  has(bundle(), 'perimeter hook removed');
  s = settings();
  assert.deepEqual(s.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] }, 'only the developer\'s hook is left');
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  console.log('guard: removal passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
