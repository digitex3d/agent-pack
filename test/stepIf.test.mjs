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
import { teamSource } from './helpers/team.mjs';

const { lintFile, lintFlow } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');

const FLOW = [
  'FLOW ship:',                                        // 6
  '    STEP judge it:',                                // 7
  '        DELEGATE judge the report BY builder:',     // 8
  '            DO  read the report',                   // 9
  '            IF the report says replan:',            // 10
  '                DO  end the flow',                  // 11
  '            ELSE',                                  // 12
  '                DO  hand the report on',            // 13
  '    STEP close it:',                                // 14
  '        DELEGATE close the release BY builder:',    // 15
  '            IF the audit passed:',                  // 16
  '                DO  tag the release',               // 17
];

const tmp = mkdtempSync(join(tmpdir(), 'ap-step-if-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'teams', 'crew');
mkdirSync(lib, { recursive: true });
mkdirSync(team, { recursive: true });
const write = (file, lines) => { writeFileSync(file, lines.join('\n') + '\n'); return file; };
const crew = lines => teamSource('crew', ['builder'], lines);
const flowsFile = write(join(team, 'crew.ap'), crew([
  'ABOUT  a crew',                                     // 1
  '',                                                  // 2
  'WHEN asked to ship:',                               // 3
  '    RUN ship',                                      // 4
  '',                                                  // 5
  ...FLOW,
]));
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
  assert.deepEqual(lintFile(flowsFile, crew(['ABOUT  a crew', '', ...FLOW]).join('\n') + '\n'), [], 'a team file lints clean');
  const flowFile = join(tmp, 'flows', 'ship.ap');
  const lintShip = (...lines) => lintFlow(flowFile, ['# ship', '', 'ABOUT  ship it', '', 'FLOW ship', ...lines, ''].join('\n'));
  assert.deepEqual(lintShip(...FLOW.slice(1)), [], 'a flow file lints clean — a step whose DO all sit under an IF included');

  // --- lint: an IF with nothing under it is the error it is anywhere else, and lends the step no action ---
  const STEP_WANTS = 'DO, DELEGATE, COMPUTE, FORK, WAIT, MARK, RUN';
  const BRANCH_WANTS = `expected one of: ${STEP_WANTS}, MUST, ALWAYS, SHOULD, MAY`;
  const empty = lintShip('    STEP close it:', '        IF the audit passed:', '    STEP next:', '        DO  go');
  assert.deepEqual(empty.map(e => [e.line, e.message]), [
    [7, 'IF/ELSE block body must be indented (Python-style): "IF the audit passed:"'],
    [6, `STEP block requires at least one of: ${STEP_WANTS}`],
  ]);
  const emptyElse = lintShip('    STEP s:', '        IF a:', '            DO  x', '        ELSE', '        DO  y');
  assert.deepEqual(emptyElse.map(e => [e.line, e.message]), [[9, 'IF/ELSE block body must be indented (Python-style): "ELSE"']]);

  // --- lint: the branch holds the step's lines; a step names no one, under an IF neither ---
  const inside = lintShip('    STEP s:', '        IF a:', '            BY builder', '            DELEGATE~ trace it INTO paths BY builder',
    '            WAIT paths', '            IF b:', '                DO  x', '            RUN go', '        DO  y');
  assert.deepEqual(inside.map(e => [e.line, e.message]), [
    [8, `BY is not allowed inside IF — a step names no one — whoever runs the flow carries it out: hand its work over with \`DELEGATE <task> BY <agent> [AS <template>]\` (${BRANCH_WANTS})`],
    [11, `IF is not allowed inside IF (${BRANCH_WANTS})`],
  ]);
  // A FLOW itself admits IF/ELSE and UNTIL too — see the flow-level section below.
  assert.deepEqual(lintShip('    IF a:', '        STEP s:', '            DO  x'), [], 'IF is a line of a FLOW itself');
  // The error lists the branch keywords with the step's own.
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        UNTIL done:', '            DO  y').map(e => e.message),
    [`UNTIL is not allowed inside STEP (expected one of: ${STEP_WANTS}, MUST, ALWAYS, SHOULD, MAY, IF, ELSE)`]);

  // --- lint: an ELSE with no IF before it in the same body is rejected ---
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        ELSE', '            DO  y').map(e => [e.line, e.message]),
    [[8, 'ELSE must follow an IF in the same body']], 'an orphan ELSE in a step');
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        IF a:', '            DO  y', '    STEP t:', '        ELSE', '            DO  z')
    .map(e => [e.line, e.message]), [[11, 'ELSE must follow an IF in the same body']], 'an IF of another step lends it nothing');

  // --- lint: a FLOW holds IF/ELSE and UNTIL, which hold STEP/PARALLEL/RUN and nest further ---
  const FLOW_BRANCHES = [
    '    STEP plan it:',                                 // 6
    '        DELEGATE write the plan BY builder',        // 7
    '    UNTIL the audit passes — three rounds at most:', // 8
    '        STEP revise it:',                           // 9
    '            DELEGATE amend the plan BY builder',    // 10
    '        IF the plan is final:',                     // 11
    '            RUN ship',                              // 12
    '        ELSE',                                      // 13
    '            STEP review it:',                       // 14
    '                DELEGATE~ read the plan BY builder', // 15
    '                WAIT ALL',                          // 16
    '    IF the audit passed:',                          // 17
    '        UNTIL every task is delivered:',            // 18
    '            STEP deliver one:',                     // 19
    '                DO  build the next task',           // 20
    '    ELSE',                                          // 21
    '        RUN ship',                                  // 22
  ];
  assert.deepEqual(lintShip(...FLOW_BRANCHES), [], 'flow-level IF/ELSE and UNTIL lint clean in a flow file');
  assert.deepEqual(lintFile(flowsFile, crew(['ABOUT  a crew', '', 'FLOW ship:', ...FLOW_BRANCHES, '']).join('\n')), [],
    'flow-level IF/ELSE and UNTIL lint clean in a team file');
  // The branch is transparent: a flow whose only STEP sits under an UNTIL still has one; RUN alone is no STEP.
  assert.deepEqual(lintShip('    UNTIL done:', '        IF a:', '            STEP s:', '                DO  x'), []);
  assert.deepEqual(lintShip('    IF a:', '        RUN ship').map(e => [e.line, e.message]), [[5, 'FLOW block requires at least one STEP']]);
  // Wrong children under a flow-level branch are rejected, at any depth.
  const flowBranchWants = 'expected one of: STEP, PARALLEL, RUN, IF, ELSE, UNTIL';
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done:', '        DO  y', '        DELEGATE z BY builder',
    '        IF a:', '            WAIT ALL', '            STEP t:', '                DO  z').map(e => [e.line, e.message]), [
    [9, `DO is not allowed inside UNTIL (${flowBranchWants})`],
    [10, `DELEGATE is not allowed inside UNTIL (${flowBranchWants})`],
    [12, `WAIT is not allowed inside IF (${flowBranchWants})`],
  ]);
  assert.deepEqual(lintFile(flowsFile, crew(['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:', '        DO  x',
    '    IF a:', '        DO  y', '']).join('\n')).map(e => [e.line, e.message]), [[9, `DO is not allowed inside IF (${flowBranchWants})`]],
    'a wrong child under a flow-level IF in a team file');
  // An UNTIL needs a body and a valid condition; an ELSE right after an UNTIL has no IF.
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done:', '    STEP t:', '        DO  y').map(e => [e.line, e.message]),
    [[8, 'UNTIL block body must be indented (Python-style): "UNTIL done:"']]);
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '    UNTIL done OR stuck:', '        STEP t:', '            DO  y')
    .map(e => [e.line, e.message]), [[8, 'UNTIL trigger: OR not supported in triggers — write separate rules instead']]);
  assert.deepEqual(lintShip('    UNTIL done:', '        STEP s:', '            DO  x', '    ELSE', '        STEP t:', '            DO  y')
    .map(e => [e.line, e.message]), [[9, 'ELSE must follow an IF in the same body']], 'an ELSE right after an UNTIL');

  // --- lint: a team file takes the STEP contract like a flow file ---
  assert.deepEqual(lintFile(flowsFile, crew(['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:',
    '        NEVER skip the tests', '']).join('\n')).map(e => [e.line, e.message]),
  [[6, `STEP block requires at least one of: ${STEP_WANTS}`]], 'a team step with only a rule has no action');
  assert.deepEqual(lintFile(flowsFile, crew(['ABOUT  a crew', '', 'FLOW ship:', '    STEP s:', '        IF a:',
    '            AS idea-verdict', '            DO  x', '']).join('\n')).map(e => [e.line, e.message]),
  [[8, `AS is not allowed inside IF — a step hands nothing over itself — the shape of what is handed over is its DELEGATE's: \`DELEGATE <task> BY <agent> AS <template>\` (${BRANCH_WANTS})`]], 'AS under a step IF in a team file');

  // --- lint: MEM is no line of a step, nor of its branches; it stays legal in a procedure ---
  const memWhy = 'whoever runs a flow may have no memory in its harness; MEM goes in an agent, a role or a procedure';
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        MEM!  the plan', '        IF a:', '            !MEM  secrets').map(e => [e.line, e.message]), [
    [8, `MEM! is not allowed inside STEP — ${memWhy} (expected one of: ${STEP_WANTS}, MUST, ALWAYS, SHOULD, MAY, IF, ELSE)`],
    [10, `!MEM is not allowed inside IF — ${memWhy} (${BRANCH_WANTS})`],
  ]);
  assert.deepEqual(lintFile(join(tmp, 'library', 'procedures', 'remember.ap'),
    ['EXPORT PROCEDURE remember:', '    ABOUT  remember the plan', '    DO  read the plan', '    MEM!  the plan', ''].join('\n')), [], 'MEM in a procedure');

  // --- lint: a FLOW header ending in a colon still matches its filename slug ---
  assert.deepEqual(lintFlow(flowFile, ['# ship', '', 'ABOUT  ship it', '', 'FLOW ship:', '    STEP s:', '        DO  x', ''].join('\n')), [],
    '`FLOW ship:` in ship.ap is no slug mismatch');

  // --- the document: the step holds its DELEGATE, the DELEGATE an IF node, its DO lines sit under [step, directive, if] ---
  const { structure } = await bundleAgentObject({
    agentName: 'builder', agentFile, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false },
  });
  const flow = structure.all().find(b => b.kind === 'flow' && b.name === 'ship');
  const [judgeStep, closeStep] = flow.body;
  const [judge] = judgeStep.body;
  assert.deepEqual([judge.keyword, judge.by], ['DELEGATE', 'builder']);
  assert.deepEqual(judge.body.map(n => n.type), ['directive', 'if']);
  assert.equal(judge.body[1].condition, 'the report says replan');
  assert.deepEqual(judge.body[1].then.map(n => n.text), ['end the flow']);
  assert.deepEqual(judge.body[1].else.map(n => n.text), ['hand the report on']);
  assert.deepEqual(closeStep.body[0].body.map(n => n.type), ['if']);

  const pos = l => [l.line, l.col, l.text, l.containers.map(c => c.type).join('>')];
  assert.deepEqual(structure.lines('DO').filter(l => l.file === flowsFile).map(pos), [
    [11, 17, 'read the report', 'step>directive'],
    [13, 21, 'end the flow', 'step>directive>if'],
    [15, 21, 'hand the report on', 'step>directive>if'],
    [19, 21, 'tag the release', 'step>directive>if'],
  ]);
  assert.deepEqual(structure.lines('IF').filter(l => l.file === flowsFile).map(pos), [
    [12, 17, 'the report says replan', 'step>directive'],
    [18, 17, 'the audit passed', 'step>directive'],
  ]);
  assert.equal(structure.lineAt(flowsFile, 13).containers[2], judge.body[1], 'the container is the IF node itself');

  // --- the md, `apx flow` and the Workflow script carry the branch ---
  const doc = ApDocument.fromJson(structure.asJson());
  const { content } = await buildOrchestrationContent({
    cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'),
    libraryRoots: [lib], libraries: { '@main': lib },
  });
  const stepMd = [
    '1. judge it',
    '   Delegate: judge the report — to `builder`, with all your context:',
    '       Do read the report',
    '       If the report says replan:',
    '           Do end the flow',
    '       Else:',
    '           Do hand the report on',
    '2. close it',
    '   Delegate: close the release — to `builder`, with all your context:',
    '       If the audit passed:',
    '           Do tag the release',
  ].join('\n');
  assert.ok(content.includes(stepMd), `AGENTS.md renders the branch under its step:\n${content}`);

  const lines = [];
  const code = new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, 'apx/builder.apx', l => lines.push(l))
    .run(['flow', flow.id]);
  assert.equal(code, 0);
  assert.ok(lines.join('\n').includes(stepMd), `apx flow lists the branch:\n${lines.join('\n')}`);

  const script = compileWorkflow(doc.block(flow.address), doc);
  assert.ok(script.includes(JSON.stringify('\n\nStep "judge it" of flow `ship`: judge the report\nDo read the report\nIf the report says replan:\n    Do end the flow\nElse:\n    Do hand the report on').slice(1, -1)),
    `the agent delegated to is told the branch:\n${script}`);

  console.log('step IF tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
