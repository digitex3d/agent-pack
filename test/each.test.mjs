// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `EACH <item> IN {{<list>}} MAX <n>:` (D56, D57) — a block of a flow STEP whose
 * DELEGATE and FORK lines run once per element of a list variable, all the runs
 * at once. The head parses in one place (vars.ts); the lint rejects a malformed
 * head, a missing or bad bound, a line that hands nothing out, an EACH outside a
 * step and one over a list of contracts; the compiler wants the list a variable
 * typed with one LIST slot, and an INTO inside a plain variable or one LIST
 * slot; the document, AGENTS.md and the apx say how the runs go; each run of a
 * `~` is its own piece in the registry, and the WAIT collects their results.
 * PARALLEL is gone, with its rewrite.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { parseEachHead } = await import('../dist/src/vars.js');
const { lintFile } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');

const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };

// --- the head: `<item> IN {{<list>}} MAX <n>`, every malformed form; a DIMENSION's EACH line is no head ---
assert.deepEqual(parseEachHead('part IN {{parts}} MAX 5:'), { item: 'part', list: 'parts', max: 5 });
assert.deepEqual(parseEachHead('part IN {{parts}} MAX 5'), { item: 'part', list: 'parts', max: 5 }, 'the colon is optional');
assert.equal(parseEachHead('the function and its callers'), null, "a DIMENSION's EACH line");
assert.deepEqual(parseEachHead('part IN parts MAX 5:'), { error: '`EACH part IN parts MAX 5`: the list is read like any variable — `EACH part IN {{parts}} MAX <n>:`' });
assert.deepEqual(parseEachHead('part IN {{parts}}:'), { error: '`EACH part IN {{parts}}`: write the bound — `EACH part IN {{parts}} MAX <n>:`' });
for (const max of ['0', '-1', '2.5', 'five']) {
  assert.deepEqual(parseEachHead(`part IN {{parts}} MAX ${max}`), { error: `\`EACH part IN {{parts}} MAX ${max}\`: MAX takes a whole number of runs, at least 1` });
}
assert.deepEqual(parseEachHead('parts IN {{parts}} MAX 2'), { error: "`EACH parts IN {{parts}} MAX 2`: the element needs a name of its own, not the list's" });

