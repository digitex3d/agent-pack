// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Contracts and models on another harness (D66) — a real project, the real
 * `bundle all`, the apx run as the lead runs it; opencode's CLI is a stand-in
 * on the PATH, and its run is written by hand, as the command would leave it:
 *
 *   - the model: the delegated agent's BUDGET tier, mapped per adapter in the
 *     config (`{ name: 'opencode', models: { cheap: … } }`) — into its
 *     `.opencode/agents/<name>.md` and the recipe's `--model`; a tier the
 *     harness maps to none warns at build, and runs on the harness's default
 *   - a list of contracts keeps its harness: `DELEGATE~ <list> BY opencode:<agent>`
 *     compiles to `contract start <mrk> --by opencode:<agent>`, never to a
 *     background agent of the harness that runs the flow
 *   - `contract start --by <harness>:<agent>` opens each copy — the project's
 *     dependency folders linked in — carries the agent's definition, writes
 *     the prompt (spec, zones) and prints the command; `delegate deliver
 *     <ctr> --answer` keeps the answer and the zones, never what was carried
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, lstatSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
const FREE = 'opencode/deepseek-v4.1-flash-free';

const proj = mkdtempSync(join(tmpdir(), 'ap-harness-contracts-'));
const bin = mkdtempSync(join(tmpdir(), 'ap-harness-contracts-bin-'));
const SESSION = 'harness-contracts-session';
const PATH = `${bin}${delimiter}${process.env.PATH}`;
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', input: opts.input, env: { ...process.env, PATH, CLAUDE_CODE_SESSION_ID: SESSION } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
};
const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
const apx = (args, input) => run([join(proj, '.agent-pack', 'apx', 'lead.apx'), ...args], { input });
const git = (...args) => { const r = spawnSync('git', args, { cwd: proj, encoding: 'utf-8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const team = join(proj, 'agents', 'teams', 'fix');
const agent = (name, budget) => write(join(team, `${name}.ap`), [
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', ...(budget ? [`    BUDGET   ${budget}`] : []), '',
  `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work',
]);

try {
  for (const cli of ['opencode', 'codex']) { writeFileSync(join(bin, cli), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, cli), 0o755); }
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',",
    `  adapters: ['claude-code', 'codex', { name: 'opencode', models: { cheap: '${FREE}' } }],`, '};']);
  write(join(proj, 'library', 'templates', 'bug-spec.ap'), ['EXPORT TEMPLATE bug-spec:', '    ABOUT  one bug to fix', '    SLOTS:', '        bug: TEXT  "what goes wrong"']);
  write(join(proj, 'library', 'vars', 'fix.ap'), ['EXPORT SESSION VAR bugs']);
  agent('lead'); agent('fixer', 'cheap'); agent('thinker', 'costly');
  write(join(team, 'fix.ap'), teamSource('fix', ['lead', 'fixer', 'thinker'], [
    'IMPORT bug-spec FROM @main.templates', 'IMPORT bugs FROM @main.vars',
    'ABOUT  fixes bugs', 'WHEN asked to fix:', '    RUN fix', 'FLOW fix:',
    '    STEP mark the bugs:', '        MARK one zone per bug INTO bugs AS bug-spec',
    '    STEP fix the bugs:', '        DELEGATE~ bugs BY opencode:fixer', '        WAIT bugs',
    '    STEP think:', '        DELEGATE think it over BY opencode:thinker',
  ]));
  write(join(proj, 'src', 'login.ts'), ['export function login() {', '  return null;', '}']);
  write(join(proj, 'node_modules', 'lib', 'index.js'), ['module.exports = 1;']);
  write(join(proj, '.gitignore'), ['node_modules/', '.agent-pack/', '.claude/', '.codex/', '.opencode/', '.agents/', 'AGENTS.md', 'CLAUDE.md']);
  git('init', '-q'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'dev');
  git('add', '-A'); git('commit', '-qm', 'start');

  // --- the build: the models of the tiers, a warning for a tier the harness maps to none ---
  let out = ok(run([CLI, 'bundle', 'all']), 'bundle all');
  has(out, '`thinker` declares BUDGET costly, and opencode maps no model to it — it runs on opencode\'s own default model',
    "adapters: [{ name: 'opencode', models: { costly: '<model>' } }]");
  has(readFileSync(join(proj, '.opencode', 'agents', 'fixer.md'), 'utf-8'), `model: "${FREE}"`);
  assert.ok(!readFileSync(join(proj, '.opencode', 'agents', 'thinker.md'), 'utf-8').includes('model:'), 'a tier mapped to none: no model');
  has(readFileSync(join(proj, '.claude', 'agents', 'thinker.md'), 'utf-8'), 'model: opus');

  // --- the compiled list keeps its harness ---
  const flowId = readFileSync(join(proj, 'AGENTS.md'), 'utf-8').match(/flow `fix` \((flw-[0-9a-f]{8})\)/)[1];
  const md = ok(apx(['flow', flowId]), 'apx flow');
  const mrk = md.match(/contract mark (mrk-[0-9a-f]{8})/)[1];
  has(md, 'Hand every contract `bugs` holds to `fixer` on opencode, another harness', `contract start ${mrk} --by opencode:fixer`,
    'in the background: run its command in the background', '--answer');
  const line = md.split('\n').find(l => l.includes('Hand every contract `bugs`'));
  assert.ok(!line.includes('background agent'), `a list on another harness is no background agent of this one:\n${line}`);
  console.log('harness contracts: build and compiled list passed.');

  // --- start on another harness: the copy, the dependencies, the carried definition, the prompt, the command ---
  const ctr = ok(apx(['contract', 'mark', mrk, '-'], '{"bug":"login returns null"}'), 'mark').match(/^(ctr-[0-9a-f]{8})/m)[1];
  write(join(proj, 'src', 'login.ts'), ['export function login() {', `  // agent-pack ${ctr}`, '  return null;', `  // agent-pack end ${ctr}`, '}']);
  let r = apx(['contract', 'start', mrk, '--by', 'codex:fixer']);
  assert.equal(r.code, 2, r.out);
  has(r.out, "codex's recipe was not compiled into lead", 'DELEGATE bugs BY codex:fixer', 'nothing was started');
  out = ok(apx(['contract', 'start', mrk, '--by', 'opencode:fixer']), 'contract start on opencode');
  has(out, `${ctr}  → fixer on opencode  src/login.ts:`, `opencode run --model ${FREE} --agent fixer --dir `, '.prompt.md',
    `# model: ${FREE} — the one fixer's BUDGET tier maps to on opencode`, '# You must never add --auto',
    '1 contract started on opencode', `delegate deliver <ctr-id> --answer`, `wait ${mrk}`);
  const copy = join(proj, out.match(/copy: (\S+)/)[1]);
  assert.ok(lstatSync(join(copy, 'node_modules')).isSymbolicLink(), 'the dependency folders are linked into the copy');
  assert.ok(existsSync(join(copy, '.opencode', 'agents', 'fixer.md')), 'its definition is carried into the copy');
  has(readFileSync(`${copy}.prompt.md`, 'utf-8'), `Carry out the contract ${ctr}`, '"bug": "login returns null"', 'Its zones: src/login.ts:',
    `agent-pack ${ctr}`, 'Your last message is your answer');
  has(ok(apx(['contract', 'get', ctr]), 'contract get'), 'carried out by fixer');

  // --- deliver: the answer, the zone — never the carried definition ---
  writeFileSync(join(copy, 'src', 'login.ts'), ['export function login() {', `  // agent-pack ${ctr}`, '  return { ok: true };', `  // agent-pack end ${ctr}`, '}', ''].join('\n'));
  writeFileSync(join(copy, '.opencode', 'agents', 'fixer.md'), 'changed by the run\n');
  r = apx(['delegate', 'deliver', ctr]);
  assert.equal(r.code, 2, r.out);
  has(r.out, `${ctr} ran on opencode: its answer is the file its command wrote`);
  r = apx(['delegate', 'deliver', ctr, '--answer']);
  assert.equal(r.code, 1, r.out);
  has(r.out, 'wrote no answer');
  writeFileSync(`${copy}.answer.txt`, 'login now returns ok\n');
  out = ok(apx(['delegate', 'deliver', ctr, '--answer']), 'deliver --answer');
  has(out, `${ctr}  delivered — src/login.ts`, 'answer: login now returns ok');
  assert.ok(!out.includes('fixer.md') && !out.includes('left out'), `what was carried in is neither delivered nor left out:\n${out}`);
  out = apx(['wait', mrk]).out;
  has(out, 'merged', 'landed in the working folder: src/login.ts');
  has(readFileSync(join(proj, 'src', 'login.ts'), 'utf-8'), 'return { ok: true };');
  assert.ok(!readFileSync(join(proj, 'src', 'login.ts'), 'utf-8').includes('agent-pack end'), 'the marks never land');

  // --- a plain delegation whose agent's tier maps to none: the harness's own default ---
  const think = md.match(/delegate start (dlg-[0-9a-f]{8})/)[1];
  out = ok(apx(['delegate', 'start', think]), 'delegate start thinker');
  has(out, `${think}  → thinker on opencode`, "# model: opencode's own default — thinker's BUDGET tier maps to none on opencode", 'opencode run --agent thinker');
  assert.ok(!out.includes('--model'), out);
  console.log('harness contracts: start, deliver and merge passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
}
