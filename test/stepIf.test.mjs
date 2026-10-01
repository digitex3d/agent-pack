// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * IF inside a flow STEP — and IF/ELSE/UNTIL inside a FLOW itself: a step may put some of its DO/RUN lines under
 * `IF <condition>` (and its ELSE). The step stays valid when every DO sits
 * under the IF; an IF with nothing under it is the same error as anywhere
 * else. Every consumer of a step carries the branch: the lint, the document
 * (`lines()` with containers [step, if]), the md of AGENTS.md, `apx flow`, the Workflow script.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { lintFile, lintFlow } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');

const FLOW = [
  'FLOW ship:',                                        // 6
  '    STEP judge it:',                                // 7
  '        BY builder',                                // 8
  '        DO  read the report',                       // 9
  '        IF the report says replan:',                // 10
  '            DO  end the flow',                      // 11
  '        ELSE',                                      // 12
  '            DO  hand the report on',                // 13
  '    STEP close it:',                                // 14
  '        BY builder',                                // 15
  '        IF the audit passed:',                      // 16
  '            DO  tag the release',                   // 17
];

const tmp = mkdtempSync(join(tmpdir(), 'ap-step-if-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'teams', 'crew');
mkdirSync(lib, { recursive: true });
mkdirSync(team, { recursive: true });
const write = (file, lines) => { writeFileSync(file, lines.join('\n') + '\n'); return file; };
const flowsFile = write(join(team, 'flows.ap'), [
  'ABOUT  a crew',                                     // 1
  '',                                                  // 2
  'WHEN asked to ship:',                               // 3
  '    RUN ship',                                      // 4
  '',                                                  // 5
  ...FLOW,
]);
const agentFile = write(join(team, 'builder.ap'), [
  'EXPORT AGENT builder AS builder-role:',
  '    ABOUT    builds things',
  '    MANDATE  ship working code',
  '',
  'ROLE builder-role:',
  '    ABOUT   a careful builder',
  '    ALWAYS  test first',
]);

try {
  // --- lint: the team file and a flow file both take the IF/ELSE ---
  assert.deepEqual(lintFile(flowsFile, `ABOUT  a crew\n\n${FLOW.join('\n')}\n`), [], 'a team flows.ap lints clean');
  const flowFile = join(tmp, 'flows', 'ship.ap');
  const lintShip = (...lines) => lintFlow(flowFile, ['# ship', '', 'ABOUT  ship it', '', 'FLOW ship', ...lines, ''].join('\n'));
  assert.deepEqual(lintShip(...FLOW.slice(1)), [], 'a flow file lints clean — a step whose DO all sit under an IF included');

  // --- lint: an IF with nothing under it is the error it is anywhere else, and lends the step no DO ---
  const empty = lintShip('    STEP close it:', '        BY builder', '        IF the audit passed:', '    STEP next:', '        DO  go');
  assert.deepEqual(empty.map(e => [e.line, e.message]), [
    [8, 'IF/ELSE block body must be indented (Python-style): "IF the audit passed:"'],
    [6, 'STEP block requires at least one of: DO, RUN'],
  ]);
  const emptyElse = lintShip('    STEP s:', '        IF a:', '            DO  x', '        ELSE', '        DO  y');
  assert.deepEqual(emptyElse.map(e => [e.line, e.message]), [[9, 'IF/ELSE block body must be indented (Python-style): "ELSE"']]);

  // --- lint: the branch holds DO/RUN and rule lines only; the step's signature stays unconditional ---
  const inside = lintShip('    STEP s:', '        IF a:', '            BY builder', '            CONTEXT full',
    '            IF b:', '                DO  x', '            RUN go', '        DO  y');
  assert.deepEqual(inside.map(e => [e.line, e.message]), [
    [8, 'BY is not allowed inside IF (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)'],
    [9, 'CONTEXT is not allowed inside IF (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)'],
    [10, 'IF is not allowed inside IF (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)'],
  ]);
  // A branch line that is not allowed does not count toward the step's own uniques.
  assert.deepEqual(lintShip('    STEP s:', '        BY builder', '        IF a:', '            BY other', '            DO  x')
    .map(e => e.message), ['BY is not allowed inside IF (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)']);
  // A FLOW itself admits IF/ELSE and UNTIL too — see the flow-level section below.
  assert.deepEqual(lintShip('    IF a:', '        STEP s:', '            DO  x'), [], 'IF is a line of a FLOW itself');
  // The error lists the branch keywords with the step's own.
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        UNTIL done:', '            DO  y').map(e => e.message),
    ['UNTIL is not allowed inside STEP (expected one of: DO, RUN, CONTEXT, BY, MUST, ALWAYS, SHOULD, MAY, AS, IF, ELSE)']);

  // --- lint: an ELSE with no IF before it in the same body is rejected ---
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        ELSE', '            DO  y').map(e => [e.line, e.message]),
    [[8, 'ELSE must follow an IF in the same body']], 'an orphan ELSE in a step');
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        IF a:', '            DO  y', '    STEP t:', '        ELSE', '            DO  z')
    .map(e => [e.line, e.message]), [[11, 'ELSE must follow an IF in the same body']], 'an IF of another step lends it nothing');

  // --- lint: a FLOW holds IF/ELSE and UNTIL, which hold STEP/PARALLEL/RUN and nest further ---
  const FLOW_BRANCHES = [
    '    STEP plan it:',                                 // 6
    '        BY builder',                                // 7
    '        DO  write the plan',                        // 8
    '    UNTIL the audit passes — three rounds at most:', // 9
    '        STEP revise it:',                           // 10
    '            BY builder',                            // 11
    '            DO  amend the plan',                    // 12
    '        IF the plan is final:',                     // 13
    '            RUN ship',                              // 14
    '        ELSE',                                      // 15
    '            PARALLEL',                              // 16
    '                STEP review it:',                   // 17
    '                    DO  read the plan',             // 18
    '    IF the audit passed:',                          // 19
    '        UNTIL every task is delivered:',            // 20
    '            STEP deliver one:',                     // 21
    '                DO  build the next task',           // 22
    '    ELSE',                                          // 23
    '        RUN ship',                                  // 24
  ];
  assert.deepEqual(lintShip(...FLOW_BRANCHES), [], 'flow-level IF/ELSE and UNTIL lint clean in a flow file');
  assert.deepEqual(lintFile(flowsFile, ['ABOUT  a crew', '', 'FLOW ship:', ...FLOW_BRANCHES, ''].join('\n')), [],
    'flow-level IF/ELSE and UNTIL lint clean in a team flows.ap');
  // The branch is transparent: a flow whose only STEP sits under an UNTIL still has one; RUN alone is no STEP.
  assert.deepEqual(lintShip('    UNTIL done:', '        IF a:', '            STEP s:', '                DO  x'), []);
  assert.deepEqual(lintShip('    IF a:', '        RUN ship').map(e => [e.line, e.message]), [[5, 'FLOW block requires at least one STEP']]);
  // Wrong children under a flow-level branch are rejected, at any depth.
  const flowBranchWants = 'expected one of: STEP, PARALLEL, RUN, IF, ELSE, UNTIL';
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done:', '        DO  y', '        BY builder',
    '        IF a:', '            CONTEXT full', '            STEP t:', '                DO  z').map(e => [e.line, e.message]), [
    [9, `DO is not allowed inside UNTIL (${flowBranchWants})`],
    [10, `BY is not allowed inside UNTIL (${flowBranchWants})`],
    [12, `CONTEXT is not allowed inside IF (${flowBranchWants})`],
  ]);
  assert.deepEqual(lintFile(flowsFile, ['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:', '        DO  x',
    '    IF a:', '        DO  y', ''].join('\n')).map(e => [e.line, e.message]), [[7, `DO is not allowed inside IF (${flowBranchWants})`]],
    'a wrong child under a flow-level IF in a team flows.ap');
  // An UNTIL needs a body and a valid condition; an ELSE right after an UNTIL has no IF.
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done:', '    STEP t:', '        DO  y').map(e => [e.line, e.message]),
    [[8, 'UNTIL block body must be indented (Python-style): "UNTIL done:"']]);
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done OR stuck:', '        STEP t:', '            DO  y')
    .map(e => [e.line, e.message]), [[8, 'UNTIL trigger: OR not supported in triggers — write separate rules instead']]);
  assert.deepEqual(lintShip('    UNTIL done:', '        STEP s:', '            DO  x', '    ELSE', '        STEP t:', '            DO  y')
    .map(e => [e.line, e.message]), [[9, 'ELSE must follow an IF in the same body']], 'an ELSE right after an UNTIL');

  // --- lint: a team flows.ap takes the STEP contract like a flow file ---
  assert.deepEqual(lintFile(flowsFile, ['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:', '        BY builder',
    '        NEVER skip the tests', ''].join('\n')).map(e => [e.line, e.message]),
  [[4, 'STEP block requires at least one of: DO, RUN']], 'a team step with only BY and a rule has no action');
  assert.deepEqual(lintFile(flowsFile, ['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:', '        IF a:',
    '            AS idea-verdict', '            DO  x', ''].join('\n')).map(e => [e.line, e.message]),
  [[6, 'AS is not allowed inside IF (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)']], 'AS under a step IF in a team flows.ap');

  // --- lint: MEM is no line of a step, nor of its branches; it stays legal in a procedure ---
  const memWhy = "a step's BY agent may have no memory in its harness; MEM goes in an agent, a role or a procedure";
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        MEM!  the plan', '        IF a:', '            !MEM  secrets').map(e => [e.line, e.message]), [
    [8, `MEM! is not allowed inside STEP — ${memWhy} (expected one of: DO, RUN, CONTEXT, BY, MUST, ALWAYS, SHOULD, MAY, AS, IF, ELSE)`],
    [10, `!MEM is not allowed inside IF — ${memWhy} (expected one of: DO, RUN, MUST, ALWAYS, SHOULD, MAY)`],
  ]);
  assert.deepEqual(lintFile(join(tmp, 'library', 'procedures', 'remember.ap'),
    ['EXPORT PROCEDURE remember:', '    ABOUT  remember the plan', '    DO  read the plan', '    MEM!  the plan', ''].join('\n')), [], 'MEM in a procedure');

  // --- lint: a FLOW header ending in a colon still matches its filename slug ---
  assert.deepEqual(lintFlow(flowFile, ['# ship', '', 'ABOUT  ship it', '', 'FLOW ship:', '    STEP s:', '        DO  x', ''].join('\n')), [],
    '`FLOW ship:` in ship.ap is no slug mismatch');

  // --- the document: the step holds an IF node, its DO lines sit under [step, if] ---
  const { structure } = await bundleAgentObject({
    agentName: 'builder', agentFile, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false },
  });
  const flow = structure.all().find(b => b.kind === 'flow' && b.name === 'ship');
  const [judge, close] = flow.body;
  assert.deepEqual(judge.body.map(n => n.type), ['directive', 'if']);
  assert.equal(judge.body[1].condition, 'the report says replan');
  assert.deepEqual(judge.body[1].then.map(n => n.text), ['end the flow']);
  assert.deepEqual(judge.body[1].else.map(n => n.text), ['hand the report on']);
  assert.deepEqual(close.body.map(n => n.type), ['if']);

  const pos = l => [l.line, l.col, l.text, l.containers.map(c => c.type).join('>')];
  assert.deepEqual(structure.lines('DO').filter(l => l.file === flowsFile).map(pos), [
    [9, 9, 'read the report', 'step'],
    [11, 13, 'end the flow', 'step>if'],
    [13, 13, 'hand the report on', 'step>if'],
    [17, 13, 'tag the release', 'step>if'],
  ]);
  assert.deepEqual(structure.lines('IF').filter(l => l.file === flowsFile).map(pos), [
    [10, 9, 'the report says replan', 'step'],
    [16, 9, 'the audit passed', 'step'],
  ]);
  assert.equal(structure.lineAt(flowsFile, 11).containers[1], judge.body[1], 'the container is the IF node itself');

  // --- the md, `apx flow` and the Workflow script carry the branch ---
  const doc = ApDocument.fromJson(structure.asJson());
  const { content } = await buildOrchestrationContent({
    cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'),
    libraryRoots: [lib], libraries: { '@main': lib },
  });
  const stepMd = [
    '1. judge it — by `builder`',
    '   Do read the report',
    '   If the report says replan:',
    '       Do end the flow',
    '   Else:',
    '       Do hand the report on',
    '2. close it — by `builder`',
    '   If the audit passed:',
    '       Do tag the release',
  ].join('\n');
  assert.ok(content.includes(stepMd), `AGENTS.md renders the branch under its step:\n${content}`);

  const lines = [];
  const code = new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, 'apx/builder.apx', l => lines.push(l))
    .run(['flow', flow.id]);
  assert.equal(code, 0);
  assert.ok(lines.join('\n').includes(stepMd), `apx flow lists the branch:\n${lines.join('\n')}`);

  const script = compileWorkflow(doc.block(flow.address), doc);
  assert.ok(script.includes(JSON.stringify('\n\nStep "judge it" of flow `ship`.\nDo read the report\nIf the report says replan:\n    Do end the flow\nElse:\n    Do hand the report on').slice(1, -1)),
    `the step's agent is told the branch:\n${script}`);

  console.log('step IF tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
