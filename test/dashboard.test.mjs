// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx dashboard (src/dashboard.ts, src/apx/dashboard.ts): what each rule
 * and trigger of an agent weighs, compiled into its document; the `dashboard`
 * config section, its defaults and its refusals; the design's complete example,
 * with its made-up affinities; and a real `.apx` run the way a harness runs it,
 * the dashboard printed last after the answer, and the session that keeps
 * which blocks were shown lately.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bundleAgentObject } from '../dist/src/compiler/index.js';
import { BUILTIN_LIBRARY_ROOT, DASHBOARD_DEFAULTS, loadConfig } from '../dist/src/config.js';
import { Dashboard } from '../dist/src/apx/dashboard.js';
import { corpusOf, withCorpus } from '../dist/src/dashboard.js';
import { apxFiles } from '../dist/src/apx/write.js';
import { apxPath, sessionFile, CALL_LOG_FILE } from '../dist/src/apx/paths.js';
import { ApDocument } from '../dist/src/apdoc/document.js';
import { ApxEngine } from '../dist/src/apx/engine.js';
import { TABELI_ENGINE } from '../dist/src/config.js';

// --- the design's complete example (dossier-v1/PLAN-dashboard.md), its made-up ids and affinities: exactly the dashboard printed there ---
{
  const settings = DASHBOARD_DEFAULTS;
  const command = 'node .agent-pack/apx/typescript-implementer.apx';
  const rule = (name, about, id, weight) => ({ key: id, kind: 'rules', block: id, weight, title: `${name} — ${about}`, command: `${command} get ${id}` });
  const trigger = (when, id, key, weight) => ({ key, kind: 'triggers', block: id, when, weight, title: `When ${when}`, command: `${command} get ${id}` });
  const reminders = [
    rule('commits', 'the authorization and the content of every git commit', 'pol-3f2a', 20),
    rule('security', 'baseline security rules every agent respects', 'pol-91bc', 16),
    rule('language', 'the language of everything written in this project', 'pol-0e44', 8),
    rule('raw-access', 'who may access raw/', 'pol-5a01', 20),
    rule('testing', 'how a change is tested before it is handed over', 'pol-7b3d', 6),
    trigger('a change is ready to commit', 'wfl-2c7e', 'ready', 16),
    trigger('a step of the work ends', 'wfl-5d10', 'step', 16),
    trigger('a test fails', 'wfl-8e21', 'fails', 6),
    trigger('the user asks to add a rule', 'wfl-9f32', 'rule', 12),
  ];
  const call = { next: 'I commit the change.', work: 'I add the dashboard to the apx.\nThe score code is done. The code logs each call.' };
  // `next` read whole; goal and context together — the table's goal+context column is this affinity × 0.5.
  const affinities = {
    [call.next]: { 'pol-3f2a': 1.6, 'pol-0e44': 1.1, ready: 1.5, step: 1.1 },
    [call.work]: { 'pol-91bc': 1.2, 'pol-7b3d': 1.4, step: 1.2, fails: 1.2 },
  };
  const affinity = text => new Map(Object.entries(affinities[text] ?? {}));
  const dashboard = new Dashboard(settings, reminders, affinity);
  const shown = dashboard.show(call, key => (key === 'pol-3f2a' ? 1 : null));
  assert.equal(shown.lines.join('\n'), `---
Before your next step — "I commit the change." —
these are often missed here and may apply to your next step — open the ones that do:

  When a change is ready to commit
  ${command} get wfl-2c7e

  When a step of the work ends
  ${command} get wfl-5d10

  commits — the authorization and the content of every git commit
  ${command} get pol-3f2a

These may apply to your next step — open the ones that do:

  security — baseline security rules every agent respects
  ${command} get pol-91bc

  language — the language of everything written in this project
  ${command} get pol-0e44

These are further from your next step — open the ones that apply:

  testing — how a change is tested before it is handed over
  ${command} get pol-7b3d`);
  assert.deepEqual(shown.shown, ['ready', 'step', 'pol-3f2a', 'pol-91bc', 'pol-0e44', 'pol-7b3d'], 'the six blocks shown, by score');

  // Rules keep four and triggers three, ranked apart; merged and cut at six, `WHEN a test fails` stays out.
  const wider = new Dashboard({ ...settings, maxEntries: 7 }, reminders, affinity).show(call, () => null).shown;
  assert.deepEqual(wider, ['pol-3f2a', 'ready', 'step', 'pol-91bc', 'pol-0e44', 'pol-7b3d', 'fails'], 'never shown: commits keeps its whole score; seven fit');
  const fewer = new Dashboard({ ...settings, kinds: { rules: { max: 1 }, triggers: { max: 1 } } }, reminders, affinity).show(call, () => null).shown;
  assert.deepEqual(fewer, ['pol-3f2a', 'ready'], 'each kind\'s own max');

  // With no next: only goal and context count, and the opening says so.
  const current = dashboard.show({ next: null, work: call.work }, () => null).lines;
  assert.equal(current[1], 'For your current work,');
  assert.ok(!current.some(line => line.includes('commits')), 'commits lights only on next');

  // A text no word of which lights a block: nothing pertinent, no dashboard, not even its separator.
  const unlit = dashboard.show({ next: 'I water the plants.', work: 'I tend the garden.' }, () => null);
  assert.deepEqual(unlit, { lines: [], shown: [] });

  // The penalty: a block shown d calls ago keeps 1 − 1/(d + 1) of its score under recall, all of it from recall on.
  const commits = [reminders[0]];
  const only = text => new Map(text === call.next ? [['pol-3f2a', 1.6]] : []);
  const band = ago => new Dashboard({ ...settings, bands: { medium: 20, high: 30 } }, commits, only).show(call, () => ago).lines[2];
  assert.match(band(null), /often missed/, 'never shown: 32, high');
  assert.match(band(1), /further from/, '1 call ago: ×1/2, 16, low');
  assert.match(band(2), /^these may apply/, '2 calls ago: ×2/3, 21.3, medium');
  assert.match(band(7), /^these may apply/, '7 calls ago, under recall: ×7/8, 28, medium');
  assert.match(band(8), /often missed/, 'recall calls ago: all of it, 32, high');
}

