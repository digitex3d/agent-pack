// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `PARALLEL EACH <item> IN <list> MAX <n>` — a PARALLEL whose one step runs once
 * per element of a list variable. The head parses in one place (vars.ts); the
 * lint rejects a malformed head, a missing or bad bound, and more than one step;
 * the compiler wants the list a variable typed with one LIST slot; the document,
 * AGENTS.md and the apx say how the runs go; the Workflow script leaves the
 * flow to its prose.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { parseParallelHead } = await import('../dist/src/vars.js');
const { lintFile } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');

// --- the head: bare, EACH with its bound, and every malformed form ---
assert.equal(parseParallelHead(''), null, 'a bare PARALLEL has no head');
assert.deepEqual(parseParallelHead('EACH part IN parts MAX 5:'), { item: 'part', list: 'parts', max: 5 });
assert.deepEqual(parseParallelHead('EACH part IN parts MAX 5'), { item: 'part', list: 'parts', max: 5 }, 'the colon is optional');
assert.deepEqual(parseParallelHead('now'), { error: '`PARALLEL now`: PARALLEL takes nothing, or `EACH <item> IN <list> MAX <n>`' });
assert.deepEqual(parseParallelHead('EACH part IN parts:'), { error: '`PARALLEL EACH part IN parts`: write the bound — `PARALLEL EACH part IN parts MAX <n>`' });
for (const max of ['0', '-1', '2.5', 'five']) {
  assert.deepEqual(parseParallelHead(`EACH part IN parts MAX ${max}`), { error: `\`PARALLEL EACH part IN parts MAX ${max}\`: MAX takes a whole number of runs, at least 1` });
}
assert.deepEqual(parseParallelHead('EACH parts IN parts MAX 2'), { error: "`PARALLEL EACH parts IN parts MAX 2`: the element needs a name of its own, not the list's" });

