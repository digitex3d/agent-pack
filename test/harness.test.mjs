// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Delegating to another harness (D66) — a real project, the real `bundle all`
 * and `harness list`, the apx run as the lead runs it; the other harness's CLI
 * is a stand-in on the PATH, and its run is written by hand, as the command
 * would leave it:
 *
 *   - `BY <harness>:<agent>` names an agent of the project as another harness
 *     runs it; the harness is a dependency of the build — enabled, with a
 *     recipe, its CLI on the PATH — and a FORK cannot cross harnesses
 *   - `harness list`: installed, enabled, delegable, the CLI on the PATH
 *   - the compiled line: `delegate start`, the command, `deliver --answer`
 *   - start opens a copy, carries the agent's definition in, writes the prompt
 *     and prints the recipe filled; deliver keeps the answer and, of what the
 *     copy changed, what stays within the perimeter; the WAIT merges it
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };

const proj = mkdtempSync(join(tmpdir(), 'ap-harness-'));
const bin = mkdtempSync(join(tmpdir(), 'ap-harness-bin-'));
const SESSION = 'harness-session';
const PATH = `${bin}${delimiter}${process.env.PATH}`;
const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', input: opts.input, env: { ...process.env, PATH: opts.path ?? PATH, CLAUDE_CODE_SESSION_ID: SESSION } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
};
const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
const apx = (args, input) => run([join(proj, '.agent-pack', 'apx', 'lead.apx'), ...args], { input });
const git = (...args) => { const r = spawnSync('git', args, { cwd: proj, encoding: 'utf-8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const team = join(proj, 'agents', 'teams', 'site');
const agent = (name, within) => write(join(team, `${name}.ap`), [
  ...(within ? [`IMPORT ${within} FROM @main.domains`, '', `@WITHIN ${within}`] : []),
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work',
]);
const flow = lines => write(join(team, 'site.ap'), teamSource('site', ['lead', 'hunter', 'writer'], [
  'IMPORT gaps, notes FROM @main.vars', 'IMPORT diff-only FROM @main.templates', 'IMPORT web FROM @main.domains',
  'ABOUT  builds the site', 'WHEN asked to build:', '    RUN build', 'FLOW build:', ...lines,
]));
const FLOW = [
  '    @WITHIN web',
  '    STEP review:',
  '        DELEGATE~ trace every path of {{notes}} INTO gaps BY codex:hunter AS diff-only',
  '        WAIT gaps',
  '    STEP write:',
  '        DELEGATE write the notes BY claude-code:writer',
];

try {
  // The other harnesses' CLIs, as the PATH holds them: looked up, never run by agent-pack.
  for (const cli of ['codex', 'claude']) { writeFileSync(join(bin, cli), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, cli), 0o755); }
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code', 'codex'],", '};']);
  write(join(proj, 'src', 'web', 'app.ts'), ['export const app = 1;']);
  write(join(proj, 'README.md'), ['# site']);
  write(join(proj, 'library', 'domains', 'web.ap'), ['EXPORT DOMAIN web:', '    ABOUT  the web app', '    WRITES IN src/web/**']);
  write(join(proj, 'library', 'vars', 'site.ap'), ['EXPORT SESSION VAR gaps', 'EXPORT SESSION VAR notes']);
  write(join(proj, 'library', 'templates', 'diff-only.ap'), ['EXPORT TEMPLATE diff-only:', '    ABOUT  only the diff', '    SLOTS:', '        diff: TEXT  "the diff"']);
  agent('lead'); agent('hunter'); agent('writer');
  flow(FLOW);
  write(join(proj, '.gitignore'), ['.agent-pack/', '.claude/', '.codex/', '.agents/', 'AGENTS.md', 'CLAUDE.md']);
  git('init', '-q'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'dev');
  git('add', '-A'); git('commit', '-qm', 'start');

  // --- the three lists ---
  let out = ok(run([CLI, 'harness', 'list']), 'harness list');
  has(out, 'harness', 'installed', 'enabled', 'delegable', 'cli on PATH');
  assert.match(out, /^codex\s+yes\s+yes\s+yes\s+codex: yes$/m, out);
  assert.match(out, /^claude-code\s+yes\s+yes\s+yes\s+claude: yes$/m, out);
  assert.match(out, /^cursor\s+yes\s+no\s+no\s+—$/m, 'installed, not enabled, no recipe');
  assert.match(out, /^opencode\s+yes\s+no\s+no\s+opencode: (yes|no)$/m, 'installed, not enabled: not delegable until the config names it');
  const json = JSON.parse(ok(run([CLI, 'harness', 'list', '--json']), 'harness list --json'));
  assert.deepEqual(json.find(r => r.harness === 'claude-code-apx'), { harness: 'claude-code-apx', installed: true, enabled: false, delegable: false, cli: 'claude', onPath: true });
  console.log('harness: the three lists passed.');

  // --- the harness is a dependency of the build ---
  out = run([CLI, 'bundle', 'all'], { path: process.env.PATH.split(delimiter).filter(d => !existsSync(join(d, 'codex'))).join(delimiter) }).out;
  has(out, 'the harness `codex` needs its CLI, `codex`, on the PATH');
  flow(FLOW.map(l => l.replace('codex:hunter', 'cursor:hunter')));
  has(run([CLI, 'bundle', 'all']).out, 'the harness `cursor` is not enabled — add \'cursor\' to `adapters:`');
  flow(FLOW.map(l => l.replace('codex:hunter', 'nowhere:hunter')));
  has(run([CLI, 'bundle', 'all']).out, 'no harness is called `nowhere` — the harnesses installed: claude-code, claude-code-apx, codex, cursor, opencode');
  flow(FLOW.map(l => l.replace('codex:hunter', 'codex:nobody')));
  has(run([CLI, 'bundle', 'all']).out, 'BY codex:nobody: unknown agent `nobody`');
  flow(FLOW.map(l => l.replace('DELEGATE write the notes BY claude-code:writer', 'FORK write the notes BY claude-code:writer')));
  has(run([CLI, 'bundle', 'all']).out, 'a conversation does not cross harnesses');
  flow(FLOW);
  ok(run([CLI, 'bundle', 'all']), 'bundle all');
  console.log('harness: the dependency passed.');

  // --- the compiled line: start, the command, deliver --answer; a WAIT merges ---
  // The flow as the lead reads it: from the apx, where the ids of its pieces are.
  const flowId = readFileSync(join(proj, 'AGENTS.md'), 'utf-8').match(/flow `build` \((flw-[0-9a-f]{8})\)/)[1];
  const md = ok(apx(['flow', flowId]), 'apx flow');
  has(md, 'to `hunter` on codex, another harness, handing over only what `diff-only`',
    'in the background: run its command in the background', 'delegate start dlg-', 'delegate deliver dlg-',
    'to `writer` on claude-code, another harness, handing over the task and the variables it reads');
  const [hunt, write2] = [...md.matchAll(/delegate start (dlg-[0-9a-f]{8})/g)].map(m => m[1]);
  assert.ok(hunt && write2, md);
  assert.ok(md.includes(`wait ${write2}\``), 'a piece not in the background is merged where it stands');
  assert.ok(existsSync(join(proj, '.codex', 'agents', 'hunter.toml')), 'codex writes its agents');
  has(readFileSync(join(proj, '.codex', 'agents', 'hunter.toml'), 'utf-8'), 'name = "hunter"', 'description = "hunter"', "developer_instructions = '''");
  console.log('harness: the compiled line passed.');

  // --- start: the copy, the carried definition, the prompt, the recipe filled ---
  ok(apx(['set', 'notes', '-'], 'the login form changed'), 'set notes');
  out = ok(apx(['delegate', 'start', hunt]), 'delegate start');
  has(out, `${hunt}  → hunter on codex  copy: `, 'codex exec -C ', '-s workspace-write --skip-git-repo-check --ephemeral --color never -o ',
    '.answer.txt --output-schema ', '.schema.json - < ', '.prompt.md',
    '# You must run it outside any sandbox of your own', `delegate deliver ${hunt} --answer`);
  const copy = join(proj, out.match(/copy: (\S+)/)[1]);
  assert.ok(existsSync(join(copy, '.codex', 'agents', 'hunter.toml')), 'its definition is carried into the copy');
  const prompt = readFileSync(`${copy}.prompt.md`, 'utf-8');
  has(prompt, 'Have the custom agent `hunter` carry out', 'trace every path of {{notes}}', '"notes": "the login form changed"', 'shaped as `diff-only`');
  has(readFileSync(`${copy}.schema.json`, 'utf-8'), '"diff"');

  // --- deliver: the answer, and of the copy's changes what stays within web ---
  has(apx(['delegate', 'deliver', hunt, '-'], 'x').out, `its answer is the file its command wrote — `);
  writeFileSync(join(copy, 'src', 'web', 'app.ts'), 'export const app = 2;\n');
  writeFileSync(join(copy, 'README.md'), '# changed outside\n');
  writeFileSync(`${copy}.answer.txt`, '{"diff":"app 1 -> 2"}\n');
  out = ok(apx(['delegate', 'deliver', hunt, '--answer']), 'deliver --answer');
  has(out, `${hunt}  delivered — src/web/app.ts`, 'left out, outside its perimeter: README.md');
  assert.ok(!out.includes('hunter.toml'), 'what was carried in is never delivered');
  has(ok(apx(['get', 'gaps']), 'get gaps'), 'app 1 -> 2');
  out = apx(['wait', hunt]).out;
  has(out, 'merged', 'landed in the working folder: src/web/app.ts');
  assert.equal(readFileSync(join(proj, 'src', 'web', 'app.ts'), 'utf-8'), 'export const app = 2;\n');
  assert.equal(readFileSync(join(proj, 'README.md'), 'utf-8'), '# site\n', 'outside the perimeter: left out');

  // --- claude-code: the agent named on the command line, the prompt on stdin ---
  out = ok(apx(['delegate', 'start', write2]), 'delegate start claude-code');
  has(out, '(cd ', '&& claude -p --agent writer --output-format text --permission-mode acceptEdits) < ', '.answer.txt');
  assert.ok(!out.includes('{shape}') && !out.includes('--output-schema'), 'no schema flag for a CLI without one');
  console.log('harness: start, deliver and merge passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
}