const POLICIES = `EXPORT POLICY care:
    ABOUT  how a change is kept safe
    APPLIES universal
    ALWAYS keep each change small
    NEVER commit without the developer's consent

EXPORT POLICY style:
    ABOUT  how the code reads
    APPLIES universal
    ALWAYS name each variable with whole words
`;

const AGENT = `IMPORT care, style FROM @main.policies

EXPORT PROCEDURE check:
    ABOUT  run the checks
    MUST run the tests
    DO  read the report

EXPORT AGENT coder AS builder:
    ABOUT     writes the code
    MANDATE   deliver the change
    ALWAYS keep the tests green

    WHEN a change is ready to commit:
        RUN check
    WHEN a test fails:
        MUST! read the failure before changing the code

EXPORT ROLE builder:
    ABOUT  a builder of agreed changes
    SHOULD read the code before changing it
    MAY ask the developer when the design is unclear
`;

const project = mkdtempSync(join(tmpdir(), 'apx-dashboard-'));
const library = join(project, 'library');
mkdirSync(join(library, 'policies'), { recursive: true });
mkdirSync(join(project, 'agents'), { recursive: true });
writeFileSync(join(library, 'policies', 'rules.ap'), POLICIES);
const agentFile = join(project, 'agents', 'coder.ap');
writeFileSync(agentFile, AGENT);

/** The coder compiled with a `dashboard` section — or none — and its constants. */
async function compile(dashboard, vars) {
  const compiled = await bundleAgentObject({
    agentName: 'coder',
    agentFile,
    agentDir: join(project, 'agents'),
    libraryRoot: library,
    libraryRoots: [library],
    libraries: { '@main': library, '@builtin': BUILTIN_LIBRARY_ROOT },
    ...(dashboard ? { dashboard } : {}),
    ...(vars ? { vars } : {}),
  });
  return JSON.parse(compiled.structure.asJson());
}

/** Each reminder's weight, by a readable name: a block's, or `when <condition>`. */
function weights(parsed) {
  const names = Object.fromEntries(Object.values(parsed.blocks).map(block => [block.id, block.name]));
  return Object.fromEntries(parsed.meta.dashboard.reminders.map(reminder => [reminder.when ? `when ${reminder.when}` : names[reminder.block], reminder.weight]));
}

