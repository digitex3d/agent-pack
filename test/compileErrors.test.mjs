// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A broken source never compiles quietly (D30, D11): a name that resolves to no
 * block, a word the language does not have, a level a family does not declare,
 * an enum value outside its set, an undeclared {{variable}}, a slot type the
 * language does not have, a store LASTS / KEY / slot its backing refuses —
 * each fails the build at its file and line.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { checkVocabulary } = await import('../dist/src/lint.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-errors-'));
const lib = join(tmp, 'library');
mkdirSync(lib);
const compile = (lines, vars = {}) => {
  const file = join(tmp, 'a.ap');
  writeFileSync(file, [
    'EXPORT AGENT a AS a-role:', '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '',
    'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work', '',
    'TEMPLATE report:', '    ABOUT  a report', '    SLOTS:', '        verdict: TEXT "the verdict"', '    BODY:', '        {verdict}', '',
  ].join('\n'));
  return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false }, vars });
};

try {
  await compile(['    LENS-OUT  report']);   // the baseline compiles

  // --- names that resolve to nothing ---
  await assert.rejects(compile(['    LENS-OUT  reprot']), /a\.ap:4 {2}unknown template `reprot`/);
  await assert.rejects(compile(['    WHEN asked:', '        RUN  nowhere']), /a\.ap:5 {2}unknown procedure `nowhere`/);
  const roleless = join(tmp, 'b.ap');
  writeFileSync(roleless, 'EXPORT AGENT b AS nobody:\n    ABOUT    b\n    MANDATE  m\n');
  await assert.rejects(bundleAgentObject({ agentName: 'b', agentFile: roleless, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false } }),
    /b\.ap:1 {2}unknown role `nobody`/);

  // --- words, levels, values ---
  await assert.rejects(compile(['    ON-AGENT-PROMPT:', '        DO  greet']), /a\.ap:4 {2}unknown keyword `ON-AGENT-PROMPT` — did you mean `ON-AGENT-PROMPTED`\?/);
  await assert.rejects(compile(['    MEM!!!  the plan']), /a\.ap:4 {2}`MEM!!!` is not a level of MEM — use !MEM, MEM, MEM!, MEM!!/);
  await assert.rejects(compile(['    SHOULD!!  be brief']), /`SHOULD!!` is not a level of SHOULD — use !SHOULD, SHOULD, SHOULD!/);
  const flow = checkVocabulary('crew.ap', ['FLOW f:', '    STPE one:', '        DELEGATE it BY a', '    STEP two:', '        DELEGATE it BY a', '        CONTEXT isolated', '        BUDGET cheep'].join('\n'));
  assert.ok(flow.some(e => e.line === 2 && /unknown keyword `STPE` — did you mean `STEP`\?/.test(e.message)), JSON.stringify(flow));
  assert.ok(flow.some(e => e.line === 6 && /CONTEXT was removed — the form of a DELEGATE says the context/.test(e.message)), JSON.stringify(flow));
  assert.ok(flow.some(e => e.line === 7 && /BUDGET: unknown value `cheep`/.test(e.message)), JSON.stringify(flow));
  assert.deepEqual(checkVocabulary('t.ap', ['TEMPLATE t:', '    ABOUT  t', '    BODY:', '        NOTES: {x}', '        TODO'].join('\n')), [], "a template's text is the author's, never keywords");

  // --- variables ---
  await assert.rejects(compile(['    ALWAYS  write in {{lang}}']), /a\.ap:4 {2}unknown variable `\{\{lang\}\}`/);
  await compile(['    ALWAYS  write in {{lang}}'], { lang: 'English' });

  // --- a store slot no store can keep, whatever its driver ---
  await assert.rejects(compile(['', 'STORE notes:', '    ABOUT  notes', '    LASTS  project', '    KEY    note-id', '    SLOTS:', '        note-id: TEXT "the id"']),
    /STORE notes: slot "note-id": a store field name uses letters, digits and _ only — write note_id/);
  await assert.rejects(compile(['', 'STORE notes:', '    ABOUT  notes', '    SLOTS:', '        id: TEXT "the id"']),
    /STORE notes: slot "id": id is the record's own identifier, given by the driver/);

  // --- a store's driver: files when it names none; an unknown one, or the old TYPE line, fails ---
  await compile(['', 'STORE notes:', '    ABOUT  notes', '    SLOTS:', '        topic: TEXT "the topic"']);
  await assert.rejects(compile(['', 'STORE notes:', '    ABOUT  notes', '    DRIVER mongo', '    SLOTS:', '        topic: TEXT "the topic"']),
    /STORE notes: unknown DRIVER `mongo` \(installed: files\)/);
  await assert.rejects(compile(['', 'STORE notes:', '    ABOUT  notes', '    TYPE   files', '    SLOTS:', '        topic: TEXT "the topic"']),
    /TYPE became DRIVER — write `DRIVER <driver>`/);

  const store = (lasts, key, type) => compile(['', 'STORE notes:', '    ABOUT  notes', `    LASTS  ${lasts}`, `    KEY    ${key}`, '    SLOTS:', `        topic: ${type} "the topic"`]);
  await store('project', 'topic', 'TEXT MAX_WORDS 1');
  await assert.rejects(store('forever', 'topic', 'TEXT'), /LASTS: unknown value `forever` \(allowed: session, project\)/);
  await assert.rejects(store('projetc', 'topic', 'TEXT'), /LASTS: unknown value `projetc` — did you mean `project`\?/);
  await assert.rejects(store('project', 'topik', 'TEXT'), /STORE notes: KEY `topik` is none of its slots \(topic\)/);
  await assert.rejects(store('project', 'topic', 'NUMBR >=0'), /slot `topic`: unknown type `NUMBR >=0` — did you mean `NUMBER`\?/);

  console.log('compile error tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
