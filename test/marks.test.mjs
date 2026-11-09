// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Contracts as promises (D16–18, D49–50, D55, D63–64): a flow's MARK binds
 * zones of the code to a spec and leaves each contract waiting; a
 * `DELEGATE <list> BY <agent>` starts every one of them in a copy of its own;
 * a WAIT takes them back, merges what was delivered and lands it. A real
 * project, the real `bundle all`, the agents' apx run as processes in one
 * session.
 *
 *   - the language: MARK's form and place, the list a declared variable, a
 *     DELEGATE of a list, WITHIN inside the work's perimeter, the retired
 *     STRATEGY / LEAD / CONTRACT, a STEP's BY and a bare PARALLEL
 *   - the apx: mark (spec checked, MAX), start (zones, one copy each), get,
 *     within, deliver from the copy, wait (merge and land), one registry
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { checkVocabulary, teamFileErrors } = await import('../dist/src/lint.js');
const { STATE_DIR } = await import('../dist/src/apx/paths.js');
const { fileCollection } = await import('../dist/src/storeDrivers/files/index.js');

const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${Array.isArray(lines) ? lines.join('\n') : lines}\n`); return file; };
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const messages = (file, body) => [...checkVocabulary(file, body), ...teamFileErrors(file, body)].map(e => `${e.line}: ${e.message}`).join('\n');

// --- the language: what a MARK and a DELEGATE of a list say, and what retired ---
{
  const team = body => ['EXPORT TEAM t:', '    ABOUT  a team', '    MEMBER a', '    FLOW f:', ...body].join('\n');
  const step = lines => team(['        STEP s:', ...lines.map(l => `            ${l}`)]);
  has(messages('/x/t.ap', step(['MARK one zone per screen INTO screens'])), 'MARK needs the spec of each zone');
  has(messages('/x/t.ap', step(['MARK one zone per screen AS spec'])), 'MARK needs the list its contracts make up');
  has(messages('/x/t.ap', step(['MARK one zone per screen INTO screens AS spec MAX lots'])), 'MAX is how many zones at most — a whole number');
  assert.equal(messages('/x/t.ap', step(['DELEGATE refactor BY a'])), '', 'a one-word task no MARK fills is a task');
  has(messages('/x/t.ap', step(['MARK one zone per screen INTO screens AS spec', 'DELEGATE screens BY a AS spec'])), 'every contract carries its spec, the AS of its MARK');
  has(messages('/x/t.ap', step(['MARK one zone per screen INTO screens AS spec', 'DELEGATE~ screens BY a'])), 'started with ~ and never waited for');
  assert.ok(!messages('/x/t.ap', step(['MARK one zone per screen INTO screens AS spec', 'DELEGATE~ screens BY a', 'WAIT screens'])).includes('screens'), 'a WAIT names the list');
  has(messages('/x/a.ap', ['EXPORT AGENT a AS r:', '    ABOUT x', '    MANDATE y', '    WHEN asked:', '        MARK one zone INTO z AS spec'].join('\n')), 'MARK binds zones of the code to contracts for a flow to hand out — it stands in a flow STEP');
  // The retired model names its rewrite.
  const retired = messages('/x/t.ap', ['EXPORT TEAM t:', '    ABOUT  a team', '    MEMBER a', '    STRATEGY  contracts', '    LEAD      a'].join('\n'));
  has(retired, 'STRATEGY was removed', 'LEAD was removed', '`MARK <criterion> INTO <list> AS <spec>`, then `DELEGATE <list> BY <agent>`');
  has(messages('/x/t.ap', ['EXPORT TEAM t:', '    ABOUT  a team', '    MEMBER a', '    CONTRACT c:', '        ABOUT x'].join('\n')), 'CONTRACT blocks were removed');
  // A STEP names no one — in a team's flow too; a bare PARALLEL is told its rewrite, not what it lacks.
  has(messages('/x/t.ap', step(['BY a', 'DO build it'])), 'BY is not allowed inside STEP — a step names no one');
  const bare = messages('/x/t.ap', step(['PARALLEL:', '    STEP x:', '        DO y']));
  has(bare, 'PARALLEL was removed — in one STEP, start each piece with `DELEGATE~');
  assert.ok(!bare.includes('needs its text on the same line'), bare);
  console.log('marks: language passed.');
}