try {
  // --- compiling writes each rule's and trigger's weight, (risk + 1) × cost, into the document's meta ---
  {
    const parsed = await compile(DASHBOARD_DEFAULTS);
    assert.deepEqual(weights(parsed), {
      // NEVER is a prohibition: risk 1, cost 4 (ALWAYS, NEVER).
      care: 8,
      style: 4,
      // SHOULD outweighs MAY: cost 2, risk 0.
      builder: 2,
      // A trigger applies at one precise moment: risk 1; no rule line: cost 2.
      'when a change is ready to commit': 4,
      // Its strongest line, MUST!: cost 5.
      'when a test fails': 10,
    }, 'a procedure — the flow points the agent at it — is no reminder');
    const triggers = parsed.meta.dashboard.reminders.filter(reminder => reminder.kind === 'triggers');
    const agentId = Object.values(parsed.blocks).find(block => block.kind === 'agent').id;
    assert.ok(triggers.every(trigger => trigger.block === agentId && /^whn-[0-9a-f]{8}$/.test(trigger.key)), 'a trigger is read in the block it is written in, under a key of its own');
    assert.equal(JSON.stringify(Object.values(parsed.blocks)).includes('"weight"'), false, 'the weight is the agent\'s, never a field of a block');
    assert.ok(!parsed.meta.dashboard.reminders.some(reminder => reminder.kind === 'rules' && reminder.block === agentId), 'the agent\'s own block, rule lines and all, is never offered to it');

    // Each cost is the one force-levels.json gives the block's strongest line, its family and level.
    const levels = JSON.parse(readFileSync(new URL('../src/config/force-levels.json', import.meta.url), 'utf-8'));
    const cost = (family, level) => levels.families.find(entry => entry.name === family).costs[String(level)];
    assert.deepEqual(weights(parsed), {
      care: (1 + 1) * cost('ALWAYS', -1),
      style: (0 + 1) * cost('ALWAYS', 0),
      builder: (0 + 1) * cost('SHOULD', 0),
      'when a change is ready to commit': (1 + 1) * levels.noRuleCost,
      'when a test fails': (1 + 1) * cost('MUST', 1),
    }, 'the weights follow force-levels.json');
  }

  // --- no number is hard-coded in the dashboard code: every constant comes from the config or force-levels.json ---
  for (const file of ['../src/dashboard.ts', '../src/apx/dashboard.ts']) {
    const code = readFileSync(new URL(file, import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|`[^`\n]*`/g, "''");
    // 0 and 1 belong to the formulas themselves: the zero of an unlit block, the 1 of (risk + 1) and 1 − 1/(d + 1).
    const numbers = [...code.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map(found => found[0]).filter(found => found !== '0' && found !== '1');
    assert.deepEqual(numbers, [], `${file}: no number of its own`);
  }

  // --- `bundle all` weighs each document again over every block it compiled: the same document over its own corpus is unchanged ---
  {
    const parsed = await compile(DASHBOARD_DEFAULTS);
    const doc = ApDocument.fromJson(JSON.stringify(parsed));
    assert.deepEqual(JSON.parse(withCorpus(doc, corpusOf([doc]))), parsed, 'only the corpus moves the weights');
    const wider = JSON.parse(withCorpus(ApDocument.fromJson(JSON.stringify(parsed)), [...corpusOf([doc]), 'a block about nothing', 'another one']));
    assert.notDeepEqual(wider.meta.dashboard.index, parsed.meta.dashboard.index, 'a wider corpus makes each word rarer');
    assert.deepEqual(wider.blocks, parsed.blocks, 'the blocks stay as they are');
  }

  // --- an agent with more rule lines than manyRules adds one to every risk ---
  {
    const parsed = await compile({ ...DASHBOARD_DEFAULTS, manyRules: 5 });
    assert.deepEqual(weights(parsed), { care: 12, style: 8, builder: 4, 'when a change is ready to commit': 6, 'when a test fails': 15 },
      'seven rule lines, over five');
  }

  // --- no dashboard section reached the compilation: no dashboard in the document ---
  {
    const parsed = await compile(null);
    assert.equal(parsed.meta.dashboard, undefined);
  }

  // --- the config section: its defaults, an override, and what it refuses ---
  {
    const write = (name, dashboard) => {
      const file = join(project, `${name}.config.mjs`);
      writeFileSync(file, `export default ${JSON.stringify(dashboard === undefined ? {} : { dashboard })};\n`);
      return file;
    };
    assert.deepEqual((await loadConfig(['--config', write('none')])).dashboard, DASHBOARD_DEFAULTS, 'absent: the defaults');
    const tuned = (await loadConfig(['--config', write('tuned', { recall: 4, kinds: { rules: { max: 2 } }, bands: { high: 20 } })])).dashboard;
    assert.deepEqual(tuned, { ...DASHBOARD_DEFAULTS, recall: 4, kinds: { ...DASHBOARD_DEFAULTS.kinds, rules: { max: 2 } }, bands: { ...DASHBOARD_DEFAULTS.bands, high: 20 } },
      'a key given overrides its default, the others stay');
    await assert.rejects(loadConfig(['--config', write('unknown', { maxEntrys: 3 })]), /dashboard: unknown key `maxEntrys`/);
    await assert.rejects(loadConfig(['--config', write('count', { recall: 0 })]), /dashboard\.recall must be a whole number ≥ 1/);
    await assert.rejects(loadConfig(['--config', write('kind', { kinds: { rules: { max: 1.5 } } })]), /dashboard\.kinds\.rules\.max must be a whole number ≥ 1/);
    await assert.rejects(loadConfig(['--config', write('bands', { bands: { medium: 12, high: 5 } })]), /dashboard\.bands\.medium must be below dashboard\.bands\.high/);
  }

  // --- a real apx, run the way a harness runs it: the dashboard comes last, after the answer ---
  {
    const parsed = await compile(DASHBOARD_DEFAULTS, { lang: 'English' });
    for (const file of apxFiles('coder', JSON.stringify(parsed), project, false)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const run = (...args) => {
      const result = spawnSync('node', [apxPath('coder'), ...args], { cwd: project, encoding: 'utf-8' });
      return { out: result.stdout, code: result.status };
    };
    const envelope = next => JSON.stringify({ goal: 'I ship the fix of the parser.', context: 'The change is small and the tests pass.', why: 'I check the rules before the commit.', ...(next ? { next } : {}) });
    const plain = run('ls');
    const enveloped = run('ls', '--call', envelope('I commit the change once the developer gives consent.'));
    assert.equal(enveloped.code, plain.code);
    assert.ok(enveloped.out.startsWith(plain.out), 'the answer first, as without an envelope');
    const dashboard = enveloped.out.slice(plain.out.length).trimEnd().split('\n');
    assert.equal(dashboard[0], '---', 'behind a separator');
    assert.equal(dashboard[1], 'Before your next step — "I commit the change once the developer gives consent." —');
    const careId = Object.values(parsed.blocks).find(block => block.name === 'care').id;
    const served = run('get', careId, '--call', envelope('I commit the change once the developer gives consent.')).out;
    assert.ok(served.includes('\n---\n'), 'the dashboard follows the block');
    assert.ok(!served.slice(served.indexOf('\n---\n')).includes('care — how a change is kept safe'), `the block the call printed is not offered again:\n${served}`);
    assert.match(dashboard[2], /^[a-z]/, `the band sentence goes on from the opening, without a capital:\n${dashboard.join('\n')}`);
    assert.ok(dashboard.includes(`  care — how a change is kept safe`), `the policy the next step lights, by name and ABOUT:\n${dashboard.join('\n')}`);
    const careAt = dashboard.indexOf('  care — how a change is kept safe');
    assert.match(dashboard[careAt + 1], /^ {2}node \.agent-pack\/apx\/coder\.apx get pol-[0-9a-f]{8}$/, 'then the full command that reads it');
    assert.ok(!/\d+\.\d|score/.test(dashboard.join('\n')), 'no score is shown');

    const agentId = Object.values(parsed.blocks).find(block => block.kind === 'agent').id;
    const trigger = run('ls', '--call', envelope('The change is ready to commit.')).out.split('\n');
    const whenAt = trigger.indexOf('  When a change is ready to commit');
    assert.ok(whenAt > 0, `a trigger lights on its condition:\n${trigger.join('\n')}`);
    const readyKey = parsed.meta.dashboard.reminders.find(reminder => reminder.when === 'a change is ready to commit').key;
    assert.equal(trigger[whenAt + 1], `  node .agent-pack/apx/coder.apx get ${readyKey}`, 'opened alone, by its own key');
    const alone = run('get', readyKey).out;
    assert.ok(alone.includes('When a change is ready to commit:') && alone.includes('check'), `get <whn-…>: the condition and its body:\n${alone}`);
    assert.ok(alone.includes(`— in agent coder  [node .agent-pack/apx/coder.apx get ${agentId}]`), 'then the block it is written in');
    assert.ok(!alone.includes('When a test fails'), 'no other trigger of its block');
    const again = run('get', readyKey, '--call', envelope('The change is ready to commit.')).out;
    assert.ok(!again.slice(again.indexOf('\n---\n')).includes(readyKey), 'the trigger the call printed is not offered again');

    const noNext = run('ls', '--call', JSON.stringify({ goal: 'I commit the change once the developer gives consent.', context: 'The tests pass.', why: 'I check the rules.' })).out;
    assert.equal(noNext.slice(plain.out.length).split('\n')[1], 'For your current work,', 'no next: goal and context light the blocks, and the opening says so');
    assert.ok(!run('ls').out.includes('---'), 'no envelope: no dashboard');
    assert.ok(!run('ls', '--call', 'not json').out.includes('---'), 'an envelope that is no JSON: no dashboard');
    const garden = JSON.stringify({ goal: 'I tend the garden.', context: 'Spring has come.', why: 'I plan the day.', next: 'I water the plants.' });
    assert.equal(run('ls', '--call', garden).out, plain.out, 'nothing pertinent: no dashboard, not even its separator');
    const consent = envelope('I commit the change once the developer gives consent.');
    const care = parsed.meta.dashboard.reminders.find(reminder => reminder.kind === 'rules' && Object.values(parsed.blocks).some(block => block.id === reminder.block && block.name === 'care')).block;
    for (const exempt of [['help'], ['version'], ['run', 'exe-00000000'], ['guard', 'src/a.ts']]) {
      assert.ok(!run(...exempt, '--call', consent).out.includes('\n---\n'), `${exempt[0]}: never followed by the dashboard`);
    }
    // An answer a program reads is never followed by it: a json or --json call, a variable's value.
    for (const data of [['get', care, 'json'], ['ls', '--json'], ['get', 'lang']]) {
      const answer = run(...data, '--call', consent).out;
      assert.ok(!answer.includes('Before your next step'), `${data.join(' ')}: no dashboard after data:\n${answer}`);
    }
    JSON.parse(run('get', care, 'json', '--call', consent).out);
    assert.match(run('get', 'lang', '--call', consent).out, /English/, 'the constant is printed');
    // md and check keep it: the whole prompt and a check's answer are read by the agent.
    for (const kept of [['md'], ['check', 'cnd-00000000']]) {
      assert.ok(run(...kept, '--call', consent).out.includes('  care — how a change is kept safe'), `${kept[0]}: followed by the dashboard`);
    }
  }

  // --- the session: each call counted, the blocks each call shows recorded with its number, start clears them ---
  {
    // Bands where care, lit by the commit, is high — and two thirds of it medium.
    const parsed = await compile({ ...DASHBOARD_DEFAULTS, bands: { medium: 5, high: 45 } });
    parsed.meta.sessionEnv = 'APX_DASHBOARD_TEST_SESSION';
    const agent = join(project, 'session');
    for (const file of apxFiles('coder', JSON.stringify(parsed), agent, false)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const run = (session, ...args) => {
      const env = { ...process.env, APX_DASHBOARD_TEST_SESSION: session ?? '' };
      return spawnSync('node', [apxPath('coder'), ...args], { cwd: agent, encoding: 'utf-8', env }).stdout;
    };
    const commit = JSON.stringify({ goal: 'I ship the fix.', context: 'The tests pass.', why: 'I check the rules.', next: 'I commit the change once the developer gives consent.' });
    const garden = JSON.stringify({ goal: 'I tend the garden.', context: 'Spring.', why: 'I plan the day.', next: 'I water the plants.' });
    const state = () => JSON.parse(readFileSync(join(agent, sessionFile('s-1')), 'utf-8')).coder;
    const care = parsed.meta.dashboard.reminders.find(reminder => Object.values(parsed.blocks).some(block => block.id === reminder.block && block.name === 'care')).key;

    const first = run('s-1', 'ls', '--call', commit);
    const sentenceOf = out => out.split('\n').find(line => /open (it|the ones)/.test(line));
    assert.ok(first.includes('  care — how a change is kept safe'));
    assert.equal(sentenceOf(first), 'this is often missed here and may apply to your next step — open it if it does:', 'never shown: care is high');
    const firstShown = state().shown;
    assert.deepEqual([state().call, firstShown[care]], [1, 1], 'call 1 showed care — with every other block a word of it lit');
    run('s-1', 'ls', '--call', garden);
    assert.deepEqual(state(), { call: 2, shown: firstShown }, 'a call that shows nothing is counted all the same');
    const second = run('s-1', 'ls', '--call', commit);
    assert.ok(second.includes('  care — how a change is kept safe'), 'a block shown lately gives way, it is never hidden');
    assert.equal(sentenceOf(second), 'these may apply to your next step — open the ones that do:', 'shown 2 calls ago: two thirds of its score, medium');
    assert.deepEqual([state().call, state().shown[care]], [3, 3], 'the distance from the last showing, never how many');
    assert.ok(!readFileSync(join(agent, sessionFile('s-1')), 'utf-8').includes('developer'), 'the session keeps call numbers and keys, never a word of the envelope');

    run('s-1', 'start', '--call', garden);
    assert.deepEqual(state(), { call: 4, shown: {} }, 'start clears every shown block');

    run('s-1', 'ls', '--call', commit);
    for (let call = 0; call < DASHBOARD_DEFAULTS.recall; call++) run('s-1', 'ls', '--call', garden);
    assert.deepEqual(state(), { call: 5 + DASHBOARD_DEFAULTS.recall, shown: {} }, 'a block shown recall calls ago is dropped');

    run('s-2', 'ls', '--call', commit);
    assert.equal(state().call, 5 + DASHBOARD_DEFAULTS.recall, 'another harness session keeps its own');

    run('s-1', 'ls', '--call', commit);
    assert.equal(state().shown[care], 6 + DASHBOARD_DEFAULTS.recall);
    run('s-1', 'start');
    assert.deepEqual(state(), { call: 6 + DASHBOARD_DEFAULTS.recall, shown: {} }, 'a start without an envelope clears the shown blocks too, and is not counted');

    const noSession = run(null, 'ls', '--call', commit);
    assert.ok(noSession.includes('  care — how a change is kept safe'), 'no session id: the dashboard prints all the same');
  }

  // --- get <variable>: a value stored in the session is data, never followed by the dashboard ---
  {
    mkdirSync(join(library, 'vars'), { recursive: true });
    writeFileSync(join(library, 'vars', 'notes.ap'), 'EXPORT SESSION VAR notes\n');
    writeFileSync(agentFile, `IMPORT notes FROM @main.vars\n${AGENT}`);
    const parsed = await compile(DASHBOARD_DEFAULTS);
    writeFileSync(agentFile, AGENT);
    parsed.meta.sessionEnv = 'APX_DASHBOARD_TEST_SESSION';
    const agent = join(project, 'variable');
    for (const file of apxFiles('coder', JSON.stringify(parsed), agent, false)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const run = (input, ...args) => spawnSync('node', [apxPath('coder'), ...args], { cwd: agent, encoding: 'utf-8', input, env: { ...process.env, APX_DASHBOARD_TEST_SESSION: 'v-1' } });
    const consent = JSON.stringify({ goal: 'I ship the fix.', context: 'The tests pass.', why: 'I check the rules.', next: 'I commit the change once the developer gives consent.' });
    assert.ok(run(undefined, 'ls', '--call', consent).stdout.includes('Before your next step'), 'the same envelope lights the dashboard after an answer an agent reads');
    const stored = run('the parser is fixed', 'set', 'notes', '-');
    assert.equal(stored.status, 0, `set notes:\n${stored.stdout}${stored.stderr}`);
    const read = run(undefined, 'get', 'notes', '--call', consent);
    assert.equal(read.status, 0, `get notes:\n${read.stdout}${read.stderr}`);
    assert.ok(read.stdout.trimEnd().endsWith('the parser is fixed'), `the stored value is printed last:\n${read.stdout}`);
    assert.ok(!read.stdout.includes('Before your next step') && !read.stdout.includes('\n---\n'), `no dashboard after a stored value:\n${read.stdout}`);
  }

  // --- a trigger's key: stable when another WHEN is added above; two WHENs of one condition, two keys, each serving its own ---
  {
    const keyOf = (parsed, when) => parsed.meta.dashboard.reminders.filter(reminder => reminder.when === when).map(reminder => reminder.key);
    const before = await compile(DASHBOARD_DEFAULTS);
    const twice = AGENT.replace('    WHEN a change is ready to commit:', '    WHEN the developer asks for a release:\n        RUN check\n    WHEN a change is ready to commit:')
      .replace('        MUST! read the failure before changing the code', '        MUST! read the failure before changing the code\n    WHEN a test fails:\n        DO  tell the developer which test');
    writeFileSync(agentFile, twice);
    const after = await compile(DASHBOARD_DEFAULTS);
    writeFileSync(agentFile, AGENT);
    assert.deepEqual(keyOf(after, 'a change is ready to commit'), keyOf(before, 'a change is ready to commit'), 'a WHEN added above leaves the key as it was');
    assert.deepEqual(keyOf(after, 'a test fails').slice(0, 1), keyOf(before, 'a test fails'), 'the first of a condition keeps its key');
    const [first, second] = keyOf(after, 'a test fails');
    assert.ok(first && second && first !== second, 'two WHENs of one condition: two keys');
    const folder = join(project, 'keys');
    for (const file of apxFiles('coder', JSON.stringify(after), folder, false)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const get = key => spawnSync('node', [apxPath('coder'), 'get', key], { cwd: folder, encoding: 'utf-8' }).stdout;
    assert.ok(get(first).includes('read the failure') && !get(first).includes('tell the developer'), `the first serves its own body:\n${get(first)}`);
    assert.ok(get(second).includes('tell the developer') && !get(second).includes('read the failure'), `the second serves its own body:\n${get(second)}`);
  }

  // --- the dashboard never fails a call: an index it cannot read prints none, the answer and its exit stay ---
  {
    const parsed = await compile(DASHBOARD_DEFAULTS);
    parsed.meta.dashboard.index.version = 99;
    const folder = join(project, 'corrupt');
    for (const file of apxFiles('coder', JSON.stringify(parsed), folder, false)) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
    const run = (...args) => spawnSync('node', [apxPath('coder'), ...args], { cwd: folder, encoding: 'utf-8' });
    const plain = run('ls');
    const consent = JSON.stringify({ goal: 'I ship the fix.', context: 'The tests pass.', why: 'I check.', next: 'I commit the change once the developer gives consent.' });
    const called = run('ls', '--call', consent);
    assert.equal(called.status, plain.status, `the exit code stays:\n${called.stderr}`);
    assert.equal(called.stdout, plain.stdout, 'the answer alone, no dashboard');
    const log = readFileSync(join(folder, CALL_LOG_FILE), 'utf-8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
    assert.deepEqual(log.shown, [], 'the log says none was shown');
    assert.equal(run('get', 'nothing-here', '--call', consent).status, 1, 'an error keeps its own exit code');
  }

  // --- the quiz start asks is never followed by the dashboard; the answers to it are ---
  {
    const parsed = await compile(DASHBOARD_DEFAULTS);
    const doc = ApDocument.fromJson(JSON.stringify(parsed));
    const BUILD = { builtAt: '2026-11-20T10:00:00Z', agentPackVersion: '0.28.0', hash: 'c0ffee', tabeli: TABELI_ENGINE };
    const received = { call: { goal: 'I ship the fix.', context: 'The tests pass.', why: 'I check.', next: 'I commit the change once the developer gives consent.' }, problem: null };
    const start = async (...args) => {
      const lines = [];
      const engine = new ApxEngine(doc, BUILD, 'apx/coder.apx', line => lines.push(line), { whole: 0, block: 0 });
      await engine.run(['start', ...args]);
      engine.remind(received);
      return lines;
    };
    const asked = await start();
    assert.ok(asked.some(line => line.startsWith('# quiz')), 'start asks its quiz');
    assert.ok(!asked.includes('---'), 'the questions go without the dashboard');
    // The answers print the definition — the agent's own block, with its triggers, and every policy and role — so nothing is left to offer.
    assert.ok(!(await start('1=?')).includes('---'), 'a block start printed whole is never offered by its dashboard');
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log('dashboard tests passed.');