const tmp = mkdtempSync(join(tmpdir(), 'ap-parallel-each-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'teams', 'crew');
const write = (file, lines) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };
write(join(lib, 'templates', 'part.ap'), ['EXPORT TEMPLATE part:', '  ABOUT   one part', '  SLOTS:', '    goal:   TEXT  "what the part does"', '  BODY:', '    {goal}']);
write(join(lib, 'templates', 'part-list.ap'), ['IMPORT  part  FROM @main.templates', '', 'EXPORT TEMPLATE part-list:', '  ABOUT   the parts',
  '  SLOTS:', '    items:   LIST <part> >=1  "the parts"', '  BODY:', '    {items}']);
write(join(lib, 'templates', 'note.ap'), ['EXPORT TEMPLATE note:', '  ABOUT   a note', '  SLOTS:', '    text:   TEXT  "the note"', '  BODY:', '    {text}']);
write(join(lib, 'vars', 'parts.ap'), ['IMPORT  part-list, note  FROM @main.templates', '',
  'EXPORT SESSION VAR parts AS part-list', 'EXPORT SESSION VAR notes AS note', 'EXPORT SESSION VAR loose']);
const agentFile = write(join(team, 'builder.ap'), ['EXPORT AGENT builder AS builder-role:', '    ABOUT    builds things', '    MANDATE  ship working code',
  '', 'ROLE builder-role:', '    ABOUT   a careful builder', '    ALWAYS  test first']);

const flowsAp = (...parallel) => [
  'ABOUT  a crew',                                     // 1
  '',                                                  // 2
  'IMPORT  parts, notes, loose FROM @main.vars',       // 3
  '',                                                  // 4
  'WHEN asked to ship:',                               // 5
  '    RUN ship',                                      // 6
  '',                                                  // 7
  'FLOW ship:',                                        // 8
  '    STEP split:',                                   // 9
  '        BY builder',                                // 10
  '        DO  split the task INTO parts',             // 11
  ...parallel,                                         // 12…
  '    STEP merge:',
  '        BY builder',
  '        DO  merge every report',
];
const WORK = ['        STEP work:', '            BY builder', '            CONTEXT inherited', '            DO  work only on {{part}}'];
const lint = (...parallel) => lintFile(join(team, 'flows.ap'), flowsAp(...parallel).join('\n') + '\n').map(e => [e.line, e.message]);
const compile = async (...parallel) => {
  write(join(team, 'flows.ap'), flowsAp(...parallel));
  return bundleAgentObject({ agentName: 'builder', agentFile, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};

try {
  // --- lint: a well-formed head with its one step is clean ---
  assert.deepEqual(lint('    PARALLEL EACH part IN parts MAX 5:', ...WORK), []);
  assert.deepEqual(lint('    PARALLEL', ...WORK, '        STEP more:', '            DO  more'), [], 'a bare PARALLEL still holds several steps');

  // --- lint: a malformed head, a missing or bad bound, more than one step ---
  assert.deepEqual(lint('    PARALLEL EACH part IN parts:', ...WORK),
    [[12, '`PARALLEL EACH part IN parts`: write the bound — `PARALLEL EACH part IN parts MAX <n>`']]);
  assert.deepEqual(lint('    PARALLEL EACH part IN parts MAX 0:', ...WORK),
    [[12, '`PARALLEL EACH part IN parts MAX 0`: MAX takes a whole number of runs, at least 1']]);
  assert.deepEqual(lint('    PARALLEL now', ...WORK), [[12, '`PARALLEL now`: PARALLEL takes nothing, or `EACH <item> IN <list> MAX <n>`']]);
  assert.deepEqual(lint('    PARALLEL EACH part IN parts MAX 3:', ...WORK, '        STEP more:', '            DO  more'),
    [[12, 'PARALLEL EACH block has 2 occurrences of STEP (expected at most 1)']]);
  assert.deepEqual(lint('    PARALLEL EACH part IN parts MAX 3:', '        RUN ship'), [
    [13, 'RUN is not allowed inside PARALLEL EACH (expected one of: STEP)'],
    [12, 'PARALLEL EACH block requires at least one STEP'],
  ]);

  // --- the compiler: the list is a declared variable, typed, with one LIST slot ---
  const fails = async (re, ...parallel) => assert.rejects(() => compile(...parallel), re);
  await fails(/flows\.ap:12  PARALLEL EACH part IN nope: no variable `nope` — IMPORT the module that exports it/, '    PARALLEL EACH part IN nope MAX 3:', ...WORK);
  await fails(/flows\.ap:12  PARALLEL EACH part IN loose: `loose` has no type — declare it `AS <template>`, a template with one LIST slot/,
    '    PARALLEL EACH part IN loose MAX 3:', ...WORK);
  await fails(/flows\.ap:12  PARALLEL EACH part IN notes: `note` has 0 LIST slots — the list to run over is its one LIST slot/,
    '    PARALLEL EACH part IN notes MAX 3:', ...WORK);

  // --- the document: the node carries its head, the step its body ---
  const { structure } = await compile('    PARALLEL EACH part IN parts MAX 5:', ...WORK);
  const flow = structure.all().find(b => b.kind === 'flow' && b.name === 'ship');
  const parallel = flow.body[1];
  assert.equal(parallel.type, 'parallel');
  assert.deepEqual({ ...parallel.each, list: parallel.each.list.target }, { item: 'part', list: '@main.vars/parts', max: 5 });
  assert.deepEqual(parallel.steps.map(s => s.title), ['work']);
  const doc = ApDocument.fromJson(structure.asJson());
  assert.deepEqual(doc.block(flow.address).body[1].each, parallel.each, 'the head survives the JSON round trip');
  assert.equal(structure.lines('PARALLEL').find(l => l.file === join(team, 'flows.ap')).text, 'EACH part IN parts MAX 5');

  // --- AGENTS.md and `apx get` say how the runs go ---
  const head = (read) => `In parallel, one run of the step below for each element of \`parts\` (read its value: \`${read}\`), at most 5 runs — `
    + 'a list longer than 5 is an error: stop the flow and report it. In each run `{{part}}` is its element; '
    + 'a run that fails does not stop the others: its report goes on with theirs:';
  const { content } = await buildOrchestrationContent({
    cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'), libraryRoots: [lib], libraries: { '@main': lib },
  });
  assert.ok(content.includes([head('node .agent-pack/apx/builder.apx get parts'), 'Steps:', '- work — by `builder`, inherited context', '  Do work only on {{part}}'].join('\n')),
    `AGENTS.md renders the head:\n${content}`);
  const lines = [];
  assert.equal(new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, 'apx/builder.apx', l => lines.push(l)).run(['get', flow.id]), 0);
  assert.ok(lines.join('\n').includes(head('node apx/builder.apx get parts')), `apx get renders the head:\n${lines.join('\n')}`);

  // --- the Workflow script cannot fan out over a list it does not hold: the flow runs as written ---
  assert.equal(compileWorkflow(doc.block(flow.address), doc), null);
  const full = await compile('    PARALLEL EACH part IN parts MAX 5:', ...WORK.filter(l => !l.includes('CONTEXT')));
  const fullDoc = ApDocument.fromJson(full.structure.asJson());
  assert.equal(compileWorkflow(fullDoc.block(flow.address), fullDoc), null, 'not even when every step could be scripted');

  console.log('PARALLEL EACH tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
