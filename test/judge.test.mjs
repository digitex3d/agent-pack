// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge — a compile phase in which a model checks that `.ap` code is well
 * written. A rule is a TEMPLATE tagged `#judge`: its BODY layout names the lines
 * it applies to (`DO {action}` → DO lines), its slot rules are the checks, their
 * force the severity (MUST → error, SHOULD → warning). The judge's work is kept
 * in one unit per source, the decisions in the lock, so a second compilation
 * judges nothing. No network
 * here: a fake judge in the config, and a stubbed `fetch` for the Jev adapter.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const { loadConfig } = await import('../dist/src/config.js');
const { formatErrors } = await import('../dist/src/lint.js');
const { loadJudgeRules } = await import('../dist/src/judge/rules.js');
const { openJudgeRun, finishJudgeRun } = await import('../dist/src/judge/phase.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { bundleAllOnce } = await import('../dist/src/commands/bundle.js');
const { default: jevJudge } = await import('../dist/adapters/jev/index.js');

const CLI = resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
const write = (file, lines) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, lines.join('\n')); return file; };

/** Run `fn` with console.error / console.log captured; returns what was printed. */
async function captured(fn) {
  const out = [];
  const [err, log] = [console.error, console.log];
  console.error = (...a) => out.push(a.join(' '));
  console.log = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { console.error = err; console.log = log; }
  return out.join('\n');
}

const prevCwd = process.cwd();
const prevHome = process.env.AGENT_PACK_HOME;
const root = mkdtempSync(join(tmpdir(), 'ap-judge-'));
process.env.AGENT_PACK_HOME = join(root, 'user-home');

