// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Delegating over ACP (D66) — a fake ACP agent (fixtures/acp/fake-server.mjs):
 *
 *   - the client: the session in the copy, the last message as the answer,
 *     permissions and files only inside the copy, terminals only when enabled,
 *     a sign-in, a crash, a refusal and a timeout each a failure — no secret shown
 *   - open harnesses: each acp server a harness, no agent files written for it —
 *     `BY junie:<agent>` refused at start, naming why; a name clash and a
 *     missing command fail the build
 *   - a transport: `{ name: 'codex', acp: { … } }` — the BY unchanged, the
 *     delegation through the client, codex's own agent files and intro kept
 *   - harness list: the servers, and how each harness is reached
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const FAKE = join(HERE, 'fixtures', 'acp', 'fake-server.mjs');
const SECRET = 's3cr3t-token-value';
const { runAcp, insideCopy, permissionVerdict } = await import('../dist/adapters/acp/client.js');
const { resolveAdapter } = await import('../dist/src/adapter-registry.js');
const { maskerOf } = await import('../dist/adapters/acp/server.js');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
const server = (env, extra = {}) => ({ command: process.execPath, args: [FAKE], env: { FAKE_SECRET: SECRET, ...env }, timeout: '1m', terminal: false, ...extra });

const copy = realpathSync(mkdtempSync(join(tmpdir(), 'ap-acp-copy-')));
const proj = mkdtempSync(join(tmpdir(), 'ap-acp-'));
try {
  // --- the client, against the fake agent ---
  write(join(copy, 'README.md'), ['# inside']);
  mkdirSync(join(copy, 'src'));
  const reports = [];
  const report = line => reports.push(line);
  const answer = await runAcp({ harness: 'junie', server: server({ FAKE_ACP: 'ok', FAKE_ANSWER: 'the answer' }), project: copy, prompt: 'do it', model: 'fake-small', report });
  assert.equal(answer, 'the answer', 'the last message is the answer — what came before the tool call is not');
  const probe = JSON.parse(readFileSync(join(copy, 'acp-probe.json'), 'utf-8'));
  assert.equal(probe.cwd, copy, 'the session opens with the copy as its cwd');
  assert.equal(probe.model, 'fake-small', 'the model is set the way the agent advertises');
  assert.deepEqual(probe.capabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: false });
  assert.equal(probe.permissionInside, 'yes', 'a path inside the copy: approved');
  assert.equal(probe.permissionOutside, 'no', 'a path outside the copy: rejected');
  assert.equal(probe.permissionEscape, 'no', 'a `..` out of the copy: rejected');
  assert.match(probe.readOutside, /^error: refused: it is outside the copy/);
  assert.equal(probe.readInside, '# inside\n');
  assert.match(probe.terminal, /^error: terminals are not enabled for junie/);
  has(reports.join('\n'), 'refused permission for Edit outside: it touches /etc/passwd, outside the copy', 'refused terminal/create');
  assert.ok(!reports.some(l => l.includes('Edit inside')), 'an approval is not reported');

  // Terminals, when the entry enables them.
  await runAcp({ harness: 'junie', server: server({ FAKE_ACP: 'ok' }, { terminal: true }), project: copy, prompt: 'do it', model: null, report });
  const withTerminal = JSON.parse(readFileSync(join(copy, 'acp-probe.json'), 'utf-8'));
  assert.equal(withTerminal.terminal, 'ok');
  assert.equal(withTerminal.capabilities.terminal, true);
  assert.equal(withTerminal.model, null, 'no model mapped: the agent keeps its own');

  // Fail closed on what cannot be checked.
  assert.equal(insideCopy(copy, 'src/new/file.ts'), true);
  assert.equal(insideCopy(copy, '../x'), false);
  assert.equal(permissionVerdict(copy, { kind: 'fetch', title: 'Fetch' }, false).allow, false, 'no path to check: rejected');
  assert.equal(permissionVerdict(copy, { kind: 'execute', rawInput: { command: 'ls' } }, false).allow, false, 'a command without terminals: rejected');

  // Malformed requests are refused, never served with less than they asked for.
  {
    const { Host } = await import('../dist/adapters/acp/host.js');
    const host = new Host({ harness: 'junie', root: copy, terminal: true, report: () => {}, permission: () => ({}) });
    const refused = async (method, params, pattern) => {
      await assert.rejects(host.onRequest(method, params), e => e.code === -32602 && pattern.test(e.message), `${method}: refused as invalid params`);
    };
    await refused('fs/write_text_file', { path: 'README.md', content: {} }, /needs its content as text/);
    assert.equal(readFileSync(join(copy, 'README.md'), 'utf-8'), '# inside\n', 'a write with no text content leaves the file as it was');
    await refused('terminal/create', { command: 'echo', args: ['ok', 42] }, /every arg as text/);
    await refused('terminal/create', { command: 'echo', env: [{ name: 'A', value: 1 }] }, /every env entry/);
    await refused('terminal/create', { command: 'echo', env: [{ value: 'x' }] }, /every env entry/);
    host.terminals.closeAll();
  }

  // Every failure is an Error, never an empty answer — and no secret in it.
  const fails = async (env, pattern, extra) => {
    const lines = [];
    let failed = null;
    try { await runAcp({ harness: 'junie', server: server(env, extra), project: copy, prompt: 'x', model: null, report: l => lines.push(l) }); } catch (e) { failed = e.message; }
    assert.ok(failed, `${env.FAKE_ACP}: the run fails`);
    assert.match(failed, pattern);
    assert.ok(![failed, ...lines].some(l => l.includes(SECRET)), `${env.FAKE_ACP}: no secret in ${failed}`);
    return failed;
  };
  await fails({ FAKE_ACP: 'auth' }, /junie needs you to sign in first \(it offers: jetbrains-account\)/);
  has(await fails({ FAKE_ACP: 'crash' }, /the server exited \(code 3\) before the turn ended/), 'token=***');
  await fails({ FAKE_ACP: 'refusal' }, /stopReason refusal/);
  const at = Date.now();
  await fails({ FAKE_ACP: 'hang' }, /no answer within 1s — the server was stopped/, { timeout: '1s' });
  assert.ok(Date.now() - at < 10_000, 'stopped at its timeout');
  await fails({}, /cannot start/, { command: join(copy, 'no-such-server') });
  console.log('acp: the client passed.');

  // --- what is masked: a secret's name, or the entry's `mask` — never a plain value, never a tiny one ---
  {
    const mask = maskerOf({ env: { API_TOKEN: 'tok-12345', DEBUG: 'true', HOME_URL: 'https://x.example', LISTED: 'listed-value', SHORT_KEY: 'abc', Db_Password: 'hunter22' }, mask: ['LISTED'] });
    assert.equal(mask('tok-12345 hunter22 listed-value'), '*** *** ***', 'a secret-named value, any case, and a listed one');
    assert.equal(mask('DEBUG is true at https://x.example'), 'DEBUG is true at https://x.example', 'plain values stay readable');
    assert.equal(mask('abc'), 'abc', 'a value under 4 characters is never masked');
    assert.equal(maskerOf({ env: { TOKEN: 'abcd' } })('abcd'), '***', 'a missing mask list: names alone decide');
    // The environment the server runs in: what it inherits too, and what is set over it.
    process.env.AP_TEST_INHERITED_API_KEY = 'inherited-secret-1';
    process.env.AP_TEST_INHERITED_PLAIN = 'inherited-plain-1';
    try {
      const inherited = maskerOf({ env: {} }, { EXTRA_TOKEN: 'extra-secret-1' });
      assert.equal(inherited('inherited-secret-1 extra-secret-1 inherited-plain-1'), '*** *** inherited-plain-1', 'an inherited or extra secret-named value is masked; a plain one is not');
    } finally {
      delete process.env.AP_TEST_INHERITED_API_KEY;
      delete process.env.AP_TEST_INHERITED_PLAIN;
    }
  }

  // --- the config ---
  assert.deepEqual(resolveAdapter({ name: 'acp', servers: { junie: { command: 'junie', mask: ['API_URL'] } } }).harnesses[0].invocation.transport, 'acp');
  assert.throws(() => resolveAdapter({ name: 'acp', servers: { junie: { command: 'junie', mask: ['API_URL', 3] } } }), /junie`\.mask must list the names of env variables/);
  assert.throws(() => resolveAdapter({ name: 'acp', servers: { junie: { command: 'junie', mask: 'API_URL' } } }), /\.mask must list/);
  assert.doesNotThrow(() => resolveAdapter({ name: 'codex', acp: { command: 'x', mask: ['API_URL'] } }), 'mask in a built-in harness\'s acp option');
  assert.throws(() => resolveAdapter({ name: 'acp', servers: { junie: { command: 'junie', argv: [] } } }), /`argv` is no field of an ACP server/);
  assert.throws(() => resolveAdapter({ name: 'acp', servers: { 'a:b': { command: 'x' } } }), /needs a name of letters/);
  assert.throws(() => resolveAdapter({ name: 'codex', acp: { command: 'x', models: {} } }), /`models` is no field .*the adapter's own `models`/);
  assert.equal(resolveAdapter({ name: 'codex', acp: { command: 'x' } }).invocation.transport, 'acp');
  // A harness whose CLI picked the agent (`--agent`) names it in the prompt over ACP, and carries its native file in.
  for (const [name, file] of [['claude-code', '.claude/agents/{agent}.md'], ['opencode', '.opencode/agents/{agent}.md']]) {
    const inv = resolveAdapter({ name, acp: { command: 'x' } }).invocation;
    assert.ok(inv.intro.includes(`\`{agent}\` defined in \`${file}\``), `${name}: ${inv.intro}`);
    assert.ok(inv.carry.includes(file), `${name} carries ${file}`);
    assert.equal(resolveAdapter(name).invocation.intro, undefined, `${name} by its own CLI: no intro`);
  }
  assert.match(resolveAdapter({ name: 'codex', acp: { command: 'x' } }).invocation.intro, /^Have the custom agent `\{agent\}`/, 'codex keeps its own intro');

  // --- a project: junie and sloppy as open harnesses, claude-code and codex over ACP ---
  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', input: opts.input, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'acp-session' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
  };
  const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
  const apx = (args, input) => run([join(proj, '.agent-pack', 'apx', 'site.apx'), ...args], { input });
  const git = (...args) => { const r = spawnSync('git', args, { cwd: proj, encoding: 'utf-8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); };
  const fake = env => `{ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}], env: ${JSON.stringify({ FAKE_SECRET: SECRET, ...env })} }`;
  const config = servers => write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',",
    `  adapters: [{ name: 'claude-code', acp: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: '{"diff":"app 1 -> 2"}' })} }, { name: 'codex', acp: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'written' })} }, { name: 'acp', servers: { ${servers} } }],`, '};']);
  config(`junie: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: '{"diff":"app 1 -> 2"}' })}, sloppy: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'no json at all' })}`);
  const team = join(proj, 'agents', 'teams', 'site');
  for (const name of ['lead', 'hunter', 'writer']) {
    write(join(team, `${name}.ap`), [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name} of the site`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work']);
  }
  const FLOW = [
    '    STEP review:',
    '        DELEGATE~ trace every path of {{notes}} INTO gaps BY claude-code:hunter AS diff-only',
    '        WAIT gaps',
    '    STEP write:',
    '        DELEGATE write the notes BY codex:writer',
    '    STEP again:',
    '        DELEGATE~ trace it again INTO loose BY codex:hunter AS diff-only',
    '        WAIT loose',
    '    STEP check:',
    '        DELEGATE review the notes BY claude-code:hunter',
    '    STEP bare:',
    '        DELEGATE trace it on junie BY junie:hunter',
  ];
  const flow = lines => write(join(team, 'site.ap'), teamSource('site', ['lead', 'hunter', 'writer'], [
    'IMPORT gaps, notes, loose FROM @main.vars', 'IMPORT diff-only FROM @main.templates',
    'ABOUT  builds the site', 'WHEN asked to build:', '    RUN build', 'FLOW build:', ...lines,
  ]));
  flow(FLOW);
  write(join(proj, 'library', 'vars', 'site.ap'), ['IMPORT diff-only FROM @main.templates', '', 'EXPORT SESSION VAR gaps AS diff-only', 'EXPORT SESSION VAR notes', 'EXPORT SESSION VAR loose AS diff-only']);
  write(join(proj, 'library', 'templates', 'diff-only.ap'), ['EXPORT TEMPLATE diff-only:', '    ABOUT  only the diff', '    SLOTS:', '        diff: TEXT  "the diff"']);
  write(join(proj, 'README.md'), ['# site']);
  write(join(proj, '.gitignore'), ['.agent-pack/', '.claude/', '.codex/', '.agents/', 'AGENTS.md', 'CLAUDE.md']);
  git('init', '-q'); git('config', 'user.email', 'dev@example.com'); git('config', 'user.name', 'dev');
  git('add', '-A'); git('commit', '-qm', 'start');

  // --- harness list: the servers, and how each harness is reached ---
  let r0;
  let out = ok(run([CLI, 'harness', 'list']), 'harness list');
  has(out, 'via');
  assert.match(out, /^junie\s+yes\s+yes\s+yes\s+acp\s+\S+node\S*: yes$/m, out);
  assert.match(out, /^codex\s+yes\s+yes\s+yes\s+acp\s+\S+node\S*: yes$/m, 'codex over ACP');
  assert.match(out, /^claude-code\s+yes\s+yes\s+yes\s+acp\s+\S+node\S*: yes$/m, 'claude-code over ACP');
  assert.match(out, /^opencode\s+yes\s+no\s+no\s+cli\s+opencode: (yes|no)$/m, 'opencode by its own CLI');
  const json = JSON.parse(ok(run([CLI, 'harness', 'list', '--json']), 'harness list --json'));
  assert.deepEqual(json.find(r => r.harness === 'sloppy'), { harness: 'sloppy', installed: true, enabled: true, delegable: true, via: 'acp', cli: process.execPath, onPath: true });
  assert.ok(!JSON.stringify(json).includes(SECRET), 'no env value in harness list');

  // --- the build: a clash, a missing command, an unconfigured name ---
  config(`codex: ${fake({})}`);
  r0 = run([CLI, 'bundle', 'all']);
  assert.notEqual(r0.code, 0, 'a name clash fails the build');
  has(r0.out, "acp's `codex` takes the name of the installed harness `codex`");
  config(`junie: { command: 'no-such-acp-server' }, sloppy: ${fake({})}`);
  r0 = run([CLI, 'bundle', 'all']);
  assert.notEqual(r0.code, 0, 'a missing command fails the build');
  has(r0.out, 'the harness `junie` needs its CLI, `no-such-acp-server`, on the PATH');
  // harness list reports the same problem: the server's command not found.
  assert.match(ok(run([CLI, 'harness', 'list']), 'harness list'), /^junie\s+yes\s+yes\s+yes\s+acp\s+no-such-acp-server: no$/m);
  assert.equal(JSON.parse(ok(run([CLI, 'harness', 'list', '--json']), 'json')).find(x => x.harness === 'junie').onPath, false);
  config(`junie: { command: '/nowhere/junie' }, sloppy: ${fake({})}`);
  has(run([CLI, 'bundle', 'all']).out, 'the harness `junie` runs `/nowhere/junie`, and no executable file is there');
  config(`sloppy: ${fake({})}`);
  r0 = run([CLI, 'bundle', 'all']);
  assert.notEqual(r0.code, 0, 'an unconfigured name fails the build');
  has(r0.out, 'no harness is called `junie`');
  const slow = `{ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}], env: ${JSON.stringify({ FAKE_SECRET: SECRET, FAKE_ACP: 'hang' })}, timeout: '1s' }`;
  config(`junie: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: '{"diff":"app 1 -> 2"}' })}, sloppy: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'no json at all' })}, gated: ${fake({ FAKE_ACP: 'auth' })}, slow: ${slow}`);
  out = ok(run([CLI, 'bundle', 'all']), 'bundle all');
  assert.ok(!out.includes(SECRET), 'no env value in the build');
  assert.ok(!existsSync(join(proj, '.agent-pack', 'compiled', 'hunter.md')), 'acp writes no compiled definition: no prompt reads one');
  assert.ok(existsSync(join(proj, '.codex', 'agents', 'writer.toml')), 'codex over ACP keeps its agent files');
  console.log('acp: the build passed.');

  // --- start, run, deliver ---
  const flowId = readFileSync(join(proj, 'AGENTS.md'), 'utf-8').match(/flow `build` \((flw-[0-9a-f]{8})\)/)[1];
  const md = ok(apx(['flow', flowId]), 'apx flow');
  const [hunt, writ, loose, check, bare] = [...md.matchAll(/delegate start (dlg-[0-9a-f]{8})/g)].map(m => m[1]);
  assert.ok(hunt && writ && loose && check && bare, md);
  ok(apx(['set', 'notes', '-'], 'the login form changed'), 'set notes');
  const launch = id => {
    const started = ok(apx(['delegate', 'start', id]), `delegate start ${id}`);
    const lines = started.split('\n');
    const command = lines[lines.indexOf('# run, with your shell:') + 1];
    assert.ok(!started.includes(SECRET), 'no env value on the command line');
    const copyOf = join(proj, started.match(/copy: (\S+)/)[1]);
    return { started, command, copy: copyOf, prompt: readFileSync(`${copyOf}.prompt.md`, 'utf-8') };
  };
  const sh = command => spawnSync('sh', ['-c', command], { cwd: proj, encoding: 'utf-8' });

  // An open harness: no adapter writes its agent files — refused at start, nothing opened.
  const refusedBare = apx(['delegate', 'start', bare]);
  assert.notEqual(refusedBare.code, 0, refusedBare.out);
  has(refusedBare.out, "junie cannot act as `hunter`: no adapter writes junie's agent files");

  // The prompt names the agent and its native file — no definition pasted in; the session runs in the copy.
  const h = launch(hunt);
  has(h.command, 'adapters/acp/client.js --server claude-code --agent hunter --project ', '--prompt ', '--answer ');
  assert.ok(h.prompt.startsWith('Act as the agent `hunter` defined in `.claude/agents/hunter.md`'), h.prompt);
  assert.ok(!h.prompt.includes('# Who you are') && !h.prompt.includes('hunter of the site'), 'no definition inlined');
  has(h.prompt, 'trace every path of {{notes}}', '"notes": "the login form changed"', 'shaped as `diff-only`');
  let r = sh(h.command);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(h.copy, 'acp-probe.json'), 'utf-8')).cwd, realpathSync(h.copy));
  assert.equal(readFileSync(`${h.copy}.answer.txt`, 'utf-8'), '{"diff":"app 1 -> 2"}\n');
  ok(apx(['delegate', 'deliver', hunt, '--answer']), 'deliver --answer');
  has(ok(apx(['get', 'gaps']), 'get gaps'), 'app 1 -> 2');

  // Mode 1: codex's BY unchanged, through the client; no definition in the prompt, codex's intro kept.
  const w = launch(writ);
  has(w.command, '--server codex');
  assert.ok(!w.command.includes('codex exec'), 'not codex\'s own CLI');
  assert.ok(w.prompt.startsWith('Have the custom agent `writer` carry out'), w.prompt);
  assert.ok(!w.prompt.includes('# Who you are'), 'no definition inlined over a transport');
  assert.ok(existsSync(join(w.copy, '.codex', 'agents', 'writer.toml')), 'codex\'s agent file is carried in');
  r = sh(w.command);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(`${w.copy}.answer.txt`, 'utf-8'), 'written\n');
  has(ok(apx(['delegate', 'deliver', writ, '--answer']), 'deliver codex over ACP'), `${writ}  delivered`);
  assert.ok(md.includes('BY codex:writer') || md.includes('`writer` on codex'), 'the BY line is unchanged');

  // claude-code over ACP: no `--agent` — the prompt names the agent and its native file, carried into the copy.
  const c = launch(check);
  has(c.command, '--server claude-code');
  assert.ok(c.prompt.startsWith('Act as the agent `hunter` defined in `.claude/agents/hunter.md`'), c.prompt);
  assert.ok(existsSync(join(c.copy, '.claude', 'agents', 'hunter.md')), 'its native definition is carried in');
  r = sh(c.command);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(`${c.copy}.answer.txt`, 'utf-8'), '{"diff":"app 1 -> 2"}\n');

  // An AS answer that does not fit its template is rejected at deliver.
  const l = launch(loose);
  r = sh(l.command);
  assert.equal(r.status, 0, r.stderr);
  const refused = apx(['delegate', 'deliver', loose, '--answer']);
  assert.notEqual(refused.code, 0, refused.out);
  has(refused.out, 'delivers into `loose`', 'nothing was stored');
  assert.ok(!ok(apx(['get', 'loose']), 'get loose').includes('written'), 'the answer that does not fit is not stored');

  // The client as the recipe runs it: a sign-in demanded, a timeout — each a failure, no answer file, no secret.
  const work = join(proj, '.agent-pack', 'work', 'manual');
  mkdirSync(work, { recursive: true });
  write(join(proj, '.agent-pack', 'work', 'manual.prompt.md'), ['do it']);
  const client = name => {
    const answerFile = join(proj, '.agent-pack', 'work', `manual.${name}.answer.txt`);
    writeFileSync(answerFile, 'an earlier answer\n');
    const res = spawnSync(process.execPath, [join(HERE, '..', 'dist', 'adapters', 'acp', 'client.js'), '--server', name, '--project', work,
      '--prompt', join(proj, '.agent-pack', 'work', 'manual.prompt.md'), '--answer', answerFile], { cwd: proj, encoding: 'utf-8' });
    const said = `${res.stdout}${res.stderr}`;
    assert.notEqual(res.status, 0, `${name}: the run fails`);
    assert.ok(!existsSync(answerFile), `${name}: no answer file is left, not even an earlier one`);
    assert.ok(!said.includes(SECRET), `${name}: no secret in what it prints:\n${said}`);
    return said;
  };
  has(client('gated'), 'acp gated: failed — gated needs you to sign in first (it offers: jetbrains-account)');
  const t0 = Date.now();
  has(client('slow'), 'acp slow: failed — no answer within 1s — the server was stopped');
  assert.ok(Date.now() - t0 < 15_000, 'stopped at its timeout');
  console.log('acp: start, run and deliver passed.');
} finally {
  rmSync(copy, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}
