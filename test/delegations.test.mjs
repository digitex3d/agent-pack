// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx's registry of background work (D47, D48, D52, D53) — a real
 * project, the real `bundle all`, the lead's apx run as a process in one
 * session:
 *
 *   - the compiled flow names the commands: `delegate start|deliver|block`
 *     on each `DELEGATE~`, `wait <ids> [--max]` on each WAIT
 *   - start, deliver (into its variable), block, ended, take, reassign, list
 *   - wait: delivered / blocked / ended return at once; one still running is
 *     left as it is at the limit; each one's state, exit 0 only when all
 *     were delivered
 *   - `WAIT … MAX <duration>` and the `wait.max` config key, checked
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { teamSource } from './helpers/team.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { lintFile } = await import('../dist/src/lint.js');
const { parseWait, parseDuration } = await import('../dist/src/delegation.js');

const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };

// --- the forms: a WAIT's MAX, a duration ---
assert.deepEqual(parseWait('style, tests MAX 10m'), { names: ['style', 'tests'], max: '10m' });
assert.deepEqual(parseWait('ALL'), { all: true, max: null });
assert.equal(parseDuration('90s'), 90_000);
assert.equal(parseDuration('2h'), 7_200_000);
for (const bad of ['10', '0m', '1.5h', 'ten minutes', '5d']) assert.equal(parseDuration(bad), null, bad);

const proj = mkdtempSync(join(tmpdir(), 'ap-delegations-'));
const SESSION = 'delegations-session';
const config = wait => write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',",
  "  adapters: ['claude-code'],", ...(wait ? [`  wait: ${wait},`] : []), '};']);
const team = join(proj, 'agents', 'teams', 'review');
const flow = (...waits) => write(join(team, 'review.ap'), teamSource('review', ['lead', 'checker-a', 'checker-b'], [
  'IMPORT style FROM @main.vars',
  'ABOUT  reviews a change',
  'WHEN asked to review a change:',
  '    RUN review-change',
  'FLOW review-change:',
  '    STEP check:',
  '        DELEGATE~ check the style INTO style BY checker-a',
  '        DELEGATE~ check the tests BY checker-b',
  ...waits,
]));
const bundle = () => {
  const r = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, encoding: 'utf-8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const apx = (args, stdin) => {
  const r = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'lead.apx'), ...args],
    { cwd: proj, encoding: 'utf-8', input: stdin, env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
};

