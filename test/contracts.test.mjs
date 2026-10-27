// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The contracts strategy — the language side (D44).
 *
 *   - `EXPORT TEAM` with `STRATEGY contracts`, `LEAD` and CONTRACT
 *     blocks: the lead's document holds the contracts (its own, and the ones
 *     handed to the team from PROJECT.ap or another team) and the team's roster
 *     is the lead plus whoever a BY names
 *   - `WHEN handed <contract>:` is a member's entry: the trigger's input is the
 *     contract, resolved and rendered
 *   - the checks: the two shapes of a team, DOMAIN against the BY agent's WRITES, BY
 *     against the folder and the teams of contracts, a member without its WHEN,
 *     LENS-IN in such a team, a team no contract hands work to, a project
 *     contract that names no team
 */

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject, bundleStandaloneToString } = await import('../dist/src/compiler/index.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { buildContractIndex, readTeamFile } = await import('../dist/src/services/teamMetadata.js');
const { lintFile } = await import('../dist/src/lint.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { JudgeLock } = await import('../dist/src/judge/lock.js');
const { JudgeRun } = await import('../dist/src/judge/phase.js');
const { UnitStore } = await import('../dist/src/judge/units.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-contracts-'));
const lib = join(tmp, 'library');
const teams = join(tmp, 'agents', 'teams');
const backend = join(teams, 'backend');
const project = join(tmp, 'PROJECT.ap');
for (const d of ['templates', 'domains']) mkdirSync(join(lib, d), { recursive: true });
mkdirSync(backend, { recursive: true });
const write = (file, lines) => { writeFileSync(file, lines.join('\n') + '\n'); return file; };
const tpl = (name, slots) => write(join(lib, 'templates', `${name}.ap`), [`EXPORT TEMPLATE ${name}:`, `    ABOUT  ${name}`, '    SLOTS:', ...slots.map(s => `        ${s}`), '    BODY:', '        {' + slots[0].split(':')[0] + '}']);
tpl('endpoint-spec', ['goal: TEXT  "what the zone does"', 'interface: TEXT  "signatures, verbatim"']);
tpl('change-request', ['request: TEXT  "the request"']);
const domain = (name, globs) => write(join(lib, 'domains', `${name}.ap`), [`EXPORT DOMAIN ${name}:`, `    ABOUT  ${name}`, `    FOR    ${globs}`]);
domain('api', 'src/api/**'); domain('persistence', 'src/db/**');

const agent = (dir, name, lines, top = []) => write(join(dir, `${name}.ap`), [
  ...top, `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', ...lines, '',
  `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  do the work',
]);
const lead = () => write(join(backend, 'architect.ap'), [
  'DOMAIN code:', '    ABOUT  the source', '    FOR    src/**', '',
  'EXPORT AGENT architect AS lead-role:', '    ABOUT    plans and hands out', '    MANDATE  deliver the change', '    WRITES   code',
  '    WHEN handed change:', '        DO  write the skeletons and hand the zones out', '',
  'ROLE lead-role:', '    ABOUT   a lead', '    ALWAYS  finish before anyone starts',
]);
/** A member writes the domain of the contract it is handed. */
const DOMAIN_OF = { endpoint: 'api', repository: 'persistence' };
const member = (name, contract, extra = [], writes = DOMAIN_OF[contract]) => agent(backend, name, [`    WRITES   ${writes}`, ...extra, `    WHEN handed ${contract}:`, '        DO  implement the zone, then deliver'], [`IMPORT ${writes} FROM @main.domains`, '']);
const TEAM = (contracts = ['    CONTRACT endpoint:', '        ABOUT   one HTTP endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      api-dev',
  '    CONTRACT repository:', '        ABOUT   one table and its repository', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      db-dev'], head = ['    STRATEGY  contracts', '    LEAD      architect']) =>
  write(join(backend, 'backend.ap'), ['IMPORT endpoint-spec FROM @main.templates', '', 'EXPORT TEAM backend:', '    ABOUT     builds a backend change by contracts', ...head, ...contracts]);
const PROJECT = (by = 'backend', extra = []) => write(project, ['ABOUT  the project', '', 'IMPORT change-request FROM @main.templates', '', 'CONTRACT change:', '    ABOUT   any change the user asks for', ...extra, '    AS      change-request', `    BY      ${by}`]);

lead(); member('api-dev', 'endpoint'); member('db-dev', 'repository'); TEAM(); PROJECT();

const index = () => buildContractIndex(teams, project);
/** A judge that finds every line fine — the library holds no judge rule anyway. */
const fake = { type: 'judge', name: 'fake', async ask(_state, checks) { return { model: 'fake-1.0', answers: Object.fromEntries(checks.map(c => [c.id, 1])) }; } };
const judgeRun = () => {
  const lockPath = join(tmp, 'agent-pack.judge.lock');
  const lock = JudgeLock.load(lockPath, 'fake');
  return new JudgeRun({ adapter: fake, threshold: 0.5, offline: 'warn', lock: lockPath, concurrency: 2 }, [], lock, new UnitStore(join(tmp, '.agent-pack', 'units'), tmp, lock.model, {}));
};
const compile = (name, dir = backend) => bundleAgentObject({
  agentName: name, agentFile: join(dir, `${name}.ap`), agentDir: dir, libraryRoot: lib, libraryRoots: [lib],
  libraries: { '@main': lib }, bundleConfig: { runtime: false }, contractIndex: index(), projectRoot: tmp, judge: judgeRun(),
});
const config = { libraryRoot: lib, sharedLibraries: [], teamsDir: teams, agentsDir: join(tmp, 'agents') };
const orchestration = () => buildOrchestrationContent({ cwd: tmp, standaloneAgentsDir: join(tmp, 'agents', 'standalone'), teamsDir: teams, libraryRoots: [lib], libraries: { '@main': lib } });
const last = s => s.split('/').pop();

try {
  // --- the team file: strategy, lead, domains, contracts, the derived roster ---
  const team = readTeamFile(backend);
  assert.equal(team.strategy.name, 'contracts');
  assert.equal(team.lead.name, 'architect');
  assert.deepEqual(team.contracts.map(c => [c.name, c.domain, c.as, c.by]), [['endpoint', 'api', 'endpoint-spec', ['api-dev']], ['repository', 'persistence', 'endpoint-spec', ['db-dev']]]);
  assert.deepEqual(team.members.map(m => m.name), ['architect', 'api-dev', 'db-dev'], 'the roster is the lead and whoever a BY names');
  assert.ok(team.unit.split('\n').every(l => !/CONTRACT|STRATEGY|LEAD|DOMAINS|DOMAIN/.test(l)), 'the unit sheds the strategy lines and the contracts');
  assert.deepEqual(lintFile(team.path, team.source), [], 'a team of contracts lints clean');
  assert.deepEqual(index().teams, [{ name: 'backend', strategy: 'contracts', lead: 'architect' }]);
  assert.deepEqual(index().contracts.map(c => [c.name, c.team, c.by]), [['endpoint', 'backend', ['api-dev']], ['repository', 'backend', ['db-dev']], ['change', null, ['backend']]]);

  // --- the lead's document: the team, its contracts, the one handed to it, its own trigger ---
  const { structure: doc, body } = await compile('architect');
  const tb = doc.byKind('team')[0];
  assert.equal(tb.strategy, 'contracts');
  assert.equal(last(tb.lead.target), 'architect');
  assert.deepEqual(tb.contracts.map(r => r.target), ['@main.contracts.backend/endpoint', '@main.contracts.backend/repository']);
  assert.deepEqual(tb.members.map(r => last(r.target)), ['architect', 'api-dev', 'db-dev']);
  const contracts = doc.byKind('contract');
  assert.deepEqual(contracts.map(c => [c.name, c.domain, last(c.shape.ref.target), c.by.map(r => last(r.target)), c.byTeam ? last(c.byTeam.target) : null]), [
    ['endpoint', 'api', 'endpoint-spec', ['api-dev'], null],
    ['repository', 'persistence', 'endpoint-spec', ['db-dev'], null],
    ['change', null, 'change-request', ['architect'], 'backend'],
  ]);
  assert.equal(contracts[2].source.file, project, 'the project contract is where it is written');
  assert.equal(contracts[2].namespace, '@main.contracts');
  const whens = doc.nodes().filter(n => n.node.type === 'when' && n.block === doc.root()).map(n => n.node);
  assert.equal(whens[0].input?.target, '@main.contracts/change', "the lead's trigger takes the project contract");
  assert.ok(body.includes('Its input is an instance of the contract `change`'), body);
  assert.ok(body.includes('# Contracts') || /Contracts/.test(body), 'the contracts chapter is in the definition');
  assert.ok(body.includes('Domain: `api`') && body.includes('Carried out by: `api-dev`'), body);
  assert.ok(body.includes('Handed to the team `backend`'), body);

  // --- a member's document: its trigger takes the contract; the JSON round trip keeps it ---
  const api = await compile('api-dev');
  const when = api.structure.nodes().find(n => n.node.type === 'when' && n.block === api.structure.root()).node;
  assert.equal(when.input?.target, '@main.contracts.backend/endpoint');
  const revived = ApDocument.fromJson(api.structure.asJson());
  assert.equal(revived.nodes().find(n => n.node.type === 'when' && n.block === revived.root()).node.input?.target, '@main.contracts.backend/endpoint', 'the input survives the JSON round trip');
  assert.ok(api.body.includes('Its input is an instance of the contract `endpoint`'), api.body);

  // --- the strategy's flow: in every member's document, its routing, its harness script ---
  {
    const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');
    const flow = api.structure.byKind('flow').find(f => f.name === 'backend-contracts');
    assert.ok(flow, "the strategy's flow travels in the member's document");
    assert.deepEqual(flow.body.map(n => n.type), ['step', 'parallel', 'step']);
    assert.deepEqual([last(flow.body[0].by.target), flow.body[1].steps.map(s => last(s.by.target)), last(flow.body[2].by.target)],
      ['architect', ['api-dev', 'db-dev'], 'architect'], 'the lead prepares, the workers in parallel, the lead merges');
    assert.equal(flow.source, null, 'the flow is the strategy\'s: no line of the file');
    const tb2 = api.structure.byKind('team')[0];
    assert.deepEqual(tb2.routing.map(r => [r.when, last(r.run.target)]), [['handed a contract of this team', 'backend-contracts']]);
    assert.ok(compileWorkflow(flow, api.structure) !== null, 'the harness runs it as a script');
  }

  // --- PROJECT.ap compiles: the contract is checked and never rendered ---
  const rendered = await bundleStandaloneToString(project, config);
  assert.ok(!/CONTRACT change|any change the user asks for|BY\s+backend/.test(rendered), rendered);

  // --- the orchestration reads the team: no routing, no stray lines ---
  const { content } = await orchestration();
  assert.ok(content.includes('## Team — backend'), content);
  assert.ok(!/CONTRACT|STRATEGY|DOMAINS/.test(content), 'the strategy lines are not prose');
  assert.ok(content.includes('`strategy`: contracts — the lead `architect` prepares the work'), content);
  assert.ok(content.includes('- `endpoint` — one HTTP endpoint — domain `api` — carried out by `api-dev`'), content);
  assert.ok(content.includes('When handed a contract of this team:'), content);
  assert.ok(/Run the flow `backend-contracts` \(flw-[0-9a-f]{8}\) — start with `node \.agent-pack\/apx\/architect\.apx flow/.test(content), 'the flow starts from the lead');
  assert.ok(content.includes('## `backend-contracts`') && content.includes('In parallel'), content);

  // --- the two shapes of a team ---
  TEAM(undefined, ['    LEAD      architect']);
  await assert.rejects(compile('architect'), /backend\.ap:5  LEAD is a line of a team with a STRATEGY — write `STRATEGY contracts` first/);
  await assert.rejects(compile('architect'), /backend\.ap:6  CONTRACT endpoint: a contract belongs to a team with `STRATEGY contracts`/);
  TEAM(undefined, ['    STRATEGY  contracts', '    MEMBER    architect, api-dev', '    LEAD      architect']);
  await assert.rejects(compile('architect'), /backend\.ap:6  MEMBER is not written under STRATEGY contracts — the members are the LEAD and the agents the CONTRACT blocks name in BY/);
  TEAM(undefined, ['    STRATEGY  contracts']);
  await assert.rejects(compile('architect'), /backend\.ap:3  TEAM backend: STRATEGY contracts needs a LEAD/);
  TEAM(undefined, ['    STRATEGY  contracts', '    LEAD      architect', '    DOMAINS   domains']);
  await assert.rejects(compile('architect'), /backend\.ap:7  DOMAINS was removed — the files of a domain are its `EXPORT DOMAIN <name>:` block's FOR/);
  TEAM([]);
  await assert.rejects(compile('architect'), /backend\.ap:3  TEAM backend: STRATEGY contracts needs at least one CONTRACT block/);
  TEAM(undefined, ['    STRATEGY  teamwork', '    LEAD      architect']);
  await assert.rejects(compile('architect'), /STRATEGY: unknown value `teamwork`/);
  TEAM(undefined, ['    STRATEGY  contracts', '    LEAD      architect', '    WHEN asked:', '        RUN ship']);
  await assert.rejects(compile('architect'), /backend\.ap:7  WHEN is not written under STRATEGY contracts — the strategy says how the team runs/);

  // --- the contract block ---
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS!     endpoint-spec', '        BY      api-dev', '        MUST    be quick']);
  await assert.rejects(compile('architect'), /backend\.ap:10  CONTRACT endpoint: AS takes no level/);
  await assert.rejects(compile('architect'), /backend\.ap:12  MUST is not allowed inside CONTRACT/);
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        BY      api-dev']);
  await assert.rejects(compile('architect'), /backend\.ap:7  CONTRACT block requires at least one AS/);
  assert.ok(lintFile(join(tmp, 'x.ap'), 'EXPORT AGENT x AS r:\n    ABOUT  x\n    MANDATE  y\n    CONTRACT c:\n        ABOUT  z\n').some(e => /a CONTRACT is declared in a TEAM block, or at the top of the project file — found inside AGENT/.test(e.message)));

  // --- DOMAIN: one its BY agent writes ---
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      api-dev']);
  rmSync(join(backend, 'db-dev.ap'));
  await assert.rejects(compile('api-dev'), /backend\.ap:9  CONTRACT endpoint: DOMAIN `persistence` — `api-dev`, its BY, does not write it: give it `WRITES persistence`/);
  member('db-dev', 'repository');

  // --- BY: the folder's agents, or one team of contracts ---
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      api-dev, ghost',
    '    CONTRACT repository:', '        ABOUT   a table', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      db-dev']);
  await assert.rejects(compile('architect'), /backend\.ap:11  BY ghost: no agent file in `backend\/` declares `EXPORT AGENT ghost`, and no team runs by contracts under that name/);
  const front = join(teams, 'front');
  mkdirSync(front);
  write(join(front, 'ui-lead.ap'), ['IMPORT api FROM @main.domains', '', 'EXPORT AGENT ui-lead AS ui-role:', '    ABOUT    leads the front', '    MANDATE  deliver', '    WRITES   api', '    WHEN handed screens:', '        DO  hand out', '    WHEN handed widget:', '        DO  build it', '', 'ROLE ui-role:', '    ABOUT   a lead', '    ALWAYS  lead']);
  write(join(front, 'front.ap'), ['IMPORT endpoint-spec FROM @main.templates', '', 'EXPORT TEAM front:', '    ABOUT     the front team', '    STRATEGY  contracts', '    LEAD      ui-lead',
    '    CONTRACT widget:', '        ABOUT   a widget', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      ui-lead']);
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      api-dev',
    '    CONTRACT repository:', '        ABOUT   a table', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      db-dev',
    '    CONTRACT screens:', '        ABOUT   the screens of a feature', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      front']);
  const withFront = await compile('architect');
  const screens = withFront.structure.byKind('contract').find(c => c.name === 'screens');
  assert.deepEqual([screens.by.map(r => last(r.target)), last(screens.byTeam.target)], [['ui-lead'], 'front'], 'a contract handed to a team is carried out by its lead');
  const uiLead = await compile('ui-lead', front);
  assert.ok(uiLead.structure.byKind('contract').some(c => c.name === 'screens' && c.namespace === '@main.contracts.backend'), "the other team's contract reaches the lead it is handed to");
  assert.equal(uiLead.structure.nodes().find(n => n.node.type === 'when' && n.block === uiLead.structure.root()).node.input?.target, '@main.contracts.backend/screens');
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      api-dev, front',
    '    CONTRACT repository:', '        ABOUT   a table', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      db-dev']);
  await assert.rejects(compile('architect'), /backend\.ap:11  BY api-dev, front: a contract is carried out by agents of the team, or handed to one team — not both/);
  TEAM(['    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      backend',
    '    CONTRACT repository:', '        ABOUT   a table', '        DOMAIN  persistence', '        AS      endpoint-spec', '        BY      db-dev']);
  await assert.rejects(compile('architect'), /backend\.ap:11  BY backend: a contract is not handed to its own team/);
  rmSync(front, { recursive: true });
  TEAM();

  // --- a member: its WHEN handed, no LENS-IN; an agent no contract names ---
  agent(backend, 'api-dev', ['    WHEN asked:', '        DO  work']);
  await assert.rejects(compile('api-dev'), /backend\.ap:11  BY api-dev: `api-dev` declares no `WHEN handed endpoint:` — the trigger a member starts a contract from/);
  member('api-dev', 'endpoint', ['    LENS-IN  endpoint-spec']);
  await assert.rejects(compile('api-dev'), /api-dev\.ap:7  LENS-IN is not written in a team of contracts/);
  member('api-dev', 'endpoint');
  agent(backend, 'idle', ['    WHEN asked:', '        DO  wait']);
  await assert.rejects(compile('architect'), /backend\.ap:3  TEAM backend: the agent `idle` \(idle\.ap\) is in the folder but no CONTRACT names it in its BY, nor is it the LEAD/);
  rmSync(join(backend, 'idle.ap'));
  agent(backend, 'architect', ['    WHEN asked:', '        DO  plan']); rmSync(join(backend, 'architect.ap')); lead();
  write(join(backend, 'backend.ap'), ['IMPORT endpoint-spec FROM @main.templates', '', 'EXPORT TEAM backend:', '    ABOUT     a team', '    STRATEGY  contracts', '    LEAD      nobody',
    '    CONTRACT endpoint:', '        ABOUT   one endpoint', '        DOMAIN  api', '        AS      endpoint-spec', '        BY      api-dev, db-dev']);
  await assert.rejects(compile('api-dev'), /backend\.ap:6  LEAD nobody: no agent file in `backend\/` declares `EXPORT AGENT nobody`/);
  TEAM();

  // --- a team no contract hands work to; the project contract ---
  rmSync(project);
  await assert.rejects(compile('architect'), /backend\.ap:3  TEAM backend: no CONTRACT hands work to this team — write one with `BY backend` in PROJECT\.ap/);
  await assert.rejects(orchestration(), /no CONTRACT hands work to this team/);
  PROJECT('api-dev');
  await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:8  BY api-dev: no team runs by contracts under that name/);
  PROJECT('backend', ['    DOMAIN  api']);
  await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:7  CONTRACT change: DOMAIN is a team contract's/);
  PROJECT('backend, front');
  await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:8  CONTRACT change: BY names the one team that takes the request — found 2/);
  write(project, ['ABOUT  the project', '', 'CONTRACT change:', '    ABOUT   any change', '    AS      nowhere', '    BY      backend']);
  await assert.rejects(bundleStandaloneToString(project, config), /PROJECT\.ap:5  CONTRACT change: AS `nowhere` names no template of this file/);
  PROJECT();
  assert.ok(existsSync(project));

  console.log('contracts (language) tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
