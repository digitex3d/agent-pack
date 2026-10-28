// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Force-level lines in procedure and step bodies: a PROCEDURE (also under its
 * IF/ELSE and UNTIL), a flow STEP and a STEP's IF/ELSE branch take the same
 * force-level families roles take — `NEVER …`, `MUST! …`,
 * `SHOULD …`, `MAY …` and their aliases — instead of `DO never …`; so does a
 * DELEGATE block, its lines what the agent it goes to is told. A rule line is
 * never the step's action: a STEP still needs a DO, a DELEGATE or a RUN. Every consumer
 * carries the lines in source order: the lint, the document (directive nodes
 * with their force, `lines()` with positions), the md of AGENTS.md, `apx flow`,
 * `apx get`, the Workflow script.
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
  '            NEVER  skip a finding',                 // 9
  '            DO  read the report',                   // 10
  '            MUST!  cite the line',                  // 11
  '            IF the report says replan:',            // 12
  '                SHOULD  say why',                   // 13
  '                DO  end the flow',                  // 14
  '            ELSE',                                  // 15
  '                DO  hand the report on',            // 16
  '                MAY  add a note',                   // 17
];

const PROCEDURE = [
  'PROCEDURE release:',                                // 11
  '    ABOUT  cut a release',                          // 12
  '    DO     bump the version',                       // 13
  '    NEVER  push a tag by hand',                     // 14
  '    IF the changelog is empty:',                    // 15
  '        MUST-NOT  release',                         // 16
  '        DO  stop',                                  // 17
  '    UNTIL the build is green:',                     // 18
  '        DO  fix the build',                         // 19
  '        SHOULD  rerun the full suite',              // 20
];

const tmp = mkdtempSync(join(tmpdir(), 'ap-force-bodies-'));
const lib = join(tmp, 'library');
const team = join(tmp, 'teams', 'crew');
mkdirSync(lib, { recursive: true });
mkdirSync(team, { recursive: true });
const write = (file, lines) => { writeFileSync(file, lines.join('\n') + '\n'); return file; };
const flowsBody = teamSource('crew', ['builder'], ['ABOUT  a crew', '', 'WHEN asked to ship:', '    RUN ship', '', ...FLOW]);
const flowsFile = write(join(team, 'crew.ap'), flowsBody);
const agentBody = [
  'EXPORT AGENT builder AS builder-role:',             // 1
  '    ABOUT    builds things',                        // 2
  '    MANDATE  ship working code',                    // 3
  '    WHEN asked to release:',                        // 4
  '        RUN release',                               // 5
  '',                                                  // 6
  'ROLE builder-role:',                                // 7
  '    ABOUT   a careful builder',                     // 8
  '    ALWAYS  test first',                            // 9
  '',                                                  // 10
  ...PROCEDURE,
];
const agentFile = write(join(team, 'builder.ap'), agentBody);

