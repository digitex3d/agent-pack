// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The domains of a project's files, given at build time (D44, src/judge/domains.ts).
 *
 *   - decideChoice: the one rule — threshold and margin — the compiler and the apx share
 *   - the judge lock keeps a `choice` decision, and saves when one is taken
 *   - the jev adapter asks a choice and reads a probability per option
 *   - the lead of a team of contracts tags every file of its DOMAINS: a clear
 *     answer goes to the dimension's cache, a fresh file is not asked again, a
 *     saved decision is not asked, a grey file is the developer's — through the
 *     decider, else an error naming it; a domain no file has is a warning; no
 *     judge, or a judge offline, fails the build
 */

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { decideChoice, rankedOptions } = await import('../dist/src/judge/choice.js');
const { JudgeLock } = await import('../dist/src/judge/lock.js');
const { JudgeRun } = await import('../dist/src/judge/phase.js');
const { UnitStore } = await import('../dist/src/judge/units.js');
const { JudgeError } = await import('../dist/src/judge/types.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { buildContractIndex } = await import('../dist/src/services/teamMetadata.js');
const { DimensionCache, dimensionDefHash, dimensionTemplates } = await import('../dist/src/apx/dimensions.js');
const { domainKey } = await import('../dist/src/judge/domains.js');
const { default: jevJudge } = await import('../dist/adapters/jev/index.js');

// --- decideChoice: the rule ---
assert.deepEqual(decideChoice({ api: 0.85, persistence: 0.15 }, 0.5, 0.2), { choice: 'api', p: 0.85 });
assert.deepEqual(decideChoice({ api: 0.55, persistence: 0.45 }, 0.5, 0.2), { grey: ['api', 'persistence'], p: [0.55, 0.45] }, 'ahead, but not by the margin');
assert.deepEqual(decideChoice({ api: 0.4, persistence: 0.3, ui: 0.3 }, 0.5, 0.0), { grey: ['api', 'persistence'], p: [0.4, 0.3] }, 'below the threshold');
assert.deepEqual(decideChoice({ api: 1 }, 0.5, 0.2), { choice: 'api', p: 1 }, 'one option: nothing to be ahead of');
assert.deepEqual(decideChoice({}, 0.5, 0.2), { grey: ['', ''], p: [0, 0] });
assert.deepEqual(rankedOptions({ b: 0.5, a: 0.5, c: 0.1 }).map(([o]) => o), ['a', 'b', 'c'], 'ties break by name');

// --- the lock: a choice decision ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-domains-lock-'));
  try {
    const path = join(tmp, 'agent-pack.judge.lock');
    const lock = JudgeLock.load(path, 'fake');
    lock.decide('abc', 'api');
    assert.deepEqual(lock.decision('abc'), { choice: 'api', by: 'human' });
    lock.save();
    assert.ok(existsSync(path), 'a decision taken saves the lock, model pinned or not');
    const again = JudgeLock.load(path, 'fake');
    assert.equal(again.decision('abc').choice, 'api');
    writeFileSync(path, JSON.stringify({ version: 1, judge: 'fake', model: null, decisions: { bad: { choice: '' } } }));
    assert.throws(() => JudgeLock.load(path, 'fake'), /has neither a p between 0 and 1 nor a choice/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- the jev adapter: a choice question, a probability per option ---
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: 'jev-9', answers: { q1: { probabilities: { api: 0.7, persistence: 0.3 } }, q2: { noul: 0.9 } } }), { status: 200 });
  };
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const judge = jevJudge({ url: 'http://jev.test' });
    const { answers } = await judge.ask('the file', [{ id: 'd', question: 'Which domain?', options: { api: 'api', persistence: 'persistence' } }, { id: 'y', question: 'Is it code?' }]);
    assert.deepEqual(answers, { d: { api: 0.7, persistence: 0.3 }, y: 0.9 });
    assert.deepEqual(calls[0].questions.q1, { type: 'choice', instructions: 'Which domain?', criteria: { api: 'api', persistence: 'persistence' } });
    assert.deepEqual(calls[0].questions.q2, { type: 'noul', instructions: 'Is it code?' });
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: { q1: { probabilities: { api: 0.7 } } } }), { status: 200 });
    await assert.rejects(judge.ask('x', [{ id: 'd', question: 'q', options: { api: 'a', persistence: 'p' } }]), /no probability per option for question q1/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TYPESAFE_API_KEY;
  }
}

