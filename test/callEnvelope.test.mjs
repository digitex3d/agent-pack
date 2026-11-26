// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The call envelope and the call log (src/apx/call.ts, callLog.ts, intro.ts,
 * quiz.ts): the built-in `call` template compiled into every document as the
 * introduction to calling the apx, asked in the start quiz and printed only to
 * whoever misses it; `--call '<json>'` taken off the words before any verb sees
 * them; every call logged once, its verb alone, never a value.
 *
 * Driven the way a harness drives it: a real `.apx` written into a scratch
 * project, run with `node`, the log read back from the project's folder.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleAgentObject } from '../dist/src/compiler/index.js';
import { ApDocument } from '../dist/src/apdoc/document.js';
import { ApxEngine } from '../dist/src/apx/engine.js';
import { apxFiles } from '../dist/src/apx/write.js';
import { apxPath, CALL_LOG_FILE, LOG_DIR } from '../dist/src/apx/paths.js';
import { BUILTIN_LIBRARY_ROOT, DASHBOARD_DEFAULTS } from '../dist/src/config.js';
import { FORMULAS } from '../dist/src/formulas.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/apx');
const library = join(FIXTURE, 'library');
const compiled = await bundleAgentObject({
  agentName: 'pm',
  agentFile: join(FIXTURE, 'teams/product/pm.ap'),
  agentDir: join(FIXTURE, 'teams/product'),
  libraryRoot: library,
  libraryRoots: [library],
  libraries: { '@main': library, '@builtin': BUILTIN_LIBRARY_ROOT },
});
const json = compiled.structure.asJson();
const parsed = JSON.parse(json);

const has = (text, ...parts) => { for (const part of parts) assert.ok(text.includes(part), `expected ${JSON.stringify(part)} in:\n${text}`); };
const ENVELOPE = { goal: 'I fix the crash of the date parser.', context: 'The fix is done. The tests pass.', why: 'I check the rules before saving.' };

