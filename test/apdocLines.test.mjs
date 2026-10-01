// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The compiled document is queryable by line, with source positions: every
 * block knows the file and line of its header, every node the line and columns
 * it was written on — provenance only, never serialized. `lines(primitive)`
 * lists the keyword lines at any depth with their containers, `lineAt` finds
 * the one written at a file position, and each source file is read once per
 * compilation, through the source registry.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

const { SourceRegistry, align } = await import('../dist/src/sources.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { walk, someNode } = await import('../dist/src/apdoc/nodes.js');

// --- align: each line of a cleaned body finds the file line it came from ---
{
  const text = [
    '# c',                         // 1
    '',                            // 2
    'EXPORT PROCEDURE p:',         // 3
    '    ABOUT  a',                // 4
    '    STEP first',              // 5
    '    DO  use {{tool}} now',    // 6
    '    DO  last',                // 7
    '',                            // 8
    'EXPORT PROCEDURE q:',         // 9
    '    DO  other',               // 10
  ].join('\n');
  const sources = new SourceRegistry(() => text);
  const span = sources.span('/virtual/p.ap', 'procedure', 'p');
  assert.equal(span.line, 3, 'the span opens at its header');
  assert.deepEqual(
    align(['1. first', 'DO  use hammer now', 'DO  last'], span), [5, 6, 7],
    'a deleted ABOUT line, a numbered STEP and a substituted {{var}} still find their lines',
  );
  assert.deepEqual(align(['DO  last', 'DO  never written'], span), [7, 7], 'an unmatched line takes the last matched line');
  assert.deepEqual(align(['never written', 'DO  last'], span), [3, 7], 'with nothing matched yet, the block start line');
  assert.deepEqual(align(['DO  other'], span), [3], 'a line of another block is not in this span');
  assert.equal(sources.span('/virtual/p.ap', 'procedure', 'q').line, 9);
  assert.equal(sources.span('/virtual/p.ap', 'procedure', 'nope'), null, 'not found → null');
  assert.equal(sources.span('/virtual/p.ap', 'template', 'p'), null, 'the kind is part of the identity');

  const legacy = new SourceRegistry(() => 'ABOUT  old style\nDO  one\n');
  assert.equal(legacy.span('/virtual/old.ap', 'procedure', 'old').line, 1, 'a file without EXPORT blocks spans from line 1');
}

// --- a compiled fixture: agent + inline role, library procedures, team flows ---
const tmp = mkdtempSync(join(tmpdir(), 'ap-lines-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'teams', 'crew');
mkdirSync(join(lib, 'procedures'), { recursive: true });
mkdirSync(join(lib, 'templates'), { recursive: true });
mkdirSync(team, { recursive: true });
const write = (file, lines) => { writeFileSync(file, lines.join('\n')); return file; };

const checksFile = write(join(lib, 'procedures', 'checks.ap'), [
  '# checks',                          // 1
  '',                                  // 2
  'EXPORT PROCEDURE verify:',          // 3
  '    ABOUT  verify the change',      // 4
  '    TAGS   #quality',               // 5
  '    DO  run the tests',             // 6
  '    IF the tests fail:',            // 7
  '        UNTIL they pass:',          // 8
  '            DO  fix the code',      // 9
  '    DO  report the result',         // 10
  '',                                  // 11
  'EXPORT PROCEDURE tidy:',            // 12
  '    ABOUT  tidy up',                // 13
  '    DO  remove the scratch files',  // 14
  '',
]);
const outFile = write(join(lib, 'templates', 'out.ap'), [
  'EXPORT TEMPLATE tally-out:',        // 1
  '    ABOUT  the tally',
  '    SLOTS:',
  '        count: NUMBER >=0  "how many"',
  '    BODY:',
  '        {count}',
  '',
]);
const flowsFile = write(join(team, 'flows.ap'), [
  'ABOUT  a crew',                     // 1
  '',                                  // 2
  'WHEN asked to ship:',               // 3
  '    RUN ship',                      // 4
  '',                                  // 5
  'FLOW ship:',                        // 6
  '    STEP build it:',                // 7
  '        BY builder',                // 8
  '        DO  compile the code',      // 9
  '    STEP check it:',                // 10
  '        BY builder',                // 11
  '        DO  run the checks',        // 12
  '        DO  sign off',              // 13
  '',
]);
const agentFile = write(join(team, 'builder.ap'), [
  'IMPORT tally-out FROM @main.templates',        // 1
  'IMPORT verify, tidy FROM @main.procedures',    // 2
  '',                                             // 3
  'EXPORT AGENT builder AS builder-role:',        // 4
  '    ABOUT    builds things',                   // 5
  '    MANDATE  ship working code',               // 6
  '    DO  read the task',                        // 7
  '    WHEN a task arrives:',                     // 8
  '        IF it is a bug:',                      // 9
  '            DO  reproduce it first',           // 10
  '        RUN  verify',                          // 11
  '        RUN  tidy',                            // 12
  '',                                             // 13
  'ROLE builder-role:',                           // 14
  '    ABOUT   a careful builder',                // 15
  '    ALWAYS  test first',                       // 16
  '    DO  keep diffs small   ',                  // 17 (trailing blanks)
  '',                                             // 18
  'PROCEDURE tally:',                             // 19
  '    ABOUT  count the findings',                // 20
  '    AS     tally-out',                         // 21
  '    DISTILL',                                  // 22
  '    DO  count every finding',                  // 23
  '',                                             // 24
  'WHEN the session ends:',                       // 25 (outside the AGENT block)
  '    RUN  tidy',                                // 26
  '    DO  write a summary',                      // 27
  '',
]);

try {
  const reads = new Map();
  const sources = new SourceRegistry(path => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    return readFileSync(path, 'utf-8');
  });
  const { structure: doc } = await bundleAgentObject({
    agentName: 'builder', agentFile, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false }, sources,
  });

  // --- each file read once, through the registry ---
  for (const file of [agentFile, flowsFile, checksFile, outFile]) {
    assert.equal(reads.get(file), 1, `${basename(file)} read once through the registry (got ${reads.get(file) ?? 0})`);
  }
  for (const [file, n] of reads) assert.equal(n, 1, `${file} read ${n} times`);

  // --- block.source: the header of each block ---
  const byName = name => doc.all().find(b => b.name === name);
  assert.deepEqual(byName('builder').source, { file: agentFile, line: 4, col: 1 });
  assert.deepEqual(byName('builder-role').source, { file: agentFile, line: 14, col: 1 });
  assert.deepEqual(byName('tally').source, { file: agentFile, line: 19, col: 1 });
  assert.deepEqual(byName('verify').source, { file: checksFile, line: 3, col: 1 });
  assert.deepEqual(byName('tidy').source, { file: checksFile, line: 12, col: 1 });
  assert.deepEqual(byName('tally-out').source, { file: outFile, line: 1, col: 1 });
  assert.deepEqual(byName('ship').source, { file: flowsFile, line: 6, col: 1 });
  assert.deepEqual(byName('crew').source, { file: flowsFile, line: 1, col: 1 }, 'the team is its flows.ap');

  // --- lines('DO'): every DO, at every depth, with its exact position ---
  const at = l => `${basename(l.file)}:${l.line}:${l.col}-${l.endCol} ${l.text}`;
  assert.deepEqual(doc.lines('DO').map(at).sort(), [
    `builder.ap:7:5-22 read the task`,
    `builder.ap:10:13-35 reproduce it first`,
    `builder.ap:17:5-25 keep diffs small`,
    `builder.ap:23:5-28 count every finding`,
    `builder.ap:27:5-24 write a summary`,
    'checks.ap:6:5-22 run the tests',
    'checks.ap:9:13-29 fix the code',
    'checks.ap:10:5-26 report the result',
    'checks.ap:14:5-33 remove the scratch files',
    'flows.ap:9:9-29 compile the code',
    'flows.ap:12:9-27 run the checks',
    'flows.ap:13:9-21 sign off',
  ].sort());
  assert.ok(doc.lines('DO').every(l => l.primitive === 'DO' && l.force === null));

  // --- containers: the ancestors, outermost first ---
  const fix = doc.lineAt(checksFile, 9);
  assert.equal(fix.block.name, 'verify');
  assert.deepEqual(fix.containers.map(c => c.type), ['if', 'until']);
  assert.equal(fix.containers[0].condition, 'the tests fail');
  const compile = doc.lineAt(flowsFile, 9);
  assert.deepEqual(compile.containers.map(c => c.type), ['step']);
  assert.equal(compile.containers[0].title, 'build it');
  const reproduce = doc.lineAt(agentFile, 10);
  assert.equal(reproduce.text, 'reproduce it first');
  assert.equal(reproduce.block.name, 'builder');
  assert.deepEqual(reproduce.containers.map(c => c.type), ['when', 'if']);

  // --- the other primitives answer with their own head ---
  const step = doc.lineAt(flowsFile, 10);
  assert.deepEqual([step.primitive, step.text, step.col], ['STEP', 'check it', 5]);
  const cond = doc.lineAt(checksFile, 8);
  assert.deepEqual([cond.primitive, cond.text], ['UNTIL', 'they pass']);
  const run = doc.lineAt(agentFile, 11);
  assert.deepEqual([run.primitive, run.text], ['RUN', 'verify']);
  // Lines written outside the AGENT block, composed into its body: each its own line.
  const outside = [25, 26, 27].map(n => doc.lineAt(agentFile, n));
  assert.deepEqual(outside.map(l => [l.block.name, l.primitive, l.text, l.col]), [
    ['builder', 'WHEN', 'the session ends', 1], ['builder', 'RUN', 'tidy', 5], ['builder', 'DO', 'write a summary', 5],
  ]);
  assert.equal(doc.lineAt(agentFile, 4), null, 'the AGENT header holds none of them');
  assert.deepEqual(doc.lines('IF').map(l => l.text).sort(), ['it is a bug', 'the tests fail']);
  assert.equal(doc.lineAt(agentFile, 3), null, 'a blank line holds no line');
  assert.equal(doc.lineAt(join(tmp, 'elsewhere.ap'), 9), null);

  // --- nodes(): every node with its position, the ones that are no line included ---
  const mark = doc.nodes().find(n => n.node.type === 'distill');
  assert.equal(mark.block.name, 'tally');
  assert.equal(mark.node.pos, undefined, 'a compiler mark was written nowhere');
  assert.ok(!doc.lines().some(l => l.block.name === 'tally' && l.primitive === 'DISTILL'), 'and is no line');

  // --- JSON, contentHash and chars never see the positions ---
  const json = doc.asJson();
  assert.ok(!json.includes('"pos"') && !json.includes('"endCol"') && !json.includes('"source"'), 'positions are never serialized');
  const revived = ApDocument.fromJson(json);
  for (const block of doc.all()) {
    const twin = revived.block(block.address);
    twin.seal();
    assert.equal(twin.contentHash, block.contentHash, `${block.address}: contentHash is position-free`);
    assert.equal(twin.chars, block.chars, `${block.address}: chars is position-free`);
  }
  assert.equal(revived.lines('DO').length, 12, 'a revived document still lists its lines…');
  assert.ok(revived.lines('DO').every(l => l.file === null && l.line === null && l.col === null && l.endCol === null), '…without positions');
  assert.equal(revived.all().every(b => b.source === null), true);

  // --- distillMarks: the procedure's closing mark, same on the revived twin ---
  const marks = doc.distillMarks();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].block.name, 'tally');
  assert.equal(marks[0].mark, marks[0].block.body[marks[0].block.body.length - 1], 'the mark closes the body');
  assert.deepEqual(revived.distillMarks().map(m => [m.block.address, m.mark.id]), marks.map(m => [m.block.address, m.mark.id]));

  // --- walk / someNode: pre-order, containers outermost first ---
  const leaf = { type: 'directive', keyword: 'DO', force: null, text: 'deep', chars: 0 };
  const loop = { type: 'until', condition: 'c', chars: 0, body: [leaf] };
  const branch = { type: 'if', condition: 'b', chars: 0, then: [loop], else: [] };
  const tail = { type: 'text', raw: 'tail', chars: 0 };
  const tree = [branch, tail];
  assert.deepEqual([...walk(tree)].map(w => [w.node, w.containers]), [
    [branch, []], [loop, [branch]], [leaf, [branch, loop]], [tail, []],
  ]);
  const seen = [];
  assert.equal(someNode(tree, n => { seen.push(n); return n === leaf; }), true);
  assert.deepEqual(seen, [branch, loop, leaf], 'someNode stops at the first match, pre-order');
  assert.equal(someNode(tree, n => n.type === 'run'), false);
  assert.equal(someNode([], () => true), false);

  console.log('apdoc lines tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
