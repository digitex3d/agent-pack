// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The team block — `EXPORT TEAM <name>:` in `<team>.ap`.
 *
 *   - a member's document carries the team: its ABOUT, its MEMBER roster (lines
 *     add up), its routing and its flows, each with its position in the file
 *   - the roster is authoritative: a MEMBER with no agent file, an agent file
 *     not listed, a MEMBER listed twice, a block named unlike its folder
 *   - a TEAM that is not exported, or a second one, is an error
 *   - the orchestration reads the same file: purpose, members, routing, flows
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamSource } from './helpers/team.mjs';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { lintFile } = await import('../dist/src/lint.js');
const { readTeamFile, teamRootForAgentFile, readTeamMembers, readTeamPurpose } = await import('../dist/src/services/teamMetadata.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-team-'));
const lib = join(tmp, 'library');
const teams = join(tmp, 'teams');
const team = join(teams, 'crew');
mkdirSync(join(lib, 'templates'), { recursive: true });
mkdirSync(team, { recursive: true });
const write = (file, lines) => { writeFileSync(file, `${lines.join('\n')}\n`); return file; };

write(join(lib, 'templates', 'report.ap'), ['EXPORT TEMPLATE report:', '    ABOUT  a report', '    SLOTS:', '        text: TEXT  "the text"', '    BODY:', '        {text}']);
const member = (name, about = 'a member') => write(join(team, `${name}.ap`), [
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${about}`, '    MANDATE  do the work', '',
  `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  do the work',
]);
const builder = member('builder', 'builds things');
member('checker', 'checks things');

const TEAM_BODY = [
  'IMPORT report FROM @main.templates',
  'ABOUT  a crew that ships',
  '',
  'WHEN asked to ship:',
  '    RUN ship',
  '',
  'FLOW ship:',
  '    STEP build it:',
  '        DELEGATE compile the code BY builder',
  '    STEP check it:',
  '        DELEGATE run the checks BY checker AS report:',
  '            DO  run the linter first',
];
const teamFile = join(team, 'crew.ap');
const writeTeam = (lines, members = ['builder', 'checker']) => write(teamFile, teamSource('crew', members, lines));

const compile = (name = 'builder') => bundleAgentObject({
  agentName: name, agentFile: join(team, `${name}.ap`), agentDir: team, libraryRoot: lib, libraryRoots: [lib],
  libraries: { '@main': lib }, bundleConfig: { runtime: false },
});
const orchestration = () => buildOrchestrationContent({
  cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: teams, libraryRoots: [lib], libraries: { '@main': lib },
});