// --- a real project: the flow marks two screens, hands both out, waits, and the work lands ---
const proj = mkdtempSync(join(tmpdir(), 'ap-marks-'));
const SESSION = 'marks-session';
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', input: opts.input, env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
};
const apx = (who, args, input) => run([join(proj, '.agent-pack', 'apx', `${who}.apx`), ...args], { input });
const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
const git = (...args) => { const r = spawnSync('git', args, { cwd: proj, encoding: 'utf-8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
try {
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '  mark: { max: 3 },', '};']);
  write(join(proj, 'library', 'templates', 'screen-spec.ap'), ['EXPORT TEMPLATE screen-spec:', '    ABOUT  what one screen does', '    SLOTS:', '        goal: TEXT  "what the screen does"', '    BODY:', '        {goal}']);
  write(join(proj, 'library', 'vars', 'flow-vars.ap'), ['EXPORT SESSION VAR screens']);
  write(join(proj, 'library', 'domains', 'web.ap'), ['EXPORT DOMAIN web:', '    ABOUT  the web app', '    WRITES IN src/**']);
  write(join(proj, 'library', 'domains', 'styles.ap'), ['EXPORT DOMAIN styles:', '    ABOUT  the styles', '    WRITES IN styles/**']);
  const team = join(proj, 'agents', 'teams', 'web');
  const agent = name => write(join(team, `${name}.ap`), [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work']);
  agent('lead'); agent('web-dev');
  const flow = within => ['IMPORT screen-spec FROM @main.templates', 'IMPORT screens FROM @main.vars', 'IMPORT web, styles FROM @main.domains', '',
    '@WITHIN web', 'EXPORT TEAM web:', '    ABOUT   builds the screens of the web app', '    MEMBER  lead, web-dev', '',
    '    WHEN asked to build the screens:', '        RUN build-screens', '',
    '    FLOW build-screens:', '        STEP mark the work:',
    `            MARK one zone per screen of the request INTO screens AS screen-spec${within}`,
    '        STEP build the screens:', '            DELEGATE~ screens BY web-dev', '            WAIT screens'];
  const teamFile = write(join(team, 'web.ap'), flow(' WITHIN styles'));
  write(join(proj, 'src', 'login.ts'), ['export function login() {', '  // agent-pack ctr-placeholder', '  return null;', '}']);
  write(join(proj, 'styles', 'app.css'), ['body {}']);
  write(join(proj, '.gitignore'), ['.agent-pack/', '.claude/', 'AGENTS.md']);
  git('init', '-q'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'dev');
  git('add', '-A'); git('commit', '-qm', 'start');

  // A WITHIN outside the work's perimeter: the flow is within web, styles is not.
  let r = run([CLI, 'bundle', 'all']);
  assert.notEqual(r.code, 0);
  has(r.out, 'MARK … WITHIN styles: the work here is within `web` — a contract\'s domain stays inside it');
  // A DELEGATE of a variable no MARK filled: an error, the variable being declared like any other (D63).
  write(teamFile, flow('').map(l => (l.includes('MARK ') ? '            DO read the request' : l)));
  r = run([CLI, 'bundle', 'all']);
  assert.notEqual(r.code, 0);
  has(r.out, 'DELEGATE screens: `screens` is a variable no MARK above it fills');
  write(teamFile, flow(''));
  ok(run([CLI, 'bundle', 'all']), 'bundle all');

  // The compiled flow names the commands, with the MARK's id.
  const flowOut = ok(apx('lead', ['ls', 'kind=flow']), 'ls');
  const flwId = flowOut.match(/(flw-[0-9a-f]{8})/)[1];
  const text = ok(apx('lead', ['get', flwId]), 'get flow');
  const mrk = text.match(/contract mark (mrk-[0-9a-f]{8})/)[1];
  has(text, `contract start ${mrk} --by web-dev`, `wait ${mrk}`, "At most the project's `mark.max` zones");
  // The perimeter is the project's hook (D65): in its settings, before and after every write — no agent carries one.
  has(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8'), 'PreToolUse', 'PostToolUse', 'claude-code-guard.mjs before', 'claude-code-guard.mjs after');
  assert.ok(!readFileSync(join(proj, '.claude', 'agents', 'web-dev.md'), 'utf-8').includes('hooks:'), 'no hook in the frontmatter');

  // Nothing marked yet: starting has nothing to start.
  has(ok(apx('lead', ['contract', 'start', mrk, '--by', 'web-dev']), 'start empty'), 'no zone was marked — nothing to start');

  // mark: the spec is checked against the MARK's AS; the list's variable holds the ids.
  r = apx('lead', ['contract', 'mark', mrk, '-'], '{"colour":"red"}');
  assert.equal(r.code, 6, r.out);
  has(r.out, 'the spec breaks the form of screen-spec');
  const a = ok(apx('lead', ['contract', 'mark', mrk, '-'], '{"goal":"the login form"}'), 'mark a').match(/^(ctr-[0-9a-f]{8})/m)[1];
  const b = ok(apx('lead', ['contract', 'mark', mrk, '-'], '{"goal":"the sign-up form"}'), 'mark b').match(/^(ctr-[0-9a-f]{8})/m)[1];
  has(ok(apx('lead', ['get', 'screens']), 'get screens'), a, b);
  // A third marks within the limit, a fourth does not: MAX from the config.
  ok(apx('lead', ['contract', 'mark', mrk, '-'], '{"goal":"a spare"}'), 'mark c');
  r = apx('lead', ['contract', 'mark', mrk, '-'], '{"goal":"one too many"}');
  assert.equal(r.code, 3, r.out);
  has(r.out, 'holds 3 zones already');

  // start: every contract needs a zone (no WITHIN here) — the spare has none, so nothing starts.
  write(join(proj, 'src', 'login.ts'), ['export function login() {', `  // agent-pack ${a}`, '  return null;', `  // agent-pack end ${a}`, '}']);
  write(join(proj, 'src', 'signup.ts'), ['export function signup() {', `  // agent-pack ${b}`, '  return null;', `  // agent-pack end ${b}`, '}']);
  git('add', '-A'); git('commit', '-qm', 'marks');
  r = apx('lead', ['contract', 'start', mrk, '--by', 'web-dev']);
  assert.equal(r.code, 3, r.out);
  has(r.out, 'refused: ', 'no zone is marked', 'nothing was started');
  // The spare is blocked out of the way by whoever marked it: only a running piece moves — so mark it a zone instead.
  const spare = fileCollection(join(proj, STATE_DIR, SESSION, 'delegations.json'), 'dlg').find([{ field: 'state', op: '=', value: 'marked' }]).map(x => x.dlg).find(id => id !== a && id !== b);
  write(join(proj, 'src', 'spare.ts'), [`// agent-pack ${spare}`, 'export const spare = 0;', `// agent-pack end ${spare}`]);
  git('add', '-A'); git('commit', '-qm', 'spare');
  const started = ok(apx('lead', ['contract', 'start', mrk, '--by', 'web-dev']), 'start');
  has(started, `${a}  → web-dev`, `${b}  → web-dev`, '3 contracts started');

  // get: the worker reads its spec and its copy.
  const got = ok(apx('web-dev', ['contract', 'get', a]), 'get');
  has(got, 'the login form', 'copy: ', `delegate deliver ${a}`);
  const copy = got.match(/^copy: (.+)$/m)[1];

  // The worker writes inside its zone and a new file — its own; a file that was there and holds no zone of it is left out.
  write(join(proj, copy, 'src', 'login.ts'), ['export function login() {', `  // agent-pack ${a}`, '  return { ok: true };', `  // agent-pack end ${a}`, '}']);
  write(join(proj, copy, 'src', 'login.css.ts'), ['export const css = "";']);
  write(join(proj, copy, 'styles', 'app.css'), ['body { color: red }']);
  r = apx('web-dev', ['contract', 'within', a, 'styles/app.css']);
  assert.equal(r.code, 3, r.out);
  has(r.out, 'it will be left out of the delivery');
  assert.equal(apx('web-dev', ['contract', 'within', a, 'src/login.css.ts']).code, 0, 'a file it created is its own');
  // The hook's guard: in the copy, before a write it lets it be; after, it asks the contract — outside the copy, its assignee is stopped.
  const guard = (...args) => apx('web-dev', ['guard', ...args, '--agent', 'web-dev', '--subagent']);
  assert.equal(guard(`${copy}/styles/app.css`).code, 0, 'before a write in its copy: the contract checks after');
  r = guard(`${copy}/styles/app.css`, '--after');
  assert.equal(r.code, 3, r.out);
  has(r.out, 'it will be left out of the delivery');
  r = guard('src/login.ts');
  assert.equal(r.code, 3, r.out);
  has(r.out, 'src/login.ts:', `web-dev carries out ${a} in its copy`, 'say so in your delivery');
  r = apx('web-dev', ['delegate', 'deliver', a]);
  assert.equal(r.code, 3, r.out);
  has(r.out, 'left out: styles/app.css', '--why');
  has(ok(apx('web-dev', ['delegate', 'deliver', a, '--why', 'a note for the lead']), 'deliver a'), `${a}  delivered`);

  // b is blocked, the spare ends without delivery: a WAIT returns when each one is settled, and lands what was delivered.
  ok(apx('web-dev', ['delegate', 'block', b, 'the sign-up spec is ambiguous']), 'block b');
  ok(apx('lead', ['delegate', 'ended', spare]), 'ended spare');
  r = apx('lead', ['wait', mrk, '--max', '5s']);
  assert.equal(r.code, 1, r.out);
  has(r.out, `${a}  screens  merged`, `${b}  screens  blocked`, 'ended without delivery', 'landed in the working folder: src/login.css.ts, src/login.ts', 'you decide');
  has(readFileSync(join(proj, 'src', 'login.ts'), 'utf-8'), 'return { ok: true };');
  assert.ok(!readFileSync(join(proj, 'src', 'signup.ts'), 'utf-8').includes('ok: true'));
  // After its WAIT, `{{screens}}` reads each contract's state (D50) — what an `IF {{screens}} has a blocked screen` judges.
  const states = ok(apx('lead', ['get', 'screens']), 'get screens after the wait');
  has(states, `{"id":"${a}","state":"merged"}`, `{"id":"${b}","state":"blocked","reason":"the sign-up spec is ambiguous"}`, `{"id":"${spare}","state":"ended without delivery"}`);

  // One registry: the contracts sit beside any background piece, and `delegate list` shows them.
  const all = ok(apx('lead', ['delegate', 'list']), 'list');
  has(all, a, b, spare);
  assert.ok(!all.includes('.json'));
  console.log('marks: mark, start, deliver, wait passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