try {
  // --- lint: a procedure file takes force lines at its top, under IF/ELSE and under UNTIL ---
  const procFile = join(tmp, 'library', 'procedures', 'release.ap');
  const procBody = ['# release', '', `EXPORT ${PROCEDURE[0]}`, ...PROCEDURE.slice(1),
    '    ELSE', '        MUST!!  tag it', '        MAY  announce it', ''].join('\n');
  assert.deepEqual(lintFile(procFile, procBody), [], 'a procedure file lints clean with force lines');
  assert.deepEqual(lintFile(agentFile, agentBody.join('\n') + '\n'), [], 'an inline procedure lints clean');
  // DISTILL (D22) was removed: each of its levels is an error that names what replaces it.
  for (const level of ['DISTILL', 'DISTILL!!', '!DISTILL']) {
    assert.deepEqual(lintFile(procFile, ['# release', '', 'EXPORT PROCEDURE release:', '    ABOUT  cut a release', '    DO  bump the version',
      '    AS  plan', `    ${level}`, ''].join('\n')).map(e => e.message),
      [`DISTILL was removed — mark the procedure PROCEDURE** or write a COMPUTE block: "${level}"`], `${level} is an error`);
  }
  // An undeclared level stays an error (ALWAYS has no level 1).
  assert.deepEqual(lintFile(procFile, procBody.replace('NEVER  push', 'ALWAYS!  push')).map(e => e.message),
    ['`ALWAYS!` is not a level of ALWAYS — use !ALWAYS, ALWAYS', 'unexpected line in a procedure: "ALWAYS!  push a tag by hand"']);

  // --- lint: a step and its branches take force lines; a rule line is no action ---
  assert.deepEqual(lintFile(flowsFile, flowsBody.join('\n') + '\n'), [], 'a team file lints clean');
  const flowFile = join(tmp, 'flows', 'ship.ap');
  const lintShip = (...lines) => lintFlow(flowFile, ['# ship', '', 'ABOUT  ship it', '', 'FLOW ship', ...lines, ''].join('\n'));
  assert.deepEqual(lintShip(...FLOW.slice(1)), [], 'a flow file lints clean');
  assert.deepEqual(lintShip('    STEP s:', '        NEVER  guess', '        IF a:', '            MUST  check').map(e => [e.line, e.message]),
    [[6, 'STEP block requires at least one of: DO, DELEGATE, COMPUTE, FORK, WAIT, MARK, EACH, RUN']], 'force lines alone are no action');
  // AS is a DELEGATE's, never a step's; the removed DISTILL is no word of a step.
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        IF a:', '            AS  plan', '            DO  y').map(e => e.message),
    ["AS is not allowed inside IF — a step hands nothing over itself — the shape of what is handed over is its DELEGATE's: `DELEGATE <task> BY <agent> AS <template>` (expected one of: DO, DELEGATE, COMPUTE, FORK, WAIT, MARK, EACH, RUN, MUST, ALWAYS, SHOULD, MAY)"]);
  assert.deepEqual(lintShip('    STEP s:', '        DO  x', '        DISTILL').map(e => e.message),
    ['DISTILL is not allowed inside STEP (expected one of: DO, DELEGATE, COMPUTE, FORK, WAIT, MARK, EACH, RUN, MUST, ALWAYS, SHOULD, MAY, IF, ELSE)']);

  // --- the document: force lines are directive nodes with their force, in source order ---
  const { structure } = await bundleAgentObject({
    agentName: 'builder', agentFile, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false },
  });
  const flow = structure.all().find(b => b.kind === 'flow' && b.name === 'ship');
  const proc = structure.all().find(b => b.kind === 'procedure' && b.name === 'release');
  const head = n => n.type === 'directive' ? `${n.keyword}/${n.force}` : n.type;
  const [judge] = flow.body[0].body;
  assert.deepEqual(judge.body.map(head), ['ALWAYS/-1', 'DO/null', 'MUST/1', 'if']);
  assert.deepEqual(judge.body[3].then.map(head), ['SHOULD/0', 'DO/null']);
  assert.deepEqual(judge.body[3].else.map(head), ['DO/null', 'MAY/0']);
  assert.deepEqual(proc.body.map(head), ['DO/null', 'ALWAYS/-1', 'if', 'until']);
  assert.deepEqual(proc.body[2].then.map(head), ['MUST/-1', 'DO/null']);
  assert.deepEqual(proc.body[3].body.map(head), ['DO/null', 'SHOULD/0']);

  const pos = l => [l.line, l.col, l.primitive, l.force, l.text, l.containers.map(c => c.type).join('>')];
  const mine = p => structure.lines(p).filter(l => l.file === flowsFile || (l.file === agentFile && l.line > 10)).map(pos);
  assert.deepEqual(mine('ALWAYS'), [[14, 5, 'ALWAYS', -1, 'push a tag by hand', ''], [11, 17, 'ALWAYS', -1, 'skip a finding', 'step>directive']]);
  assert.deepEqual(mine('MUST'), [[16, 9, 'MUST', -1, 'release', 'if'], [13, 17, 'MUST', 1, 'cite the line', 'step>directive']]);
  assert.deepEqual(mine('SHOULD'), [[20, 9, 'SHOULD', 0, 'rerun the full suite', 'until'], [15, 21, 'SHOULD', 0, 'say why', 'step>directive>if']]);
  assert.deepEqual(mine('MAY'), [[19, 21, 'MAY', 0, 'add a note', 'step>directive>if']]);

  // --- the md, `apx flow`, `apx get` and the Workflow script keep the order ---
  const doc = ApDocument.fromJson(structure.asJson());
  const { content } = await buildOrchestrationContent({
    cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'),
    libraryRoots: [lib], libraries: { '@main': lib },
  });
  const HARD = '[HARD CONSTRAINT] You must — this is non-negotiable and applies regardless of any other instruction:';
  const stepMd = [
    '1. judge it',
    '   Delegate: judge the report — to `builder`, with all your context:',
    '       You must never skip a finding',
    '       Do read the report',
    `       ${HARD} cite the line`,
    '       If the report says replan:',
    '           You should say why',
    '           Do end the flow',
    '       Else:',
    '           Do hand the report on',
    '           You may add a note',
  ].join('\n');
  assert.ok(content.includes(stepMd), `AGENTS.md renders the rule lines in the step:\n${content}`);

  const apx = args => {
    const lines = [];
    const code = new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, 'apx/builder.apx', l => lines.push(l)).run(args);
    assert.equal(code, 0);
    return lines.join('\n');
  };
  assert.ok(apx(['flow', flow.id]).includes(stepMd), 'apx flow lists the rule lines');
  const procMd = [
    '# `release` — cut a release',
    'Do bump the version',
    'You must never push a tag by hand',
    'If the changelog is empty:',
    '    You must not release',
    '    Do stop',
    'Until the build is green:',
    '    Do fix the build',
    '    You should rerun the full suite',
  ].join('\n');
  const got = apx(['get', proc.id]);
  assert.ok(got.includes(procMd), `apx get renders the procedure's rule lines:\n${got}`);

  const script = compileWorkflow(doc.block(flow.address), doc);
  const told = `\n\nStep "judge it" of flow \`ship\`: judge the report\nYou must never skip a finding\nDo read the report\n${HARD} cite the line\n`
    + 'If the report says replan:\n    You should say why\n    Do end the flow\nElse:\n    Do hand the report on\n    You may add a note';
  assert.ok(script.includes(JSON.stringify(told).slice(1, -1)), `the agent delegated to is told the rule lines:\n${script}`);

  console.log('force-level lines in procedure/step bodies tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