try {
  // --- the file, read once: block, roster, purpose, the unit the pipeline reads ---
  writeTeam(TEAM_BODY);
  const read = readTeamFile(team);
  assert.equal(read.name, 'crew');
  assert.equal(read.about, 'a crew that ships');
  assert.deepEqual(read.members.map(m => m.name), ['builder', 'checker']);
  assert.equal(teamRootForAgentFile(builder), team, 'the folder with a team file is the team root');
  assert.equal(readTeamPurpose(team), 'a crew that ships');
  assert.deepEqual(readTeamMembers(team).map(m => m.name), ['builder', 'checker'], 'members in MEMBER order');
  const unit = read.unit.split('\n');
  assert.equal(unit.length, read.source.split('\n').length, 'the unit keeps every line number');
  assert.equal(unit[0], 'IMPORT report FROM @main.templates', 'the prologue stays');
  assert.equal(unit[2], '', 'the opener is blanked');
  assert.equal(unit[3], '', 'the MEMBER line is blanked');
  assert.equal(unit[4], 'ABOUT  a crew that ships', "the block's lines stand at the top");
  assert.equal(unit[9], 'FLOW ship:');
  assert.equal(unit[10], '    STEP build it:');
  assert.deepEqual(lintFile(teamFile, read.source), [], 'a team file lints clean');

  // --- a member's document carries the team ---
  const { structure } = await compile();
  const crew = structure.byKind('team')[0];
  assert.equal(crew.name, 'crew');
  assert.equal(crew.about, 'a crew that ships');
  assert.deepEqual(crew.members.map(r => r.target.split('/').pop()), ['builder', 'checker']);
  assert.deepEqual(crew.routing.map(r => r.when), ['asked to ship']);
  assert.deepEqual(crew.source, { file: teamFile, line: 3, col: 1 }, 'the team is its EXPORT TEAM block');
  const ship = structure.byKind('flow').find(b => b.name === 'ship');
  assert.ok(ship, "the team's flow travels in the member's document");
  assert.deepEqual(ship.source, { file: teamFile, line: 10, col: 5 }, 'the flow is where it is written');
  assert.deepEqual(ship.body.map(s => s.title), ['build it', 'check it']);
  const check = ship.body[1].body[0];
  assert.deepEqual([check.keyword, check.by, check.as?.ref?.target?.split('/').pop()], ['DELEGATE', 'checker', 'report'], "a DELEGATE's AS resolves through the prologue's IMPORT");
  assert.deepEqual(structure.lines('DELEGATE').filter(l => l.file === teamFile).map(l => [l.line, l.col, l.text]),
    [[12, 13, 'compile the code'], [14, 13, 'run the checks']]);
  assert.deepEqual(structure.lines('DO').filter(l => l.file === teamFile).map(l => [l.line, l.col, l.text]), [[15, 17, 'run the linter first']]);

  // --- MEMBER lines add up ---
  write(teamFile, ['EXPORT TEAM crew:', '    MEMBER  builder', '    MEMBER  checker', '    ABOUT   a crew']);
  assert.deepEqual(readTeamFile(team).members.map(m => m.name), ['builder', 'checker']);
  assert.deepEqual((await compile()).structure.byKind('team')[0].members.length, 2);

  // --- the roster is authoritative ---
  writeTeam(TEAM_BODY, ['builder']);
  await assert.rejects(compile(), /crew\.ap:3 {2}TEAM crew: the agent `checker` \(checker\.ap\) is in the folder but not among its MEMBER lines/);
  writeTeam(TEAM_BODY, ['builder', 'checker', 'ghost']);
  await assert.rejects(compile(), /crew\.ap:4 {2}MEMBER ghost: no agent file in `crew\/` declares `EXPORT AGENT ghost`/);
  writeTeam(TEAM_BODY, ['builder', 'checker', 'builder']);
  await assert.rejects(compile(), /crew\.ap:4 {2}MEMBER builder: listed twice/);
  write(teamFile, teamSource('squad', ['builder', 'checker'], TEAM_BODY));
  await assert.rejects(compile(), /crew\.ap:3 {2}TEAM squad: a team is named like its folder — `crew`/);
  await assert.rejects(orchestration(), /TEAM squad: a team is named like its folder/);

  // --- the block's own contract ---
  write(teamFile, ['EXPORT TEAM crew:', '    MEMBER  builder, checker']);
  await assert.rejects(compile(), /crew\.ap:1 {2}TEAM block requires at least one ABOUT/);
  write(teamFile, ['EXPORT TEAM crew:', '    ABOUT   a crew']);
  await assert.rejects(compile(), /crew\.ap:1 {2}TEAM block requires at least one MEMBER/);
  write(teamFile, ['EXPORT TEAM crew:', '    ABOUT   a crew', '    MEMBER  builder, checker', '    MANDATE ship']);
  await assert.rejects(compile(), /crew\.ap:4 {2}MANDATE is not allowed inside TEAM/);
  write(teamFile, ['TEAM crew:', '    ABOUT   a crew', '    MEMBER  builder, checker']);
  assert.ok(lintFile(teamFile, 'TEAM crew:\n    ABOUT   a crew\n    MEMBER  builder, checker\n').some(e => /a team is exported — write `EXPORT TEAM crew:`/.test(e.message)));
  assert.ok(lintFile(teamFile, ['EXPORT TEAM crew:', '    ABOUT   a', '    MEMBER  builder', 'EXPORT TEAM crew:', '    ABOUT   b', '    MEMBER  checker', ''].join('\n'))
    .some(e => e.line === 4 && /a file declares one team — found 2 TEAM blocks/.test(e.message)));
  assert.ok(lintFile(join(tmp, 'x.ap'), 'EXPORT AGENT x AS r:\n    ABOUT  x\n    MANDATE  y\n    MEMBER  z\n').some(e => /MEMBER is a line of a TEAM block — found inside AGENT/.test(e.message)));

  // --- the orchestration reads the same file ---
  writeTeam(TEAM_BODY);
  const { content, teams: names } = await orchestration();
  assert.deepEqual(names, ['crew']);
  assert.ok(content.includes('`purpose`: a crew that ships'), content);
  assert.ok(content.includes('- `builder` — builds things') && content.includes('- `checker` — checks things'), content);
  assert.ok(content.includes('When asked to ship:'), content);
  assert.ok(content.includes('## `ship`'), content);
  assert.ok(!content.includes('MEMBER'), 'the MEMBER lines are not prose');

  // --- a step may name a team: it carries the step out by its own routing ---
  const ops = join(teams, 'ops');
  mkdirSync(ops);
  write(join(ops, 'deployer.ap'), ['EXPORT AGENT deployer AS deployer-role:', '    ABOUT  deploys', '    MANDATE  deploy', '', 'ROLE deployer-role:', '    ABOUT  a', '    ALWAYS  b']);
  write(join(ops, 'ops.ap'), teamSource('ops', ['deployer'], ['ABOUT  a crew that deploys', '', 'WHEN asked to deploy:', '    RUN deploy', '', 'FLOW deploy:', '    STEP deploy it:', '        DELEGATE push the build BY deployer']));
  const handOff = ['    STEP hand it to ops:', '        DELEGATE deploy what was built BY ops'];
  writeTeam([...TEAM_BODY, ...handOff]);
  const { teamNamesUnder } = await import('../dist/src/services/teamMetadata.js');
  const withTeams = () => bundleAgentObject({
    agentName: 'builder', agentFile: builder, agentDir: team, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false }, teams: teamNamesUnder(teams),
  });
  const handed = (await withTeams()).structure.byKind('flow').find(f => f.name === 'ship').body[2].body[0];
  assert.equal(handed.by, 'ops', 'a delegation may name a team');
  const routed = (await orchestration()).content;
  assert.ok(routed.includes('3. hand it to ops\n   Delegate: deploy what was built — to `ops`, with all your context'), routed);
  assert.ok(routed.includes('a team takes it as one agent: run the flow its routing picks'), routed);
  writeTeam([...TEAM_BODY, ...handOff.map(l => l.replace('BY ops', 'BY nobody'))]);
  await assert.rejects(withTeams(), /unknown agent `nobody` — BY names a member of this team, or a team/);
  await assert.rejects(orchestration(), /BY nobody: no team member, no role bound to one and no team is called `nobody`/);
  rmSync(ops, { recursive: true });
  writeTeam(TEAM_BODY);

  console.log('team block tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