try {
  write(join(proj, 'library', 'vars', 'style.ap'), ['EXPORT SESSION VAR style']);
  for (const name of ['lead', 'checker-a', 'checker-b']) {
    write(join(team, `${name}.ap`), [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '',
      `ROLE ${name}-role:`, '    ABOUT   a reviewer', '    ALWAYS  read the change']);
  }

  // --- a WAIT's MAX is a duration; the config's wait.max too ---
  const lint = (...waits) => lintFile(join(team, 'review.ap'), readFileSync(flow(...waits), 'utf-8')).map(e => e.message);
  has(lint('        WAIT ALL MAX 5x').join('\n'), 'WAIT … MAX 5x: a duration is a whole number and its unit');
  has(lint('        WAIT ALL MAX').join('\n'), 'WAIT … MAX: say how long');
  config("{ max: 'soon' }");
  flow('        WAIT ALL');
  let r = bundle();
  assert.notEqual(r.code, 0);
  has(r.out, 'wait.max must be a duration');

  // --- the compiled flow names the registry's commands ---
  config("{ max: '2s' }");
  flow('        WAIT style', '        WAIT ALL MAX 1s');
  r = bundle();
  assert.equal(r.code, 0, r.out);
  // The lead runs the flow from its apx: the flow's text there names the commands.
  const flw = readFileSync(join(proj, 'AGENTS.md'), 'utf-8').match(/flow (flw-[0-9a-f]{8})/)[1];
  const md = apx(['get', flw]).out;
  const ids = [...md.matchAll(/delegate start (dlg-[0-9a-f]{8})/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, 2, `one id per background piece:\n${md}`);
  const [style, tests] = ids;
  const APX = 'node .agent-pack/apx/lead.apx';
  assert.ok(!md.includes('store the result as `style`'), 'delivering stores it: no set to tell');
  // Claude Code's own words (D60): a background agent, and a WAIT that never blocks the session — the notifications, then `wait --now`.
  has(md, `\`${APX} delegate deliver ${style} -\``, `\`${APX} delegate block ${tests} "<why>"\``,
    'launch it as a background agent (the Agent tool, run_in_background: true)',
    'do not go on until the notification of each one has come', `\`${APX} delegate ended <id>\``,
    `\`${APX} wait ${style} --now\`: each one's state, its limit counted from its start`, `\`${APX} wait ${tests} --now --max 1s\``);
  // Any other harness: the neutral words — the wait blocks until each one is settled or the limit.
  const { delegationText } = await import('../dist/src/delegation.js');
  has(delegationText({ keyword: 'WAIT', text: 'style', apx: APX, waits: [style] }), `\`${APX} wait ${style}\`: it returns when each one is delivered`);
  // A FORK in Claude Code is its native fork; working as another agent, it first reads who that agent is (D61).
  const { delegationPhrases } = await import('../dist/src/delegation.js');
  const { default: claudeCode } = await import('../dist/adapters/claude-code/index.js');
  const phrases = delegationPhrases(claudeCode().renderings);
  has(delegationText({ keyword: 'FORK', text: 'write the article', agent: 'writer', phrases, definition: '`node .agent-pack/apx/writer.apx scope`' }),
    'a native fork (the Agent tool, subagent_type: "fork") that works as `writer`: tell it to read who `writer` is first, with `node .agent-pack/apx/writer.apx scope`');
  has(delegationText({ keyword: 'FORK', text: 'draft it', phrases }), 'a native fork of yourself (the Agent tool, subagent_type: "fork"), with this whole conversation');
  // Any other harness: the neutral words.
  has(delegationText({ keyword: 'FORK', text: 'draft it', agent: 'writer' }), 'to `writer`, forked with this whole conversation');

  // --- start, and a piece cannot start twice while it runs ---
  r = apx(['wait', style]);
  assert.equal(r.code, 1);
  has(r.out, `${style} was never started in this session`);
  assert.equal(apx(['delegate', 'start', style]).code, 0);
  r = apx(['delegate', 'start', tests]);
  assert.equal(r.code, 0, r.out);
  has(r.out, `${tests}  check  running  → checker-b`, `delegate deliver ${tests} -`);
  r = apx(['delegate', 'start', style]);
  assert.equal(r.code, 1);
  has(r.out, 'is still running — wait for it first');
  has(apx(['delegate', 'start', 'dlg-00000000']).out, 'no flow of lead starts dlg-00000000');

  // --- deliver: kept in its INTO variable; the wait returns at once ---
  assert.equal(apx(['delegate', 'deliver', style, '-'], 'no style issues\n').code, 0);
  has(apx(['get', 'style']).out, 'no style issues');
  r = apx(['wait', 'style']);
  assert.equal(r.code, 0, r.out);
  has(r.out, `${style}  style  delivered  → checker-a`, '1 piece delivered');
  r = apx(['delegate', 'deliver', style, '-'], 'again\n');
  assert.equal(r.code, 1);
  has(r.out, 'only a running piece is delivered');

  // --- the limit: what still runs is left as it is, and the lead decides ---
  const t0 = Date.now();
  r = apx(['wait', tests, '--max', '1s']);
  assert.ok(Date.now() - t0 >= 900, 'it waited for the limit');
  assert.equal(r.code, 1);
  has(r.out, `${tests}  check  running  → checker-b  — still running after 1s`, 'you decide: wait again', 'delegate reassign <dlg-id> <agent>');
  // The config's limit, when the WAIT names none.
  r = apx(['wait', tests]);
  has(r.out, 'still running after 2s');
  has(apx(['wait', tests, '--max', 'soon']).out, '--max soon: a duration is');

  // --- --now: no waiting, the limit counted from the start (D60) ---
  r = apx(['wait', tests, '--now', '--max', '1h']);
  assert.equal(r.code, 1);
  has(r.out, `${tests}  check  running  → checker-b  — running, within its 1h`, 'still running, within the limit — wait for the word that each one ended');
  r = apx(['wait', tests, '--now', '--max', '1s']);
  has(r.out, 'still running after 1s', 'you decide');

  // --- ended without delivery, then reassigned, then blocked: each wait returns at once ---
  assert.equal(apx(['delegate', 'ended', tests]).code, 0);
  r = apx(['wait', 'all']);
  has(r.out, '0 pieces delivered');
  r = apx(['wait', tests]);
  assert.equal(r.code, 1);
  has(r.out, `${tests}  check  ended without delivery  → checker-b`);
  has(apx(['delegate', 'reassign', tests, 'checker-a']).out, `${tests}  check  running  → checker-a`);
  r = apx(['delegate', 'block', tests]);
  assert.equal(r.code, 2);
  has(r.out, 'say why');
  assert.equal(apx(['delegate', 'block', tests, 'no', 'tests', 'to', 'run']).code, 0);
  r = apx(['wait', style, tests]);
  assert.equal(r.code, 1);
  has(r.out, `${style}  style  delivered`, `${tests}  check  blocked  → checker-a  — no tests to run`, '1 piece not delivered');
  // Take: the lead carries it out itself, from blocked no more — only running or ended.
  has(apx(['delegate', 'take', tests]).out, `${tests} is blocked, not running or ended`);
  has(apx(['delegate', 'list']).out, `${style}  style  delivered`, `${tests}  check  blocked`, '2 background pieces in this session');

  // --- the old name says the new one ---
  r = apx(['ask', 'input', 'exe-00000000']);
  assert.equal(r.code, 2);
  has(r.out, "'ask' is now 'delegate'");
  console.log('delegations: registry and wait passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