try {
  // --- LintError: file:line:col and [code] when present; unchanged otherwise ---
  assert.equal(formatErrors([{ file: 'a.ap', line: 3, col: 5, code: 'x.y.1', message: 'm', severity: 'warning' }]), 'warning  a.ap:3:5  [x.y.1] m');
  assert.equal(formatErrors([{ file: 'a.ap', line: 3, message: 'm' }]), 'error  a.ap:3  m');

  // --- rules: #judge templates of the libraries, the builtin one included ---
  {
    const lib = join(root, 'rules-lib');
    write(join(lib, 'templates', 'one-action.ap'), [
      'EXPORT TEMPLATE one-action:',
      '    ABOUT  test rule — one action per DO line',
      '    TAGS   #judge',
      '    SLOTS:',
      '        action: TEXT  "the action"',
      '            SHOULD  name one action',
      '            MUST    be written in English',
      '    BODY:',
      '        DO {action}',
      '',
    ]);
    write(join(lib, 'templates', 'when-rule.ap'), [
      'EXPORT TEMPLATE when-rule:',
      '    ABOUT  test rule for WHEN lines',
      '    TAGS   #judge',
      '    SLOTS:',
      '        trigger: TEXT  "the trigger"',
      '            SHOULD  name an observable event',
      '    BODY:',
      '        WHEN {trigger}:',
      '',
    ]);
    write(join(lib, 'templates', 'plain.ap'), [
      'EXPORT TEMPLATE plain:',
      '    ABOUT  not a rule — no #judge tag',
      '    SLOTS:',
      '        x: TEXT  "x"',
      '            SHOULD  be short',
      '    BODY:',
      '        DO {x}',
      '',
    ]);
    const rules = loadJudgeRules({ libraryRoot: lib, sharedLibraries: [], userRoot: '' });
    // Rules are keyed by their address; the fixtures are asserted, never the whole builtin set.
    const byId = Object.fromEntries(rules.map(r => [r.template.name, r]));
    assert.ok(byId['one-action'] && byId['when-rule'], 'the #judge templates of the library');
    assert.ok(!byId['plain'], 'a template without #judge is no rule');
    assert.ok(rules.some(r => r.template.namespace !== byId['one-action'].template.namespace), 'the builtin library\'s rules join them');
    assert.equal(byId['one-action'].id, byId['one-action'].template.address, 'a rule id is its template\'s address');
    assert.equal(byId['one-action'].primitive, 'DO', 'the first word of the layout is the primitive');
    assert.equal(byId['when-rule'].primitive, 'WHEN');
    assert.equal(byId['one-action'].template.name, 'one-action');
    assert.deepEqual(byId['one-action'].checks, [
      { id: 'one-action.action.1', statement: 'name one action', force: { keyword: 'SHOULD', level: 0 } },
      { id: 'one-action.action.2', statement: 'be written in English', force: { keyword: 'MUST', level: 0 } },
    ], 'asChecks(): the slot rules verbatim, id <template>.<slot>.<n>');
    assert.deepEqual(byId['one-action'].template.asChecks(), byId['one-action'].checks);

    for (const [keyword, word] of [['ALWAYS', 'ALWAYS'], ['MUST-NOT', 'a negative rule'], ['MAY', 'MAY'], ['NEVER', 'a negative rule']]) {
      const bad = join(root, `bad-${keyword}`);
      write(join(bad, 'templates', 'bad.ap'), [
        'EXPORT TEMPLATE bad-rule:', '    ABOUT  a bad rule', '    TAGS   #judge', '    SLOTS:',
        '        action: TEXT  "the action"', `            ${keyword}  be short`, '    BODY:', '        DO {action}', '',
      ]);
      assert.throws(() => loadJudgeRules({ libraryRoot: bad, sharedLibraries: [], userRoot: '' }),
        new RegExp(`bad-rule.*${word}.*MUST or SHOULD`), `${keyword} on a #judge rule is a load error`);
    }
    const noBody = join(root, 'no-body');
    write(join(noBody, 'templates', 'nb.ap'), [
      'EXPORT TEMPLATE no-layout:', '    ABOUT  no layout', '    TAGS   #judge', '    SLOTS:',
      '        action: TEXT  "the action"', '            SHOULD  be short', '',
    ]);
    assert.throws(() => loadJudgeRules({ libraryRoot: noBody, sharedLibraries: [], userRoot: '' }), /no-layout.*BODY/, 'a rule needs a layout to name its lines');

    // A project rule named like a builtin one is a rule of its own.
    const twin = join(root, 'twin-lib');
    write(join(twin, 'templates', 'judge-do-line.ap'), [
      'EXPORT TEMPLATE judge-do-line:', '    ABOUT  a project rule named like the builtin one', '    TAGS   #judge', '    SLOTS:',
      '        action: TEXT  "the action"', '            SHOULD  name a project file', '    BODY:', '        DO {action}', '',
    ]);
    const twins = loadJudgeRules({ libraryRoot: twin, sharedLibraries: [], userRoot: '' }).filter(r => r.template.name === 'judge-do-line');
    assert.equal(twins.length, 2, 'both the project and the builtin judge-do-line are loaded');
    assert.notEqual(twins[0].id, twins[1].id, 'two rules of the same name have distinct ids');
  }

  // --- the lock: a decision without a p in 0..1 is a load error naming its key ---
  {
    const { JudgeLock } = await import('../dist/src/judge/lock.js');
    const bad = join(root, 'bad.judge.lock');
    for (const v of [{ by: 'human' }, { p: 'high', by: 'human' }, { p: 2 }, null]) {
      writeFileSync(bad, JSON.stringify({ version: 1, judge: 'fake', model: null, decisions: { abc123: v } }));
      assert.throws(() => JudgeLock.load(bad, 'fake'), /"abc123".*p between 0 and 1/, `rejected: ${JSON.stringify(v)}`);
    }
    // Pinning creates a missing directory; nothing pinned, nothing written.
    const nested = JudgeLock.load(join(root, 'no', 'such', 'dir', 'x.lock'), 'fake');
    nested.save();
    assert.ok(!existsSync(join(root, 'no', 'such', 'dir', 'x.lock')), 'no model pinned: no lock written');
    nested.pin('fake-1.0');
    nested.save();
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'no', 'such', 'dir', 'x.lock'), 'utf-8')),
      { version: 1, judge: 'fake', model: 'fake-1.0', decisions: {} }, 'the missing directory is created');
  }

  // --- units: a source in the project is named from its root, one in a library outside it by its alias ---
  {
    const { UnitStore } = await import('../dist/src/judge/units.js');
    const unitsAt = join(root, 'p', '.agent-pack', 'units');
    const libs = { '@builtin': join(root, 'pkg', 'templates', 'library'), '@shared': join(root, 'shared') };
    const store = new UnitStore(unitsAt, join(root, 'p'), 'm-1', libs);
    assert.equal(store.pathOf(join(root, 'p', 'agents', 'a.ap')), join(unitsAt, 'agents', 'a.ap.json'));
    assert.equal(store.sourceName(join(root, 'p', 'agents', 'a.ap')), 'agents/a.ap');
    const builtin = join(libs['@builtin'], 'templates', 'judge-do-line.ap');
    assert.equal(store.sourceName(builtin), '@builtin/templates/judge-do-line.ap', 'a library source outside the project: its alias, then its path in the library');
    assert.equal(store.pathOf(builtin), join(unitsAt, '_external', '@builtin', 'templates', 'judge-do-line.ap.json'));
    assert.equal(store.sourceName(join(root, 'shared', 'x.ap')), '@shared/x.ap');
    assert.ok(!store.sourceName(builtin).includes(root), 'no machine path in the name');
    const outside = join(root, 'elsewhere', 'lib', 'x.ap');
    assert.match(store.pathOf(outside).slice(unitsAt.length), /^\/_external\/[0-9a-f]{12}\/x\.ap\.json$/, 'a source in no library: the hash of its directory');
    assert.equal(store.pathOf(outside), store.pathOf(outside), 'deterministic');
    assert.notEqual(store.pathOf(outside), store.pathOf(join(root, 'other', 'x.ap')), 'two directories, two units');
    assert.ok(!store.sourceName(outside).includes(root), '… and no machine path either');

    // Two units disagreeing on a key: the first in sorted path order wins, whatever the directory order.
    const unit = (p, model = 'm-1') => JSON.stringify({ version: 1, source: 's', model, hash: 'h', rules: 'r', verdicts: { k1: { p } }, diagnostics: [] });
    write(join(unitsAt, 'b.ap.json'), [unit(0.2)]);
    write(join(unitsAt, 'a.ap.json'), [unit(0.7)]);
    assert.equal(new UnitStore(unitsAt, join(root, 'p'), 'm-1', libs).verdict('k1'), 0.7, 'a conflicting key: the first unit in sorted order');
    // A unit of another model holds no verdict this run may use; one written before units named their model is the lock's.
    write(join(unitsAt, 'a.ap.json'), [unit(0.7, 'm-0')]);
    assert.equal(new UnitStore(unitsAt, join(root, 'p'), 'm-1', libs).verdict('k1'), 0.2, 'another model\'s verdict is not used');
    write(join(unitsAt, 'b.ap.json'), [JSON.stringify({ version: 1, source: 's', hash: 'h', rules: 'r', verdicts: { k1: { p: 0.4 } }, diagnostics: [] })]);
    assert.equal(new UnitStore(unitsAt, join(root, 'p'), 'm-1', libs).verdict('k1'), 0.4, 'a unit with no model: the lock\'s');
    assert.equal(new UnitStore(unitsAt, join(root, 'p'), null, libs).verdict('k1'), undefined, 'no model pinned: no saved verdict is used');
  }

  // --- config: the `judge` key, its defaults, built-in judges by name ---
  {
    const dir = join(root, 'cfg');
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    write(join(dir, 'a.config.mjs'), ["export default { judge: { adapter: 'jev' } };", '']);
    const config = await loadConfig(['--config', join(dir, 'a.config.mjs')]);
    assert.equal(config.judge.adapter.name, 'jev', 'a built-in judge by name');
    assert.equal(config.judge.adapter.type, 'judge');
    assert.equal(config.judge.threshold, 0.5);
    assert.equal(config.judge.offline, 'warn');
    assert.equal(config.judge.concurrency, 8);
    assert.equal(config.judge.lock, join(dir, 'agent-pack.judge.lock'), 'the lock sits in the project root');
    write(join(dir, 'b.config.mjs'), ['export default {};', '']);
    assert.equal((await loadConfig(['--config', join(dir, 'b.config.mjs')])).judge, null, 'no `judge` key: the phase is off');
    write(join(dir, 'c.config.mjs'), ["export default { judge: { adapter: 'nope' } };", '']);
    await assert.rejects(loadConfig(['--config', join(dir, 'c.config.mjs')]), /Unknown judge "nope" — built-in judges: jev/);
    write(join(dir, 'd.config.mjs'), ["export default { judge: { adapter: 'jev', offline: 'maybe' } };", '']);
    await assert.rejects(loadConfig(['--config', join(dir, 'd.config.mjs')]), /judge\.offline/);
    write(join(dir, 'e.config.mjs'), ["export default { judge: { adapter: 'jev', threshold: 2 } };", '']);
    await assert.rejects(loadConfig(['--config', join(dir, 'e.config.mjs')]), /judge\.threshold/);
    process.chdir(prevCwd);
  }

  // --- a project judged by a fake judge ---
  const proj = join(root, 'proj');
  const ruleFile = write(join(proj, 'library', 'templates', 'one-action.ap'), [
    'EXPORT TEMPLATE one-action:',
    '    ABOUT  test rule — one action per DO line',
    '    TAGS   #judge',
    '    SLOTS:',
    '        action: TEXT  "the action"',
    '            SHOULD  name one action',
    '            SHOULD  be written in English',
    '    BODY:',
    '        DO {action}',
    '',
  ]);
  const sharedFile = write(join(proj, 'library', 'procedures', 'shared.ap'), [
    'EXPORT PROCEDURE wrap-up:',            // 1
    '    ABOUT  wrap up',                   // 2
    '    DO  commit and push the work',     // 3
    '',
  ]);
  const alphaLines = [
    'IMPORT wrap-up FROM @main.procedures', // 1
    '',                                     // 2
    'EXPORT AGENT alpha AS alpha-role:',    // 3
    '    ABOUT    alpha',                   // 4
    '    MANDATE  do alpha things',         // 5
    '    DO  read the task',                // 6
    '    DO  lire la tâche',                // 7
    '    WHEN done:',                       // 8
    '        RUN  wrap-up',                 // 9
    '',                                     // 10
    'ROLE alpha-role:',                     // 11
    '    ABOUT   a worker',                 // 12
    '    ALWAYS  test first',               // 13
    '',
  ];
  const alphaFile = write(join(proj, 'agents', 'standalone', 'alpha.ap'), alphaLines);
  write(join(proj, 'agents', 'standalone', 'beta.ap'), [
    'IMPORT wrap-up FROM @main.procedures',
    '',
    'EXPORT AGENT beta AS beta-role:',
    '    ABOUT    beta',
    '    MANDATE  do beta things',
    '    DO  read the task',
    '    WHEN done:',
    '        RUN  wrap-up',
    '',
    'ROLE beta-role:',
    '    ABOUT   a worker',
    '    ALWAYS  test first',
    '',
  ]);
  write(join(proj, 'agent-pack.config.mjs'), [
    'export default {',
    "  libraryRoot: 'library',",
    "  agentsDir: 'agents',",
    "  adapters: ['claude-code'],",
    "  judge: { adapter: { type: 'judge', name: 'fake', ask: (...a) => globalThis.__judgeAsk(...a) }, concurrency: 2 },",
    '};',
    '',
  ]);

  /** The fake judge: low p for the two planted faults, high for everything else. */
  const asks = [];
  let inflight = 0, maxInflight = 0, down = false;
  globalThis.__judgeAsk = async (state, checks, model) => {
    asks.push({ state, ids: checks.map(c => c.id), model });
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 5));
    inflight--;
    if (down) throw new Error('fake judge unreachable');
    const p = c => c.id === 'one-action.action.1' && state === 'commit and push the work' ? 0.1
      : c.id === 'one-action.action.2' && state === 'lire la tâche' ? 0.2 : 0.95;
    return { model: model ?? 'fake-1.0', answers: Object.fromEntries(checks.map(c => [c.id, p(c)])) };
  };
  const askedStates = () => asks.map(a => a.state);

  process.chdir(proj);
  const config = await loadConfig([]);
  const lockPath = join(proj, 'agent-pack.judge.lock');
  const unitsRoot = join(proj, '.agent-pack', 'units');
  const unitPath = file => join(unitsRoot, `${file.slice(proj.length + 1)}.json`);
  const opts = name => ({
    agentName: name, agentFile: join(proj, 'agents', 'standalone', `${name}.ap`), agentDir: join(proj, 'agents', 'standalone'),
    libraryRoot: config.libraryRoot, libraryRoots: [config.libraryRoot], libraries: { '@main': config.libraryRoot }, bundleConfig: { runtime: false },
  });
  const compileBoth = async run => {
    await bundleAgentObject({ ...opts('alpha'), judge: run });
    await bundleAgentObject({ ...opts('beta'), judge: run });
  };
  const readLock = () => JSON.parse(readFileSync(lockPath, 'utf-8'));
  const readUnit = file => JSON.parse(readFileSync(unitPath(file), 'utf-8'));
  const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const ours = run => run.warnings.filter(w => w.code.startsWith('one-action.'));
  const where = w => `${w.file}:${w.line}:${w.col}-${w.endCol} ${w.severity} [${w.code}] p=${w.data.p} source=${w.source}`;

  // --- first run: diagnostics at file:line:col, severity from force, shared lines asked once ---
  let firstWarnings;
  {
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    const warnings = ours(run);
    firstWarnings = warnings;
    assert.deepEqual(warnings.map(where).sort(), [
      `${alphaFile}:7:5-22 warning [one-action.action.2] p=0.2 source=judge`,
      `${sharedFile}:3:5-33 warning [one-action.action.1] p=0.1 source=judge`,
    ].sort(), 'one warning per failed check, at the line, once even when two agents share the line');
    assert.ok(warnings.every(w => /^[0-9a-f]{16}$/.test(w.data.key)), 'each diagnostic carries its verdict key');
    assert.equal(asks.filter(a => a.ids.includes('one-action.action.1') && a.state === 'commit and push the work').length, 1, 'a line shared by two agents: one request per rule');
    assert.equal(asks.filter(a => a.ids.includes('one-action.action.1') && a.state === 'read the task').length, 1, 'the same text in two agents is asked once');
    assert.equal(asks[0].model, undefined, 'nothing pinned yet: the judge picks its model');
    assert.equal(asks.at(-1).model, 'fake-1.0', 'once answered, the model is pinned for the next requests');
    assert.ok(maxInflight <= 2, `judge.concurrency caps the requests in flight (saw ${maxInflight})`);

    const printed = await captured(() => finishJudgeRun(run, { prune: false }));
    assert.ok(printed.includes(`warning  ${sharedFile}:3:5  [one-action.action.1] `), printed);
    assert.ok(printed.includes(`warning  ${alphaFile}:7:5  [one-action.action.2] `), printed);
    const summary = printed.split('\n').filter(l => l.startsWith('judge: '));
    assert.equal(summary.length, 1, 'one summary line');
    const m = /^judge: (\d+) warnings — 3 files, 0 unchanged; (\d+) DO lines, (\d+) rule×line checks: (\d+) from saved verdicts, (\d+) asked, 0 not judged \(fake-1\.0\)$/.exec(summary[0]);
    assert.ok(m, summary[0]);
    assert.equal(Number(m[1]), run.warnings.length);
    assert.equal(Number(m[2]), new Set(asks.map(a => a.state)).size, 'lines: the distinct DO line texts, not rule×text pairs');
    assert.equal(Number(m[3]), asks.length, 'one rule×line check per request');
    assert.ok(Number(m[3]) > Number(m[2]), 'several rules per line');
    assert.equal(Number(m[4]), 0);
    assert.equal(Number(m[3]), Number(m[5]), 'every check asked on the first run');

    assert.deepEqual(readLock(), { version: 1, judge: 'fake', model: 'fake-1.0', decisions: {} }, 'the first run pins the model in the lock');
    const raw = readFileSync(lockPath, 'utf-8');
    for (const text of ['commit and push', 'read the task', 'lire la', 'name one action']) assert.ok(!raw.includes(text), `the lock does not reveal "${text}"`);

    // One unit per source file — the shared library file has one, for two agents.
    const shared = readUnit(sharedFile);
    assert.equal(shared.version, 1);
    assert.equal(shared.source, 'library/procedures/shared.ap', 'the source, from the project root');
    assert.equal(shared.hash, sha(readFileSync(sharedFile, 'utf-8')), 'the hash of the source text');
    assert.match(shared.rules, /^sha256:[0-9a-f]{64}$/);
    const keys = Object.keys(shared.verdicts);
    assert.ok(keys.length > 0 && keys.every(k => /^[0-9a-f]{16}$/.test(k)), 'keys are short hashes');
    assert.deepEqual(keys, [...keys].sort(), 'keys sorted');
    assert.equal(shared.verdicts[warnings.find(w => w.code === 'one-action.action.1').data.key].p, 0.1);
    assert.deepEqual(shared.diagnostics, [{
      line: 3, col: 5, endCol: 33, severity: 'warning', source: 'judge', code: 'one-action.action.1',
      message: warnings.find(w => w.code === 'one-action.action.1').message, data: { p: 0.1, key: warnings.find(w => w.code === 'one-action.action.1').data.key },
    }], 'the diagnostics of the file, a LintError less its file');
    assert.ok(existsSync(unitPath(alphaFile)) && existsSync(unitPath(join(proj, 'agents', 'standalone', 'beta.ap'))), 'each agent file has its unit');
    assert.equal(readUnit(alphaFile).diagnostics.length, run.warnings.filter(w => w.file === alphaFile).length);
  }

  // --- second run: every file unchanged — no lookup, no request, the same diagnostics, nothing written ---
  {
    asks.length = 0;
    const lockBefore = readFileSync(lockPath, 'utf-8');
    const lockTime = statSync(lockPath).mtimeMs;
    const unitsBefore = [alphaFile, sharedFile].map(f => readFileSync(unitPath(f), 'utf-8'));
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    assert.equal(asks.length, 0, 'a second run asks nothing');
    assert.equal(run.stats.pairs, 0, 'no verdict looked up: every file taken from its unit');
    assert.deepEqual(ours(run).map(where).sort(), firstWarnings.map(where).sort(), 'the same diagnostics, from the units');
    const printed = await captured(() => finishJudgeRun(run, { prune: false }));
    assert.match(printed, /judge: \d+ warnings — 3 files, 3 unchanged; 0 DO lines, 0 rule×line checks: 0 from saved verdicts, 0 asked, 0 not judged \(fake-1\.0\)/);
    assert.equal(readFileSync(lockPath, 'utf-8'), lockBefore, 'the lock is never rewritten once the model is pinned');
    assert.equal(statSync(lockPath).mtimeMs, lockTime);
    assert.deepEqual([alphaFile, sharedFile].map(f => readFileSync(unitPath(f), 'utf-8')), unitsBefore, 'the units untouched');
  }

  // --- a changed line text is re-asked, alone, with the pinned model; the other files are not judged ---
  {
    asks.length = 0;
    write(alphaFile, alphaLines.map(l => l.replace('DO  read the task', 'DO  read the whole task')));
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    assert.deepEqual([...new Set(askedStates())], ['read the whole task'], 'only the edited line is asked');
    assert.ok(asks.every(a => a.model === 'fake-1.0'), 'later requests use the pinned model');
    assert.deepEqual([...run.files].filter(([, f]) => f.rejudged).map(([file]) => file), [alphaFile], 'only the edited file is judged');
    assert.deepEqual(ours(run).map(where).sort(), firstWarnings.map(where).sort(), 'the untouched lines keep their verdicts');
    await captured(() => finishJudgeRun(run, { prune: false }));
    assert.equal(readUnit(alphaFile).hash, sha(readFileSync(alphaFile, 'utf-8')), 'the unit follows the source');
    write(alphaFile, alphaLines);
  }

  // --- the threshold, the model, the rules: a change re-judges every file ---
  {
    // the unit of the restored alpha.ap, so that every file starts unchanged
    await captured(async () => { const run = openJudgeRun(config, proj); await compileBoth(run); finishJudgeRun(run, { prune: false }); });
    asks.length = 0;
    const lower = openJudgeRun({ ...config, judge: { ...config.judge, threshold: 0.15 } }, proj);
    await compileBoth(lower);
    assert.ok([...lower.files.values()].every(f => f.rejudged), 'a threshold change re-judges every file');
    assert.equal(asks.length, 0, '… from the saved verdicts');
    assert.deepEqual(ours(lower).map(w => w.code), ['one-action.action.1'], 'only p=0.1 is below 0.15');
    await captured(() => finishJudgeRun(lower, { prune: false }));
    await captured(async () => { const run = openJudgeRun(config, proj); await compileBoth(run); finishJudgeRun(run, { prune: false }); });

    const lock = readLock();
    const readKey = Object.keys(readUnit(alphaFile).verdicts);
    assert.equal(readUnit(alphaFile).model, 'fake-1.0', 'a unit names the model of its verdicts');
    const before = readUnit(alphaFile).verdicts;
    writeFileSync(lockPath, JSON.stringify({ ...lock, model: 'fake-2.0' }, null, 2) + '\n');
    const saved = globalThis.__judgeAsk;
    // fake-2.0 judges "read the task" otherwise
    globalThis.__judgeAsk = async (state, checks, model) => {
      const answer = await saved(state, checks, model);
      if (model === 'fake-2.0' && state === 'read the task') for (const id of Object.keys(answer.answers)) answer.answers[id] = 0.3;
      return answer;
    };
    asks.length = 0;
    const other = openJudgeRun(config, proj);
    await compileBoth(other);
    assert.ok([...other.files.values()].every(f => f.rejudged), 'a model change in the lock re-judges every file');
    assert.equal(other.stats.cached, 0, 'a model change: no saved verdict is used');
    assert.equal(asks.length, other.stats.pairs, '… every line is asked again');
    assert.ok(asks.length > 0 && asks.every(a => a.model === 'fake-2.0'), '… of the new model');
    await captured(() => finishJudgeRun(other, { prune: false }));
    assert.equal(readLock().model, 'fake-2.0', 'the judge does not rewrite a pinned lock');
    const after = readUnit(alphaFile);
    assert.equal(after.model, 'fake-2.0', 'the unit names the new model');
    const moved = Object.keys(after.verdicts).filter(k => before[k]?.p !== after.verdicts[k].p);
    assert.ok(moved.length > 0 && moved.every(k => after.verdicts[k].p === 0.3), 'the verdicts the new model moved are in the unit');
    assert.ok(Object.keys(after.verdicts).every(k => readKey.includes(k)), 'the same keys: a verdict key does not name the model');
    globalThis.__judgeAsk = saved;

    // Back to the old model: asked again, the units follow.
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    asks.length = 0;
    await captured(async () => { const run = openJudgeRun(config, proj); await compileBoth(run); finishJudgeRun(run, { prune: false }); });
    assert.ok(asks.length > 0 && asks.every(a => a.model === 'fake-1.0'), 'the old model again: every line asked of it');
    const back = readUnit(alphaFile).verdicts;
    assert.ok(Object.keys(back).every(k => back[k].p === before[k].p), 'the old model\'s verdicts again');

    // No lock while units exist: no saved verdict is trusted, the first answer pins the model again.
    rmSync(lockPath);
    asks.length = 0;
    const fresh = openJudgeRun(config, proj);
    await compileBoth(fresh);
    assert.equal(fresh.stats.cached, 0, 'no pinned model: the units\' verdicts are not used');
    assert.equal(asks[0].model, undefined, 'the judge picks its model');
    await captured(() => finishJudgeRun(fresh, { prune: false }));
    assert.deepEqual(readLock(), lock, 'the model is pinned again');
    assert.equal(readUnit(alphaFile).model, 'fake-1.0', 'no unit is written against no model');
  }

  // --- a human decision in the lock wins; a changed rule text re-asks ---
  {
    const key = firstWarnings.find(w => w.code === 'one-action.action.1').data.key;
    const lock = readLock();
    lock.decisions[key] = { p: 1, by: 'human' };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    const decided = readFileSync(lockPath, 'utf-8');

    asks.length = 0;
    const human = openJudgeRun(config, proj);
    await compileBoth(human);
    assert.equal(asks.length, 0, 'a decision asks nothing');
    assert.ok(!human.warnings.some(w => w.code === 'one-action.action.1'), 'the human decision wins: no warning');
    await captured(() => finishJudgeRun(human, { prune: false }));
    assert.equal(readUnit(sharedFile).verdicts[key].p, 0.1, 'the unit keeps the judge\'s own verdict');
    assert.deepEqual(readUnit(sharedFile).diagnostics, [], '… and the diagnostics the decision leaves');

    write(ruleFile, readFileSync(ruleFile, 'utf-8').split('\n').map(l => l.replace('be written in English', 'be written in plain English')));
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    assert.ok(askedStates().includes('commit and push the work') && askedStates().includes('read the task'), 'a rule text change re-asks its lines');
    assert.ok(!run.warnings.some(w => w.code === 'one-action.action.1'), 'the human decision holds: no warning');
    await captured(() => finishJudgeRun(run, { prune: false }));
    assert.equal(readFileSync(lockPath, 'utf-8'), decided, 'the judge never rewrites the lock');
  }

  // --- a line whose every check a human decided: never asked, and its file unchanged on the next run ---
  {
    const { verdictKey } = await import('../dist/src/judge/lock.js');
    const text = 'sign the release';
    const keys = loadJudgeRules(config).filter(r => r.primitive === 'DO').flatMap(r => r.checks.map(c => verdictKey(c, text)));
    const lock = readLock();
    writeFileSync(lockPath, JSON.stringify({ ...lock, decisions: { ...lock.decisions, ...Object.fromEntries(keys.map(k => [k, { p: 1, by: 'human' }])) } }, null, 2) + '\n');
    write(alphaFile, alphaLines.map(l => l.replace('DO  read the task', `DO  ${text}`)));
    asks.length = 0;
    await captured(async () => { const run = openJudgeRun(config, proj); await compileBoth(run); finishJudgeRun(run, { prune: false }); });
    assert.ok(!askedStates().includes(text), 'a line all decided is not asked');
    const again = openJudgeRun(config, proj);
    await compileBoth(again);
    assert.equal(again.files.get(alphaFile).rejudged, false, 'its file is taken from its unit on the next run');
    assert.equal(again.stats.pairs, 0);
    await captured(() => finishJudgeRun(again, { prune: false }));
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    write(alphaFile, alphaLines);
  }

  // --- offline: no saved verdict and no judge → warn (default) or error; the unit is kept for a retry ---
  {
    down = true;
    const unitBefore = readFileSync(unitPath(alphaFile), 'utf-8');
    write(alphaFile, alphaLines.map(l => l.replace('DO  read the task', 'DO  read the brand new task')));
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    const offline = run.warnings.filter(w => w.file === alphaFile && w.line === 6);
    assert.ok(offline.length > 0 && offline.every(w => /not judged yet/.test(w.message) && w.severity === 'warning'), JSON.stringify(run.warnings));
    const printed = await captured(() => finishJudgeRun(run, { prune: false }));
    assert.match(printed, /fake judge unreachable/, 'the reason is printed once');
    assert.equal(readFileSync(unitPath(alphaFile), 'utf-8'), unitBefore, 'a file not fully judged keeps its old unit');

    const strict = openJudgeRun({ ...config, judge: { ...config.judge, offline: 'error' } }, proj);
    await assert.rejects(bundleAgentObject({ ...opts('alpha'), judge: strict }), new RegExp(`alpha\\.ap:6:5  \\[[a-z.-]+\\.1\\] not judged yet`));
    await captured(() => finishJudgeRun(strict, { prune: false }));
    down = false;
    asks.length = 0;
    const retry = openJudgeRun(config, proj);
    await compileBoth(retry);
    assert.ok(askedStates().includes('read the brand new task'), 'the next run retries the line');
    await captured(() => finishJudgeRun(retry, { prune: false }));
    write(alphaFile, alphaLines);
  }

  // --- a MUST rule fails the agent with an error at the line ---
  {
    const strictRule = write(join(proj, 'library', 'templates', 'english.ap'), [
      'EXPORT TEMPLATE english:', '    ABOUT  test rule', '    TAGS   #judge', '    SLOTS:',
      '        action: TEXT  "the action"', '            MUST  be written in English', '    BODY:', '        DO {action}', '',
    ]);
    const saved = globalThis.__judgeAsk;
    globalThis.__judgeAsk = async (state, checks, model) => ({
      model: model ?? 'fake-1.0',
      answers: Object.fromEntries(checks.map(c => [c.id, c.id === 'english.action.1' && state === 'lire la tâche' ? 0.05 : 0.95])),
    });
    const run = openJudgeRun(config, proj);
    await assert.rejects(bundleAgentObject({ ...opts('alpha'), judge: run }), /alpha\.ap:7:5  \[english\.action\.1\] /);
    await captured(() => finishJudgeRun(run, { prune: false }));
    const again = openJudgeRun(config, proj);
    await assert.rejects(bundleAgentObject({ ...opts('alpha'), judge: again }), /alpha\.ap:7:5  \[english\.action\.1\] /, 'an unchanged file fails from its unit too');
    assert.equal(again.stats.pairs, 0);
    await captured(() => finishJudgeRun(again, { prune: false }));
    rmSync(strictRule);
    globalThis.__judgeAsk = saved;
  }

  // --- a line failure (kind 'line') leaves only that line not judged; the judge stays online ---
  {
    const saved = globalThis.__judgeAsk;
    globalThis.__judgeAsk = async (state, checks, model) => {
      if (state === 'lire la tâche') throw Object.assign(new Error('HTTP 503 — busy'), { kind: 'line' });
      return { model: model ?? 'fake-1.0', answers: Object.fromEntries(checks.map(c => [c.id, 0.95])) };
    };
    // a new rule text: every line is asked again
    write(ruleFile, readFileSync(ruleFile, 'utf-8').split('\n').map(l => l.replace('name one action', 'name a single action')));
    const run = openJudgeRun(config, proj);
    await compileBoth(run);
    assert.equal(run.offlineReason, null, 'a line failure does not take the judge offline');
    const notJudged = run.warnings.filter(w => /not judged yet/.test(w.message));
    assert.ok(notJudged.length > 0 && notJudged.every(w => w.file === alphaFile && w.line === 7 && /fake failed on this line: HTTP 503 — busy/.test(w.message)),
      JSON.stringify(run.warnings));
    assert.ok(run.stats.asked > 0, 'the rest of the queue is still asked');
    const printed = await captured(() => finishJudgeRun(run, { prune: false }));
    assert.match(printed, new RegExp(`, ${run.stats.notJudged} not judged \\(`));
    assert.ok(run.stats.notJudged > 0);
    globalThis.__judgeAsk = saved;
  }

  // --- a lock that cannot be written: one line, no crash ---
  {
    const blocker = join(root, 'a-file');
    writeFileSync(blocker, 'x');
    write(alphaFile, alphaLines.map(l => l.replace('DO  read the task', 'DO  read yet another task')));
    const run = openJudgeRun({ ...config, judge: { ...config.judge, lock: join(blocker, 'x.lock') } }, proj);
    await compileBoth(run);
    const printed = await captured(() => finishJudgeRun(run, { prune: false }));
    assert.match(printed, /^\[agent-pack\] judge: could not save the lock — /m);
    write(alphaFile, alphaLines);
  }

  // --- prune: after a clean bundle all, each unit holds only what its lines use, and units of unused sources go ---
  {
    const gone = readUnit(alphaFile).diagnostics.find(d => d.code === 'one-action.action.2').data.key;
    assert.ok(gone in readUnit(alphaFile).verdicts);
    const orphan = join(unitsRoot, 'library', 'procedures', 'removed.ap.json');
    const external = join(unitsRoot, '_external', '0123456789ab', 'old.ap.json');
    for (const f of [orphan, external]) write(f, ['{}']);
    write(alphaFile, alphaLines.filter(l => !l.includes('lire la tâche')));
    // a decision a line still uses, next to one whose rule text was edited since
    const { verdictKey } = await import('../dist/src/judge/lock.js');
    const oneAction = loadJudgeRules(config).find(r => r.template.name === 'one-action');
    const used = verdictKey(oneAction.checks[1], 'commit and push the work');
    const lockBefore = readLock();
    writeFileSync(lockPath, JSON.stringify({ ...lockBefore, decisions: { ...lockBefore.decisions, [used]: { p: 1, by: 'human' } } }, null, 2) + '\n');
    const printed = await captured(async () => {
      const ok = await bundleAllOnce(config, config.adapters, { projectRoot: proj, outputDir: config.outputDir });
      assert.ok(ok, 'the bundle all is clean');
    });
    assert.equal(printed.split('\n').filter(l => l.startsWith('judge: ')).length, 1, 'bundle all prints one summary');
    assert.ok(!(gone in readUnit(alphaFile).verdicts), 'the removed line\'s verdict is pruned');
    assert.ok(!existsSync(orphan) && !existsSync(external), 'the units of sources no agent uses are deleted');
    assert.ok(!existsSync(join(unitsRoot, '_external')), '… and the directories left empty');
    assert.ok(existsSync(unitPath(sharedFile)), 'a used source keeps its unit');
    const human = firstWarnings.find(w => w.code === 'one-action.action.1').data.key;
    assert.deepEqual(readLock().decisions[human], { p: 1, by: 'human' }, 'a human decision stays');
    const orphans = printed.split('\n').filter(l => /decision/.test(l));
    assert.equal(orphans.length, 1, `one line names the decisions no line uses: ${printed}`);
    assert.ok(orphans[0].includes(human) && !orphans[0].includes(used), orphans[0]);
    assert.deepEqual(Object.keys(readLock().decisions).sort(), [human, used].sort(), 'reported, never deleted');
    writeFileSync(lockPath, JSON.stringify(lockBefore, null, 2) + '\n');
    write(alphaFile, alphaLines);
  }

  // --- a library file shared by two agents, edited: bundling one agent keeps the other's verdicts ---
  {
    const two = write(join(proj, 'library', 'procedures', 'two.ap'), [
      'EXPORT PROCEDURE step-one:', '    ABOUT  one', '    DO  open the ticket', '',
      'EXPORT PROCEDURE step-two:', '    ABOUT  two', '    DO  close the ticket', '',
    ]);
    const agent = (name, proc) => write(join(proj, 'agents', 'standalone', `${name}.ap`), [
      `IMPORT ${proc} FROM @main.procedures`, '', `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`,
      `    MANDATE  do ${name} things`, '    WHEN asked:', `        RUN  ${proc}`, '',
      `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  test first', '',
    ]);
    const files = [two, agent('gamma', 'step-one'), agent('delta', 'step-two')];
    const bundle = async (...names) => captured(async () => {
      const run = openJudgeRun(config, proj);
      for (const name of names) await bundleAgentObject({ ...opts(name), judge: run });
      finishJudgeRun(run, { prune: false });
    });
    await bundle('gamma', 'delta');
    write(two, readFileSync(two, 'utf-8').split('\n').map(l => l.replace('open the ticket', 'open the new ticket')));
    asks.length = 0;
    await bundle('gamma');
    assert.deepEqual([...new Set(askedStates())], ['open the new ticket'], 'the edited line is asked');
    asks.length = 0;
    await bundle('delta');
    assert.equal(asks.length, 0, 'the other agent\'s unchanged line is not asked again');
    for (const f of files) rmSync(f);
  }
  process.chdir(prevCwd);

  // --- the CLI: --no-judge, --judge-strict, offline warn by default ---
  {
    const cli = join(root, 'cli');
    write(join(cli, 'agents', 'standalone', 'solo.ap'), [
      'EXPORT AGENT solo AS solo-role:', '    ABOUT    solo', '    MANDATE  work alone', '    DO  read the task', '',
      'ROLE solo-role:', '    ABOUT   a worker', '    ALWAYS  test first', '',
    ]);
    write(join(cli, 'agent-pack.config.mjs'), [
      'export default {',
      "  adapters: ['claude-code'],",
      "  judge: { adapter: { type: 'judge', name: 'down', ask: async () => { throw new Error('judge down') } } },",
      '};',
      '',
    ]);
    const run = (...args) => spawnSync(process.execPath, [CLI, 'bundle', ...args], { cwd: cli, encoding: 'utf-8', env: { ...process.env } });
    const warn = run('all');
    assert.equal(warn.status, 0, warn.stderr);
    assert.match(warn.stderr, /warning {2}\S*solo\.ap:4:5 {2}\[judge-do-line\.action\.1\] not judged yet/);
    assert.equal(warn.stderr.split('\n').filter(l => l.startsWith('judge: ')).length, 1, warn.stderr);
    const strict = run('all', '--judge-strict');
    assert.equal(strict.status, 1, 'offline with --judge-strict fails');
    assert.match(strict.stderr, /error {2}\S*solo\.ap:4:5 {2}\[judge-do-line\.action\.1\] not judged yet/);
    const single = run('solo', '--judge-strict');
    assert.equal(single.status, 1, '`bundle <name>` honours --judge-strict');
    const off = run('all', '--no-judge');
    assert.equal(off.status, 0, off.stderr);
    assert.ok(!/judge/.test(off.stderr), `--no-judge skips the phase: ${off.stderr}`);
    assert.ok(!existsSync(join(cli, 'agent-pack.judge.lock')), 'no answer, no lock');
    assert.ok(!existsSync(join(cli, '.agent-pack', 'units')), 'nothing judged, no unit');
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf-8' });
    assert.match(help.stdout, /--no-judge/);
    assert.match(help.stdout, /--judge-strict/);
  }

  // --- the Jev adapter: request shape, model pinning, the key never leaks ---
  {
    const KEY = 'sk-FAKE-KEY-0123456789';
    const prevKey = process.env.TYPESAFE_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.TYPESAFE_API_KEY = KEY;
    const checks = [
      { id: 'r.action.1', statement: 'name one action', force: { keyword: 'SHOULD', level: 0 } },
      { id: 'r.action.2', statement: 'be written in English', force: { keyword: 'MUST', level: 0 } },
    ];
    const seen = [];
    let reply = () => null;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, init, body });
      const r = reply(body);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const jev = jevJudge();
      assert.equal(jev.type, 'judge');
      assert.equal(jev.name, 'jev');
      reply = body => ({
        json: {
          model: body.model === 'jev-latest' ? 'jev-1.13.0' : body.model,
          answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, { noul: q.instructions.includes('English') ? 0.3 : 0.8 }])),
        },
      });
      const first = await jev.ask('fetch the code', checks);
      assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(seen[0].init.method, 'POST');
      assert.equal(new Headers(seen[0].init.headers).get('authorization'), `Bearer ${KEY}`);
      assert.equal(seen[0].body.model, 'jev-latest', 'the default model until one is pinned');
      assert.equal(seen[0].body.state, 'fetch the code');
      const questions = Object.values(seen[0].body.questions);
      assert.equal(questions.length, 2, 'one question per check');
      assert.ok(questions.every(q => q.type === 'noul'));
      assert.ok(questions.some(q => q.instructions.includes('"name one action"')) && questions.some(q => q.instructions.includes('"be written in English"')));
      assert.deepEqual(first, { model: 'jev-1.13.0', answers: { 'r.action.1': 0.8, 'r.action.2': 0.3 } }, 'answers by check id, the model the judge reports');
      await jev.ask('fetch the code', checks, 'jev-1.13.0');
      assert.equal(seen[1].body.model, 'jev-1.13.0', 'a pinned model is sent as is');

      assert.ok(seen[0].init.signal instanceof AbortSignal, 'every request carries a timeout signal');

      const printed = await captured(async () => {
        // offline: the key rejected
        for (const status of [401, 403]) {
          reply = () => ({ status, json: { error: `invalid key ${KEY}` } });
          await assert.rejects(jev.ask('x', checks), e => e.kind === 'offline' && new RegExp(String(status)).test(e.message) && !e.message.includes(KEY) && !String(e.stack).includes(KEY));
        }
        // line: 5xx and 429 retried once, then this line only
        for (const status of [500, 429]) {
          seen.length = 0;
          reply = () => ({ status, json: { error: `oops Bearer ${KEY}` } });
          await assert.rejects(jev.ask('x', checks), e => e.kind === 'line' && new RegExp(String(status)).test(e.message) && !e.message.includes(KEY));
          assert.equal(seen.length, 2, `a ${status} is retried once`);
        }
        seen.length = 0;
        let calls = 0;
        reply = () => (++calls === 1 ? { status: 503, json: {} } : { json: { model: 'jev-1.13.0', answers: { q1: { noul: 0.9 }, q2: { noul: 0.9 } } } });
        assert.deepEqual((await jev.ask('x', checks)).answers, { 'r.action.1': 0.9, 'r.action.2': 0.9 }, 'a retry that succeeds answers');
        seen.length = 0;
        reply = () => ({ status: 400, json: { error: 'bad request' } });
        await assert.rejects(jev.ask('x', checks), e => e.kind === 'line' && /400/.test(e.message));
        assert.equal(seen.length, 1, 'a 400 is not retried');
        reply = () => ({ json: { model: 'jev-1.13.0', answers: {} } });
        await assert.rejects(jev.ask('x', checks), e => e.kind === 'line' && /answer/.test(e.message) && !e.message.includes(KEY));
        // offline: unreachable, timed out
        globalThis.fetch = async () => { throw new TypeError(`connect failed with Bearer ${KEY}`); };
        await assert.rejects(jev.ask('x', checks), e => e.kind === 'offline' && /unreachable/.test(e.message) && !e.message.includes(KEY) && !String(e.stack).includes(KEY));
        globalThis.fetch = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
        await assert.rejects(jev.ask('x', checks), e => e.kind === 'offline' && /unreachable.*timeout/.test(e.message));
      });
      assert.ok(!printed.includes(KEY), 'nothing printed carries the key');

      delete process.env.TYPESAFE_API_KEY;
      const prevHomeDir = process.env.HOME;
      process.env.HOME = join(root, 'no-key-home');
      try {
        await assert.rejects(jevJudge().ask('x', checks), e => e.kind === 'offline' && /no API key/.test(e.message));
      } finally {
        process.env.HOME = prevHomeDir;
      }
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevKey;
    }
  }

  console.log('judge: passed.');
} finally {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.AGENT_PACK_HOME; else process.env.AGENT_PACK_HOME = prevHome;
  delete globalThis.__judgeAsk;
  rmSync(root, { recursive: true, force: true });
}