// --- the template is compiled into the document as an introduction, never as a block ---
{
  const intro = parsed.meta.md.intros.call;
  assert.ok(intro, 'the document carries the introduction to calling the apx');
  has(intro, 'Produce **call**', '**goal**', '**context**', '**why**', '**phase**', '**next**', '<example>');
  assert.ok(!/REGEX|matching \//.test(intro), 'the introduction shows no pattern');
  const blocks = Object.values(parsed.blocks ?? {}).flat();
  assert.ok(!JSON.stringify(blocks).includes('"name":"call"'), 'the template is no block of the document');
}

// --- the quiz, every block read on demand: it asks how to call the apx, after the kinds ---
{
  const doc = ApDocument.fromJson(json);
  const BUILD = { builtAt: '2026-11-19T10:00:00Z', agentPackVersion: '0.28.0', hash: 'c0ffee' };
  const start = (...args) => {
    const lines = [];
    const code = new ApxEngine(doc, BUILD, 'apx/pm.apx', line => lines.push(line), { whole: 0, block: 0 }).run(['start', ...args]);
    return { out: lines.join('\n'), code };
  };
  const asked = start().out;
  const kinds = [...asked.matchAll(/^\d+\. \[([\w-]+)\]/gm)].map(match => match[1]);
  assert.equal(kinds.at(-1), 'call', 'the last question is on calling the apx');
  has(asked, `[call] ${FORMULAS.apx.call.quiz[0].ask}`);
  assert.ok(!asked.includes('Produce **call**'), 'a quiz still to answer introduces nothing');

  // The right answer of each question, in the order asked.
  const guides = kind => (kind === 'call' ? FORMULAS.apx.call.quiz : FORMULAS.blocks[kind].quiz);
  const rights = [...new Set(kinds)].flatMap(kind => guides(kind).map(question => question.right));
  assert.equal(rights.length, kinds.length);
  const answers = rights.map((right, index) => `${index + 1}=${right}`);

  // All right: no introduction, not even the call's.
  {
    const { out, code } = start(...answers);
    assert.equal(code, 0);
    has(out, `# all ${kinds.length} correct`);
    assert.ok(!out.includes('## call') && !out.includes('Produce **call**'), 'an agent who knows how to call is not told again');
  }
  // The call question missed: its introduction, framed, then the scope.
  {
    const wrong = answers.map((answer, index) => (index === kinds.length - 1 ? `${index + 1}=?` : answer));
    const { out, code } = start(...wrong);
    assert.equal(code, 0);
    has(out, '# missed: call', '## call', "--call '<json>', last on the line", 'Produce **call**', 'you:  agent pm');
    assert.ok(out.indexOf('## call') < out.indexOf('you:  agent pm'), 'the introduction comes before the scope');
  }
  // An answer out of the quiz is refused.
  {
    const { code } = start(`${kinds.length + 1}=a`);
    assert.equal(code, 2);
  }
}

const project = mkdtempSync(join(tmpdir(), 'apx-call-'));
try {
  for (const file of apxFiles('pm', json, project, false)) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  const run = (...args) => {
    const result = spawnSync('node', [apxPath('pm'), ...args], { cwd: project, encoding: 'utf-8' });
    return { out: result.stdout, code: result.status };
  };
  const logFile = join(project, CALL_LOG_FILE);
  const logLines = () => (existsSync(logFile) ? readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const lastLog = () => logLines().at(-1);

  // --- a start that asks no question: the whole definition, then how to call the apx ---
  {
    const { out, code } = run('start');
    assert.equal(code, 0);
    has(out, '# your whole definition', '## call', "--call '<json>', last on the line", 'Produce **call**');
  }
  // --- help says in one line how to call ---
  {
    const { out } = run('help');
    assert.equal(out.split('\n').filter(line => line.includes("--call '<json>'")).length, 1);
  }

  // --- the envelope is taken off: a verb is served the same with or without it ---
  {
    const plain = run('ls');
    const enveloped = run('ls', '--call', JSON.stringify(ENVELOPE));
    assert.equal(enveloped.out, plain.out, 'no verb sees the envelope');
    assert.equal(enveloped.code, plain.code);
  }

  // --- every call is one line; the envelope as received; the verb alone ---
  {
    rmSync(join(project, LOG_DIR), { recursive: true, force: true });
    run('ls', '--call', JSON.stringify(ENVELOPE));
    let entry = lastLog();
    assert.deepEqual(Object.keys(entry), ['at', 'session', 'agent', 'command', 'call', 'problem', 'shown', 'exit']);
    assert.deepEqual(entry.shown, [], 'a document compiled without a dashboard shows none');
    assert.equal(entry.agent, 'pm');
    assert.deepEqual(entry.command, ['ls']);
    assert.deepEqual(entry.call, ENVELOPE);
    assert.equal(entry.problem, null);
    assert.equal(entry.exit, 0);

    run('version');
    entry = lastLog();
    assert.equal(entry.call, null, 'no envelope: none logged');

    run('version', '--call', 'this is not json');
    entry = lastLog();
    assert.equal(entry.call, 'this is not json', 'an envelope that is no JSON is logged as received');
    assert.match(entry.problem, /^not JSON/);

    const secret = 'top-secret-value-7f3a';
    const set = run('set', 'design', secret);
    entry = lastLog();
    assert.deepEqual(entry.command, ['set'], 'of the command only its verb');
    assert.equal(entry.exit, set.code, 'the exit code the call ended with');
    run('find', secret);
    run(secret);
    assert.ok(!readFileSync(logFile, 'utf-8').includes(secret), 'a value typed on the line never reaches the log');
    assert.deepEqual(lastLog().command, [], 'a first word that is no verb is not logged');
    assert.equal(logLines().length, 6, 'one line per call');
  }

  // --- a log that cannot be written never fails a call ---
  {
    rmSync(join(project, LOG_DIR), { recursive: true, force: true });
    const before = run('ls');
    rmSync(join(project, LOG_DIR), { recursive: true, force: true });
    writeFileSync(join(project, LOG_DIR), 'not a folder');
    const after = run('ls', '--call', JSON.stringify(ENVELOPE));
    assert.equal(after.code, before.code);
    assert.equal(after.out, before.out);
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}

// --- the dashboard's keys: what it showed after the answer, in the order printed — ids alone; [] without an envelope ---
const lit = mkdtempSync(join(tmpdir(), 'apx-call-shown-'));
try {
  const withDashboard = await bundleAgentObject({
    agentName: 'pm',
    agentFile: join(FIXTURE, 'teams/product/pm.ap'),
    agentDir: join(FIXTURE, 'teams/product'),
    libraryRoot: library,
    libraryRoots: [library],
    libraries: { '@main': library, '@builtin': BUILTIN_LIBRARY_ROOT },
    dashboard: DASHBOARD_DEFAULTS,
  });
  const document = withDashboard.structure.asJson();
  for (const file of apxFiles('pm', document, lit, false)) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  const run = (...args) => spawnSync('node', [apxPath('pm'), ...args], { cwd: lit, encoding: 'utf-8' }).stdout;
  const logFile = join(lit, CALL_LOG_FILE);
  const lastLog = () => JSON.parse(readFileSync(logFile, 'utf-8').trim().split('\n').at(-1));
  const boardRules = Object.values(JSON.parse(document).blocks).find(block => block.name === 'board-rules').id;
  const next = 'I keep one card per task on the board.';
  const out = run('ls', '--call', JSON.stringify({ ...ENVELOPE, next }));
  assert.ok(out.includes('board-rules —'), `the call lights the board's rules:\n${out}`);
  const entry = lastLog();
  assert.ok(entry.shown.includes(boardRules), `its key is logged: ${JSON.stringify(entry.shown)}`);
  assert.ok(entry.shown.every(key => /^[a-z]{3}-[0-9a-f]{8}$/.test(key)), 'keys alone');
  assert.ok(!JSON.stringify(entry.shown).includes('board'), 'never a name');
  run('ls');
  assert.deepEqual(lastLog().shown, [], 'no envelope: none shown');
  run('version', '--call', JSON.stringify({ ...ENVELOPE, next }));
  assert.deepEqual(lastLog().shown, [], 'an exempt command: none shown');
} finally {
  rmSync(lit, { recursive: true, force: true });
}

console.log('call envelope and call log tests passed.');