// --- the lead tags the files of its DOMAINS ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-domains-'));
  const lib = join(tmp, 'library');
  const teams = join(tmp, 'agents', 'teams');
  const backend = join(teams, 'backend');
  const project = join(tmp, 'PROJECT.ap');
  for (const d of ['templates', 'dimensions']) mkdirSync(join(lib, d), { recursive: true });
  mkdirSync(backend, { recursive: true });
  mkdirSync(join(tmp, 'src', 'api'), { recursive: true });
  mkdirSync(join(tmp, 'src', 'db'), { recursive: true });
  const write = (file, lines) => { writeFileSync(file, lines.join('\n') + '\n'); return file; };
  write(join(lib, 'templates', 'spec.ap'), ['EXPORT TEMPLATE spec:', '    ABOUT  a spec', '    SLOTS:', '        goal: TEXT  "the goal"', '    BODY:', '        {goal}']);
  write(join(lib, 'templates', 'file-domain.ap'), ['EXPORT TEMPLATE file-domain:', '    ABOUT  the domain of a file', '    SLOTS:', '        domain: ENUM[api persistence]  "the one domain of the file"', '    BODY:', '        {domain}']);
  write(join(lib, 'dimensions', 'domains.ap'), ['IMPORT file-domain FROM @main.templates', '', 'EXPORT DIMENSION domains:', '    ABOUT   the domain each file belongs to', '    FOR     src/**', '    EACH    file', '    AS      file-domain']);
  write(join(backend, 'architect.ap'), ['IMPORT domains FROM @main.dimensions', '', 'EXPORT AGENT architect AS lead-role:', '    ABOUT    the lead', '    MANDATE  deliver', '    WHEN handed change:', '        DO  hand out', '', 'ROLE lead-role:', '    ABOUT  a lead', '    ALWAYS  lead']);
  write(join(backend, 'api-dev.ap'), ['EXPORT AGENT api-dev AS dev-role:', '    ABOUT    a dev', '    MANDATE  do', '    WHEN handed endpoint:', '        DO  build', '', 'ROLE dev-role:', '    ABOUT  a dev', '    ALWAYS  work']);
  write(join(backend, 'backend.ap'), ['IMPORT spec FROM @main.templates', '', 'EXPORT TEAM backend:', '    ABOUT     a team', '    STRATEGY  contracts', '    LEAD      architect', '    DOMAINS   domains',
    '    CONTRACT endpoint:', '        ABOUT   an endpoint', '        DOMAIN  api', '        AS      spec', '        BY      api-dev']);
  write(project, ['ABOUT  the project', '', 'IMPORT spec FROM @main.templates', '', 'CONTRACT change:', '    ABOUT   a change', '    AS      spec', '    BY      backend']);
  write(join(tmp, 'src', 'api', 'users.ts'), ['export const route = "/users";']);
  write(join(tmp, 'src', 'db', 'users.ts'), ['export const table = "users";']);
  write(join(tmp, 'src', 'clock.ts'), ['export const now = () => Date.now();']);
  mkdirSync(join(tmp, 'node_modules', 'x'), { recursive: true });
  write(join(tmp, 'node_modules', 'x', 'index.js'), ['module.exports = 1;']);

  /** The fake judge: a distribution per file text, every call kept. */
  const asked = [];
  const reply = { byText: {}, error: null };
  const fake = {
    type: 'judge', name: 'fake',
    async ask(state, checks) {
      asked.push({ state, checks });
      if (reply.error) throw reply.error;
      const dist = reply.byText[state.trim()] ?? { api: 0.5, persistence: 0.5 };
      return { model: 'fake-1.0', answers: { [checks[0].id]: dist } };
    },
  };
  const lockPath = join(tmp, 'agent-pack.judge.lock');
  const runOf = () => {
    const lock = JudgeLock.load(lockPath, 'fake');
    const options = { adapter: fake, threshold: 0.5, margin: 0.2, offline: 'warn', lock: lockPath, concurrency: 4 };
    return new JudgeRun(options, [], lock, new UnitStore(join(tmp, '.agent-pack', 'units'), tmp, lock.model, {}));
  };
  const compile = (judge, decide) => bundleAgentObject({
    agentName: 'architect', agentFile: join(backend, 'architect.ap'), agentDir: backend, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false }, contractIndex: buildContractIndex(teams, project), projectRoot: tmp, judge, decide,
  });
  const cacheOf = doc => {
    const dim = doc.byKind('dimension')[0];
    return new DimensionCache(tmp, dimensionDefHash(dim, dimensionTemplates(doc, dim)));
  };
  try {
    // no judge: the build says so
    await assert.rejects(compile(null), /backend\.ap:7  DOMAINS domains: a team of contracts needs the judge to give every file its domain/);

    // two clear files, one grey, nobody to decide
    reply.byText['export const route = "/users";'] = { api: 0.9, persistence: 0.1 };
    reply.byText['export const table = "users";'] = { api: 0.1, persistence: 0.9 };
    let run = runOf();
    await assert.rejects(compile(run), /backend\.ap:7  DOMAINS domains: `src\/clock\.ts` — api \(0\.50\) or persistence \(0\.50\)\? Run `agent-pack bundle all` on a terminal to decide/);
    assert.deepEqual(asked.map(a => a.state.trim()).sort(), ['export const now = () => Date.now();', 'export const route = "/users";', 'export const table = "users";'], 'every file of the FOR asked once, node_modules never');
    assert.deepEqual(asked[0].checks[0].options, { api: 'the one domain of the file: api', persistence: 'the one domain of the file: persistence' }, 'the options carry the slot description');
    assert.equal(asked[0].checks[0].question, 'Which domain does this source file belong to?');

    // the clear ones are in the cache, written by the judge; the grey one is not
    const { structure: doc } = await compile(run, async () => 'api').catch(e => { throw e; });
    const cache = cacheOf(doc);
    assert.deepEqual(cache.read('src/api/users.ts').value, [{ domain: 'api' }]);
    assert.equal(cache.read('src/api/users.ts').by, 'judge:fake');
    assert.deepEqual(cache.read('src/db/users.ts').value, [{ domain: 'persistence' }]);
    // the decider decided the grey one: in the cache by the developer, in the lock
    assert.deepEqual([cache.read('src/clock.ts').value, cache.read('src/clock.ts').by], [[{ domain: 'api' }], 'human']);
    run.lock.save();
    const saved = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const key = domainKey(cache.defhash, cache.fingerprintOf('src/clock.ts'));
    assert.deepEqual(saved.decisions[key], { choice: 'api', by: 'human' }, 'the decision is in the lock, keyed by definition and fingerprint');
    assert.equal(saved.model, 'fake-1.0', 'the model is pinned from the first answer');

    // fresh files are not asked again; the decision survives the cache
    asked.length = 0;
    rmSync(join(tmp, '.agent-pack', 'cache'), { recursive: true, force: true });
    run = runOf();
    await compile(run);
    assert.deepEqual(asked.map(a => a.state.trim()).sort(), ['export const route = "/users";', 'export const table = "users";'], 'the decided file is not asked — the lock wins');
    asked.length = 0;
    await compile(runOf());
    assert.equal(asked.length, 0, 'every entry fresh: the judge is not called');

    // a file changes: asked again; a domain no file has: a warning
    write(join(tmp, 'src', 'db', 'users.ts'), ['export const table = "accounts";']);
    reply.byText['export const table = "accounts";'] = { api: 0.95, persistence: 0.05 };
    run = runOf();
    await compile(run);
    assert.deepEqual(asked.map(a => a.state.trim()), ['export const table = "accounts";']);
    assert.ok(run.warnings.some(w => /DOMAINS domains: no file of src\/\*\* has the domain `persistence`/.test(w.message)), run.warnings.map(w => w.message).join('\n'));

    // the judge offline: the build fails
    write(join(tmp, 'src', 'db', 'users.ts'), ['export const table = "users2";']);
    reply.error = new JudgeError('offline', 'fake: no API key');
    await assert.rejects(compile(runOf()), /DOMAINS domains: the judge cannot give `src\/db\/users\.ts` its domain — fake: no API key/);
    reply.error = null;

    // a decider that answers outside the options leaves the file undecided
    write(join(tmp, 'src', 'db', 'users.ts'), ['export const table = "grey";']);
    await assert.rejects(compile(runOf(), async () => 'ui'), /`src\/db\/users\.ts` — api \(0\.50\) or persistence \(0\.50\)\?/);

    console.log('domain tagging tests passed.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