const tmp = mkdtempSync(join(tmpdir(), 'ap-each-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'agents', 'teams', 'crew');
write(join(lib, 'templates', 'part.ap'), ['EXPORT TEMPLATE part:', '  ABOUT   one part', '  SLOTS:', '    goal:   TEXT  "what the part does"', '  BODY:', '    {goal}']);
write(join(lib, 'templates', 'part-list.ap'), ['IMPORT  part  FROM @main.templates', '', 'EXPORT TEMPLATE part-list:', '  ABOUT   the parts',
  '  SLOTS:', '    items:   LIST <part> >=1  "the parts"', '  BODY:', '    {items}']);
write(join(lib, 'templates', 'note.ap'), ['EXPORT TEMPLATE note:', '  ABOUT   a note', '  SLOTS:', '    text:   TEXT  "the note"', '  BODY:', '    {text}']);
write(join(lib, 'templates', 'spec.ap'), ['EXPORT TEMPLATE spec:', '  ABOUT   a zone', '  SLOTS:', '    goal:   TEXT  "what to build"', '  BODY:', '    {goal}']);
write(join(lib, 'vars', 'parts.ap'), ['IMPORT  part-list, note  FROM @main.templates', '',
  'EXPORT SESSION VAR parts AS part-list', 'EXPORT SESSION VAR notes AS note', 'EXPORT SESSION VAR loose', 'EXPORT SESSION VAR reports', 'EXPORT SESSION VAR zones']);
const agentFile = write(join(team, 'builder.ap'), ['EXPORT AGENT builder AS builder-role:', '    ABOUT    builds things', '    MANDATE  ship working code',
  '', 'ROLE builder-role:', '    ABOUT   a careful builder', '    ALWAYS  test first']);

const flowsAp = (...each) => teamSource('crew', ['builder'], [
  'ABOUT  a crew',                                     // 1
  '',                                                  // 2
  'IMPORT  parts, notes, loose, reports, zones FROM @main.vars', // 3
  'IMPORT  spec FROM @main.templates',                 // 4
  '',
  'WHEN asked to ship:',
  '    RUN ship',
  '',
  'FLOW ship:',
  '    STEP split:',
  '        DELEGATE split the task INTO parts BY builder',
  '    STEP work:',
  ...each,                                             // line 16… of the file: the team block opens below the IMPORTs
  '    STEP merge:',
  '        DELEGATE merge every report BY builder',
]);
const file = join(team, 'crew.ap');
const lint = (...each) => lintFile(file, `${flowsAp(...each).join('\n')}\n`).map(e => [e.line, e.message]);
// The flow is the team's: the same compiler, on the team's file, makes its document.
const compile = async (...each) => {
  write(file, flowsAp(...each));
  return bundleAgentObject({ agentName: 'crew', agentFile: file, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};
const RUNS = ['        EACH part IN {{parts}} MAX 3:', '            DELEGATE~ work only on {{part}} INTO reports BY builder', '        WAIT reports'];

try {
  // --- lint: a well-formed EACH with its delegations is clean ---
  assert.deepEqual(lint(...RUNS), []);
  assert.deepEqual(lint('        EACH part IN {{parts}} MAX 3:', '            DELEGATE work only on {{part}} BY builder', '            FORK~ check {{part}}', '        WAIT ALL'), []);

  // --- lint: PARALLEL is gone, with its rewrite ---
  const parallel = lint('        PARALLEL EACH part IN parts MAX 3:', '            DELEGATE work only on {{part}} BY builder');
  assert.ok(parallel.some(([, m]) => m.startsWith('PARALLEL was removed') && m.includes('EACH <item> IN {{<list>}} MAX <n>:')), JSON.stringify(parallel));

  // --- lint: a malformed head, a line that hands nothing out, none at all, an EACH outside a step, one over a list of contracts ---
  assert.deepEqual(lint('        EACH part IN {{parts}}:', '            DELEGATE~ work only on {{part}} INTO reports BY builder', '        WAIT reports'),
    [[16, '`EACH part IN {{parts}}`: write the bound — `EACH part IN {{parts}} MAX <n>:`']]);
  assert.ok(lint('        EACH part IN {{parts}} MAX 3:', '            DO work on {{part}}').some(([l, m]) => l === 17 && m.startsWith('DO is not allowed inside EACH (expected one of: DELEGATE, FORK)')));
  assert.ok(lint('        EACH part IN {{parts}} MAX 3:', '            MARK one zone per {{part}} INTO zones AS spec').some(([, m]) => m.includes('EACH block requires at least one of: DELEGATE, FORK')));
  assert.ok(lint('        MARK one zone per part INTO zones AS spec', '        EACH zone IN {{zones}} MAX 3:', '            DELEGATE build {{zone}} BY builder')
    .some(([l, m]) => l === 17 && m.includes('`zones` holds the contracts a MARK made — a list of contracts is delegated as it is: `DELEGATE zones BY <agent>`')));
  const outside = lintFile(agentFile, `${['EXPORT AGENT builder AS builder-role:', '    ABOUT    builds things', '    MANDATE  ship working code',
    '    WHEN asked:', '        EACH part IN {{parts}} MAX 3:', '            DELEGATE work on {{part}} BY builder', '', 'ROLE builder-role:', '    ABOUT   a careful builder'].join('\n')}\n`);
  assert.ok(outside.some(e => e.message.includes('EACH hands work out once per element of a list, for a flow — it stands in a flow STEP')), JSON.stringify(outside));

  // --- the compiler: the list is a declared variable, typed, with one LIST slot; an INTO inside collects a list ---
  const fails = async (re, ...each) => assert.rejects(() => compile(...each), re);
  await fails(/crew\.ap:16 {2}EACH part IN \{\{nope\}\}: no variable `nope` — IMPORT the module that exports it/, '        EACH part IN {{nope}} MAX 3:', '            DELEGATE work on {{part}} BY builder');
  await fails(/EACH part IN \{\{loose\}\}: `loose` has no type — declare it `AS <template>`, a template with one LIST slot/,
    '        EACH part IN {{loose}} MAX 3:', '            DELEGATE work on {{part}} BY builder');
  await fails(/EACH part IN \{\{notes\}\}: `note` has 0 LIST slots — the list to run over is its one LIST slot/,
    '        EACH part IN {{notes}} MAX 3:', '            DELEGATE work on {{part}} BY builder');
  await fails(/INTO notes inside EACH collects one result per run — `note` has 0 LIST slots/,
    '        EACH part IN {{parts}} MAX 3:', '            DELEGATE work on {{part}} INTO notes BY builder');

  // --- the document: the node carries its head and its delegations; the head survives the round trip ---
  const { structure } = await compile(...RUNS);
  const flow = structure.all().find(b => b.kind === 'flow' && b.name === 'ship');
  const each = flow.body[1].body[0];
  assert.equal(each.type, 'each');
  assert.deepEqual({ ...each.each, list: each.each.list.target }, { item: 'part', list: '@main.vars/parts', max: 3 });
  assert.equal(each.body[0].keyword, 'DELEGATE');
  assert.ok(each.body[0].element && /^dlg-[0-9a-f]{8}$/.test(each.body[0].work), 'a `~` inside: one piece per run');
  const doc = ApDocument.fromJson(structure.asJson());
  assert.deepEqual(doc.block(flow.address).body[1].body[0].each, each.each, 'the head survives the JSON round trip');
  assert.equal(doc.meta.background[each.body[0].work].each.max, 3, 'the apx knows the bound');
  assert.equal(structure.lines('EACH').find(l => l.file === file).text, 'part IN {{parts}} MAX 3');
  assert.equal(compileWorkflow(doc.block(flow.address), doc), null, 'the Workflow script cannot fan out over a list it does not hold');
  console.log('EACH lint and compile tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- a real project: AGENTS.md and the apx say how the runs go; each run is its own piece; the WAIT collects the list ---
const proj = mkdtempSync(join(tmpdir(), 'ap-each-run-'));
const SESSION = 'each-session';
try {
  const pteam = join(proj, 'agents', 'teams', 'crew');
  write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
  write(join(proj, 'library', 'templates', 'part.ap'), ['EXPORT TEMPLATE part:', '  ABOUT   one part', '  SLOTS:', '    goal:   TEXT  "what the part does"', '  BODY:', '    {goal}']);
  write(join(proj, 'library', 'templates', 'part-list.ap'), ['IMPORT  part  FROM @main.templates', '', 'EXPORT TEMPLATE part-list:', '  ABOUT   the parts',
    '  SLOTS:', '    items:   LIST <part> >=1  "the parts"', '  BODY:', '    {items}']);
  write(join(proj, 'library', 'vars', 'crew.ap'), ['IMPORT  part-list  FROM @main.templates', '', 'EXPORT SESSION VAR parts AS part-list', 'EXPORT SESSION VAR reports']);
  for (const name of ['lead', 'builder']) {
    write(join(pteam, `${name}.ap`), ['IMPORT parts, reports FROM @main.vars', '', `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '',
      `ROLE ${name}-role:`, '    ABOUT   a builder', '    ALWAYS  test first']);
  }
  write(join(pteam, 'crew.ap'), teamSource('crew', ['lead', 'builder'], [
    'IMPORT parts, reports FROM @main.vars',
    'ABOUT  a crew',
    'WHEN asked to ship:',
    '    RUN ship',
    'FLOW ship:',
    '    STEP split:',
    '        DELEGATE split the task INTO parts BY lead',
    '    STEP work:',
    '        EACH part IN {{parts}} MAX 2:',
    '            DELEGATE~ work only on {{part}} INTO reports BY builder',
    '        WAIT reports',
  ]));
  const r = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, encoding: 'utf-8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const agents = readFileSync(join(proj, 'AGENTS.md'), 'utf-8');
  const flw = agents.match(/flow (flw-[0-9a-f]{8})/)[1];
  const apx = (args, stdin) => {
    const x = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'crew.apx'), ...args],
      { cwd: proj, encoding: 'utf-8', input: stdin, env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION } });
    return { code: x.status, out: `${x.stdout}${x.stderr}`.trimEnd() };
  };
  const md = apx(['get', flw]).out;
  const work = md.match(/delegate start (dlg-[0-9a-f]{8})-<k>/)?.[1];
  assert.ok(work, `one id per run, <k> the run's number:\n${md}`);
  has(md, 'For each element of', 'at most 2 runs — a list longer than 2 is an error: stop the flow and report it',
    'In each run `{{part}}` is its element', 'an INTO collects one result per run — a list, in element order', "(one id per run: <k> is the run's number, from 1)");
  assert.ok(!md.includes('wait for every run of a line not started in the background'), 'every line is a `~`: the WAIT takes them back');

  // --- each run is its own piece: named by its number, bounded by MAX ---
  let x = apx(['delegate', 'start', work]);
  assert.equal(x.code, 2);
  has(x.out, `runs once per element of an EACH — name the run: node .agent-pack/apx/crew.apx delegate start ${work}-<k>`);
  assert.equal(apx(['delegate', 'start', `${work}-1`]).code, 0);
  assert.equal(apx(['delegate', 'start', `${work}-2`]).code, 0);
  x = apx(['delegate', 'start', `${work}-3`]);
  assert.equal(x.code, 3);
  has(x.out, 'the list runs longer than the EACH\'s MAX 2 — an error: stop the flow and report it');

  // --- the runs deliver; the WAIT collects their results, in order, into the INTO ---
  assert.equal(apx(['delegate', 'deliver', `${work}-2`, '-'], 'part two done\n').code, 0);
  x = apx(['wait', 'reports', '--max', '1s']);
  assert.equal(x.code, 1, 'one run still running');
  has(x.out, `${work}-1  reports  running`, 'still running after 1s');
  assert.ok(!x.out.includes('holds the 2 runs'), 'nothing collected while a run is running');
  assert.equal(apx(['delegate', 'block', `${work}-1`, 'the part was empty']).code, 0);
  x = apx(['wait', work]);
  has(x.out, `${work}-1  reports  blocked`, `${work}-2  reports  delivered`, '`reports` holds the 2 runs');
  has(apx(['get', 'reports']).out, '[{"state":"blocked","reason":"the part was empty"},"part two done"]');
  console.log('EACH run tests passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
