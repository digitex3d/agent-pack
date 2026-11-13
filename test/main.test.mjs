// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The main (src/services/mainMetadata.ts): the `.ap` file at the project root
 * holding a `MAIN:` block, compiled into the project block of AGENTS.md in
 * place of PROJECT.ap, its block checked (mainBlockErrors), and its TEAMS and
 * MEMBER lines deciding what the orchestration holds (mainRosterIssues).
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { teamSource } from './helpers/team.mjs';

const { emitProjectContext, ensureProjectPointers } = await import('../dist/src/projectContext.js');
const { readMainFile } = await import('../dist/src/services/mainMetadata.js');
const { mainBlockErrors } = await import('../dist/src/lint.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { loadConfig } = await import('../dist/src/config.js');
const { default: claudeCodeAdapter } = await import('../dist/adapters/claude-code/index.js');

const write = (path, lines) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${lines.join('\n')}\n`); return path; };
const agent = (name, about) => [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${about}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  test first'];
const mainOf = body => ['# orfeo', '', 'MAIN:', ...body.map(l => (l ? `    ${l}` : ''))];

const tmp = mkdtempSync(join(tmpdir(), 'agent-pack-main-'));
const prevCwd = process.cwd();
try {
  mkdirSync(join(tmp, 'library'), { recursive: true });
  process.chdir(tmp);
  let config = await loadConfig([]);

  // --- no main → nothing written ---
  assert.equal(readMainFile(tmp), null);
  assert.equal(await emitProjectContext(tmp, config), null, 'no main → no-op');
  assert.equal(existsSync(join(tmp, 'AGENTS.md')), false);

  // --- a PROJECT.ap still there fails, with the rewrite ---
  write(join(tmp, 'PROJECT.ap'), ['ABOUT  rules']);
  await assert.rejects(emitProjectContext(tmp, config), /PROJECT\.ap is gone — the project's root is its main: rename the file after the executable .* `MAIN:` block/);
  rmSync(join(tmp, 'PROJECT.ap'));

  // --- the main: its name is its file's, its ABOUT and head lines out of the text, its routing in ---
  const main = write(join(tmp, 'orfeo.ap'), [
    'IMPORT security FROM @main.policies', '',
    'PROCEDURE reasoning:', '    ABOUT  reason it out', '    DO     ask one question', '',
    ...mainOf(['ABOUT    the company', 'VERSION  0.1.0', 'TEAMS    crew', 'MEMBER   solo', '', 'WHEN a decision is due:', '    RUN reasoning']),
  ]);
  write(join(tmp, 'library', 'policies', 'security.ap'), ['EXPORT POLICY security:', '    ABOUT    baseline rules', '    APPLIES  universal', '    ALWAYS   validate every input']);
  const read = readMainFile(tmp);
  assert.equal(read.name, 'orfeo', 'the file names the executable');
  assert.equal(read.about, 'the company');
  assert.equal(read.version, '0.1.0');
  assert.deepEqual(read.teams.map(t => t.name), ['crew']);
  assert.deepEqual(read.members.map(m => m.name), ['solo']);
  assert.equal(read.unit.split('\n').length, readFileSync(main, 'utf-8').split('\n').length, 'the unit keeps every line number');
  config = await loadConfig([]);
  write(join(tmp, 'library', 'policies', 'careful.ap'), ['EXPORT POLICY careful:', '    ABOUT    only where named', '    APPLIES  team:crew', '    ALWAYS   think twice']);
  writeFileSync(main, readFileSync(main, 'utf-8').replace('IMPORT security FROM @main.policies', 'IMPORT security, careful FROM @main.policies'));
  const project = await emitProjectContext(tmp, config);
  assert.equal(project.file, 'orfeo.ap');
  // AGENTS.md holds only what boots the main, and its universal policies
  const out = readFileSync(join(tmp, 'AGENTS.md'), 'utf-8');
  assert.ok(out.includes('<!-- agent-pack:project:start -->'), 'in the project block');
  assert.ok(out.includes('# orfeo — the company'), out);
  assert.ok(out.includes('node .agent-pack/apx/orfeo.apx start'), 'the command that prints the main');
  assert.ok(out.includes('If what it printed is no longer in your context, run it again.'), out);
  assert.ok(out.includes('validate every input') && out.includes('Applies everywhere.'), 'a universal policy stays in AGENTS.md');
  assert.ok(!out.includes('think twice'), 'a policy that holds only where named is the main\'s');
  assert.ok(!out.includes('When a decision is due:'), 'the routing is the main\'s');
  // the main's text holds the rest
  const text = project.content;
  assert.ok(text.includes('When a decision is due:'), text);
  assert.ok(/Run the procedure `reasoning`/.test(text), text);
  assert.ok(text.includes('validate every input') && text.includes('think twice'), 'every policy');
  for (const gone of ['ABOUT', 'VERSION', 'TEAMS', 'MEMBER', 'MAIN']) assert.ok(!new RegExp(`^\\s*${gone}\\b`, 'm').test(text), `${gone} is not in the text`);
  assert.deepEqual(ensureProjectPointers(tmp, [claudeCodeAdapter()]), ['CLAUDE.md']);

  // --- the block's own checks ---
  const blockOf = lines => { const p = write(join(tmp, 'check', 'x.ap'), lines); return [p, readMainFile(join(tmp, 'check')).block]; };
  const errorsOf = lines => { const [p, b] = blockOf(lines); return mainBlockErrors(p, b).map(e => e.message); };
  assert.deepEqual(errorsOf(mainOf(['ABOUT  a', 'MEMBER solo'])), []);
  assert.ok(errorsOf(['MAIN orfeo:', '    ABOUT  a', '    MEMBER solo']).some(m => /MAIN takes no name — its name is its file's, `x`/.test(m)));
  assert.ok(errorsOf(['EXPORT MAIN:', '    ABOUT  a', '    MEMBER solo']).some(m => /MAIN is exported by no one/.test(m)));
  assert.ok(errorsOf(mainOf(['ABOUT  a', 'VERSION one', 'MEMBER solo'])).some(m => /VERSION is a semver .* `one`/.test(m)));
  assert.ok(errorsOf(mainOf(['ABOUT  a'])).some(m => /at least one TEAMS or MEMBER line/.test(m)));
  assert.ok(errorsOf(mainOf(['MEMBER solo'])).some(m => /ABOUT/.test(m)), 'ABOUT is required');
  assert.deepEqual(errorsOf(mainOf(['ABOUT  a', 'MEMBER solo', 'FLOW f:', '    STEP s:', '        DELEGATE x BY solo'])), [], 'a main holds its flows, as a team does');
  rmSync(join(tmp, 'check'), { recursive: true });

  // --- two mains fail ---
  write(join(tmp, 'other.ap'), mainOf(['ABOUT  b', 'MEMBER solo']));
  assert.throws(() => readMainFile(tmp), /a project has one main — orfeo\.ap and other\.ap each hold a MAIN block/);
  rmSync(join(tmp, 'other.ap'));

  // --- what the main lists is what the orchestration holds ---
  const agents = join(tmp, 'agents');
  write(join(agents, 'standalone', 'solo.ap'), agent('solo', 'works alone'));
  write(join(agents, 'standalone', 'loner.ap'), agent('loner', 'left out'));
  write(join(agents, 'teams', 'crew', 'builder.ap'), agent('builder', 'builds'));
  write(join(agents, 'teams', 'crew', 'crew.ap'), teamSource('crew', ['builder'], ['ABOUT  a crew', '', 'WHEN asked to ship:', '    DO  ship it']));
  write(join(agents, 'teams', 'idle', 'sleeper.ap'), agent('sleeper', 'sleeps'));
  write(join(agents, 'teams', 'idle', 'idle.ap'), teamSource('idle', ['sleeper'], ['ABOUT  an idle team', '', 'WHEN asked to rest:', '    RUN nap', '', 'FLOW nap:', '    STEP sleep:', '        DELEGATE sleep a while BY sleeper']));
  const orchestration = () => buildOrchestrationContent({ cwd: tmp, standaloneAgentsDir: join(agents, 'standalone'), teamsDir: join(agents, 'teams'), libraryRoots: [join(tmp, 'library')], libraries: { '@main': join(tmp, 'library') } });
  const built = await orchestration();
  assert.deepEqual(built.teams, ['crew'], 'only the teams TEAMS lists');
  assert.deepEqual(built.standalones, ['solo'], 'only the agents MEMBER lists');
  assert.ok(!built.content.includes('loner') && !built.content.includes('idle'), built.content);
  assert.ok(!built.content.includes('`nap`'), 'a team the main leaves out brings no flow into it');

  // --- a team on its own: its flows and its routing, nothing of the other teams ---
  const idle = await buildOrchestrationContent({ cwd: tmp, standaloneAgentsDir: join(agents, 'standalone'), teamsDir: join(agents, 'teams'), libraryRoots: [join(tmp, 'library')], libraries: { '@main': join(tmp, 'library') }, team: 'idle' });
  assert.deepEqual(idle.teams, ['idle'], 'listed in the main or not, a team compiles alone');
  assert.deepEqual(idle.standalones, []);
  assert.ok(idle.content.includes('## `nap`') && idle.content.includes('## Team — idle'), idle.content);
  assert.ok(!idle.content.includes('crew') && !idle.content.includes('# Orchestration'), 'nothing of the other teams, no routing between them');

  const rosterFails = async (body, pattern) => {
    write(main, mainOf(body));
    await assert.rejects(orchestration(), pattern);
  };
  await rosterFails(['ABOUT  a', 'MEMBER crew'], /`crew` is a team — list it under TEAMS: `TEAMS crew`/);
  await rosterFails(['ABOUT  a', 'TEAMS solo'], /`solo` is a standalone agent — list it under MEMBER: `MEMBER solo`/);
  await rosterFails(['ABOUT  a', 'MEMBER builder'], /`builder` is a member of the team `crew` — it is reached through its team's routing/);
  await rosterFails(['ABOUT  a', 'TEAMS ghost'], /TEAMS names `ghost`, which is neither a team nor a standalone agent/);

  // --- with no main, the orchestration holds every team and agent, as before ---
  rmSync(main);
  const all = await orchestration();
  assert.deepEqual(all.teams.sort(), ['crew', 'idle']);
  assert.deepEqual(all.standalones.sort(), ['loner', 'solo']);

  // --- the main's apx: the engine once, the main's section, an image per agent; `<main> <agent> <verb>` ---
  const repoApx = join(prevCwd, '.agent-pack', 'apx');
  if (existsSync(join(repoApx, 'designer.apx')) && existsSync(join(repoApx, 'explorer.apx')) && existsSync(join(prevCwd, '.agent-pack', 'compiled', 'delivery.ap.json'))) {
    const { unitApxFiles } = await import('../dist/src/apx/write.js');
    const { spawnSync } = await import('node:child_process');
    const project = join(tmp, 'apxproj');
    mkdirSync(join(project, '.agent-pack', 'apx'), { recursive: true });
    for (const a of ['designer', 'explorer']) writeFileSync(join(project, '.agent-pack', 'apx', `${a}.apx`), readFileSync(join(repoApx, `${a}.apx`)));
    writeFileSync(join(project, '.agent-pack', 'apx', 'package.json'), '{ "type": "commonjs" }\n');
    const section = { kind: 'main', name: 'orfeo', about: 'the company', version: '0.1.0', teams: [{ name: 'delivery', about: 'delivers', members: ['explorer'] }], members: [{ name: 'designer', about: 'designs' }], text: '# Policies\n\nthe rules' };
    // a team's apx is a unit too: its members inside, its own text — built first, the main holds it
    const team = { kind: 'team', name: 'delivery', about: 'delivers', version: '', teams: [{ name: 'delivery', about: 'delivers', members: ['explorer'] }], members: [], text: '# Flows\n\nthe flows' };
    const { unitPayload } = await import('../dist/src/apx/write.js');
    const teamDocument = readFileSync(join(prevCwd, '.agent-pack', 'compiled', 'delivery.ap.json'), 'utf-8');
    const [teamFile] = unitApxFiles(team, project, unitPayload(teamDocument));
    writeFileSync(teamFile.path, teamFile.content);
    const [file] = unitApxFiles(section, project);
    assert.equal(file.path, join(project, '.agent-pack', 'apx', 'orfeo.apx'), 'named after the main');
    writeFileSync(file.path, file.content);
    const run = (...args) => spawnSync(process.execPath, ['.agent-pack/apx/orfeo.apx', ...args], { cwd: project, encoding: 'utf-8' });
    const own = (agent, ...args) => spawnSync(process.execPath, [`.agent-pack/apx/${agent}.apx`, ...args], { cwd: project, encoding: 'utf-8' });
    const start = run('start');
    assert.equal(start.status, 0, start.stdout + start.stderr);
    assert.ok(start.stdout.startsWith('# Policies\n\nthe rules'), 'start prints the main');
    assert.ok(run().stdout === start.stdout, 'no verb is start');
    assert.ok(/team delivery — delivers\n {2}explorer\nagents\n {2}designer — designs/.test(run('ls').stdout), run('ls').stdout);
    assert.ok(/^orfeo 0\.1\.0 — built /.test(run('version').stdout));
    for (const agent of ['designer', 'explorer']) {
      const through = run(agent, 'ls');
      assert.equal(through.status, 0, through.stdout + through.stderr);
      const mine = `node .agent-pack/apx/orfeo.apx ${agent}`;
      assert.ok(run(agent, 'start').stdout.includes(mine), `${agent}'s commands go through the main`);
      assert.equal(through.stdout.replaceAll(mine, 'CMD'), own(agent, 'ls').stdout.replaceAll(`node .agent-pack/apx/${agent}.apx`, 'CMD'), `${agent} answers as its own apx`);
    }
    // the commands the compiler wrote for an agent's own apx go through the main that serves it
    const { throughUnit } = await import('../dist/src/apx/unit.js');
    const through = throughUnit(section, 'M');
    assert.equal(through('run `node .agent-pack/apx/explorer.apx flow flw-1` then `node .agent-pack/apx/designer.apx get x`'), 'run `M explorer flow flw-1` then `M designer get x`');
    assert.equal(through('`node .agent-pack/apx/other.apx scope`'), '`node .agent-pack/apx/other.apx scope`', 'an agent the main does not hold keeps its own apx');
    // the main's executable answers as its apx does, its commands named after it
    const { bunInstalled, buildExecutable } = await import('../dist/src/commands/executable.js');
    if (bunInstalled()) {
      const bin = buildExecutable('orfeo', project);
      assert.ok(bin.endsWith(join('.agent-pack', 'bin', 'orfeo')));
      const fromBin = spawnSync(bin, ['designer', 'start'], { cwd: project, encoding: 'utf-8' });
      assert.equal(fromBin.status, 0, fromBin.stdout + fromBin.stderr);
      assert.equal(fromBin.stdout.replaceAll('.agent-pack/bin/orfeo', 'M'), run('designer', 'start').stdout.replaceAll('node .agent-pack/apx/orfeo.apx', 'M'), 'the executable is the main');
      assert.equal(spawnSync(bin, ['ls'], { cwd: project, encoding: 'utf-8' }).stdout.replaceAll('.agent-pack/bin/orfeo', 'M'), run('ls').stdout.replaceAll('node .agent-pack/apx/orfeo.apx', 'M'));
      console.log('main: executable tested.');
    }
    const none = run('nobody', 'ls');
    assert.equal(none.status, 2);
    assert.ok(none.stdout.includes("no agent 'nobody' in this main"), none.stdout);
    // the team answers `<team> <member> <verb>`
    const runTeam = (...args) => spawnSync(process.execPath, ['.agent-pack/apx/delivery.apx', ...args], { cwd: project, encoding: 'utf-8' });
    assert.ok(runTeam('start').stdout.startsWith('# Flows\n\nthe flows'));
    assert.ok(runTeam('start').stdout.includes('every agent of the team answers through it'));
    assert.ok(runTeam('help').stdout.includes('the team: its routing and its flows'), runTeam('help').stdout);
    assert.equal(runTeam('explorer', 'ls').stdout.replaceAll('node .agent-pack/apx/delivery.apx explorer', 'CMD'), own('explorer', 'ls').stdout.replaceAll('node .agent-pack/apx/explorer.apx', 'CMD'));
    // its own document serves its flows: the same id as a member served before, every agent reached through the team
    const flows = runTeam('ls', 'kind=flow').stdout;
    assert.ok(flows.includes('flw-a46c9499') && flows.includes('flw-43a7bdeb'), flows);
    const got = runTeam('get', 'flw-a46c9499');
    assert.equal(got.status, 0, got.stdout + got.stderr);
    assert.ok(got.stdout.includes('[node .agent-pack/apx/delivery.apx explorer scope]'), got.stdout);
    assert.ok(run('delivery', 'get', 'flw-a46c9499').stdout.includes('[node .agent-pack/apx/orfeo.apx explorer scope]'), 'through the main, the main reaches the agent');
    assert.ok(runTeam('designer', 'ls').stdout.includes("unknown verb 'designer'"), 'a team holds its members only: any other word is its own document\'s');
    rmSync(join(project, '.agent-pack', 'apx', 'designer.apx'));
    assert.throws(() => unitApxFiles(section, project), /the main orfeo holds designer, which has no apx/);
  } else {
    console.log('main: no apx of designer and explorer in this checkout — the main apx was not run.');
  }

  // --- the main's flows: its own document, by the one compiler, served by its apx ---
  {
    const proj = join(tmp, 'flows');
    const A = join(proj, 'agents');
    write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code-apx'],", '};']);
    mkdirSync(join(proj, 'library'), { recursive: true });
    write(join(A, 'standalone', 'designer.ap'), agent('designer', 'designs pages'));
    write(join(A, 'teams', 'crew', 'builder.ap'), agent('builder', 'builds'));
    write(join(A, 'teams', 'crew', 'crew.ap'), teamSource('crew', ['builder'], ['ABOUT  a crew', '', 'WHEN asked to build:', '    RUN build', '', 'FLOW build:', '    STEP build it:', '        DELEGATE build it BY builder']));
    write(join(proj, 'orfeo.ap'), ['# orfeo', '', ...mainOf(['ABOUT    the company', 'TEAMS    crew', 'MEMBER   designer', '',
      'WHEN asked to ship a feature:', '    RUN ship', '', 'FLOW ship:', '    STEP build it:', '        DELEGATE build the feature BY crew', '    STEP design it:', '        DELEGATE design its page BY designer'])]);
    const before = process.cwd();
    process.chdir(proj);
    try {
      const { bundleAllOnce } = await import('../dist/src/commands/bundle.js');
      const cfg = await loadConfig([]);
      cfg.judge = null;
      assert.ok(await bundleAllOnce(cfg, cfg.adapters, { projectRoot: proj, outputDir: cfg.outputDir }), 'bundle all is clean');
      const { spawnSync } = await import('node:child_process');
      const orfeo = (...args) => spawnSync(process.execPath, ['.agent-pack/apx/orfeo.apx', ...args], { cwd: proj, encoding: 'utf-8' });
      const flows = orfeo('ls', 'kind=flow').stdout;
      const id = /flw-[0-9a-f]{8}/.exec(flows)?.[0];
      assert.ok(id && flows.includes('ship'), `the main's flow is a block of its own document:\n${flows}`);
      const got = orfeo('get', id);
      assert.equal(got.status, 0, got.stdout + got.stderr);
      assert.ok(got.stdout.includes('[node .agent-pack/apx/orfeo.apx designer scope]'), `its agent, reached through the main:\n${got.stdout}`);
      assert.equal(orfeo('flow', id).status, 0, 'the main runs its own flow');
      const root = orfeo('get', /mai-[0-9a-f]{8}/.exec(orfeo('ls', 'kind=main').stdout)?.[0] ?? '').stdout;
      // The main's root reads as an agent's identity does: who it is, what it holds — each with the command that starts it — and its routing.
      assert.ok(root.includes('- `designer` — designs pages [node .agent-pack/apx/orfeo.apx designer start]') && root.includes('- `crew` — a crew [node .agent-pack/apx/orfeo.apx crew start]') && root.includes('When asked to ship a feature:\n    Run the flow `ship`'), root);
      assert.ok(orfeo('start').stdout.includes(`Run the flow \`ship\` (${id})`), 'its start is its whole definition, as an agent\'s is: the routing names the flow by its id');
      assert.ok(orfeo('crew', 'ls', 'kind=flow').stdout.includes('build'), "a team's flows stay the team's, reached through the main");
      for (const a of ['designer', 'builder']) assert.ok(!spawnSync(process.execPath, [`.agent-pack/apx/${a}.apx`, 'ls', 'kind=flow'], { cwd: proj, encoding: 'utf-8' }).stdout.includes('flw-'), `${a} holds no flow`);
      // one id, one block, one definition: the pack is a store of blocks, a document its view
      const { Pack } = await import('../dist/src/apx/pack.js');
      const { storeSections, packPayload, viewHolding } = await import('../dist/src/apx/payload.js');
      const pack = Pack.fromFile(join(proj, '.agent-pack', 'apx', 'orfeo.apx'));
      try {
        assert.deepEqual(pack.entries('view').map(e => e.name).sort(), ['', 'builder', 'crew', 'designer'], 'a view for the main itself and for everything it holds');
        const blockIds = pack.entries('block').map(e => e.name);
        assert.equal(new Set(blockIds).size, blockIds.length, 'every block once');
        const roleOf = name => JSON.parse(packPayload(pack, name).document).blocks;
        const shared = Object.values(roleOf('builder')).map(b => b.id).filter(i => Object.values(roleOf('designer')).some(b => b.id === i));
        for (const sharedId of shared) assert.equal(blockIds.filter(i => i === sharedId).length, 1, `${sharedId}, held by two agents, is stored once`);
        const buildFlow = /flw-[0-9a-f]{8}/.exec(orfeo('crew', 'ls', 'kind=flow').stdout)[0];
        assert.equal(viewHolding(pack, buildFlow), 'crew', "a block is found in whichever document holds it");
        assert.equal(viewHolding(pack, id), '', "the unit's own document first");
        assert.equal(viewHolding(pack, 'pol-00000000'), null);
        // asked of the main by its id alone, a block of one of its documents is served from there
        const byId = orfeo('get', buildFlow);
        assert.equal(byId.status, 0, byId.stdout + byId.stderr);
        assert.ok(byId.stdout.includes('build it'), byId.stdout);
        assert.equal(orfeo('get', 'pol-00000000').status, 1, 'an id no document holds is no block');
        // two documents holding different blocks under one id fail the build
        const one = packPayload(pack, 'designer');
        const other = { build: one.build, document: JSON.stringify({ ...JSON.parse(one.document), blocks: Object.fromEntries(Object.entries(JSON.parse(one.document).blocks).map(([a, blk]) => [a, { ...blk, about: 'another' }])) }) };
        assert.throws(() => storeSections([{ name: 'designer', payload: one }, { name: 'copy', payload: other }], false), /one id, one definition: \S+ is one block in designer and another in copy/);
        assert.equal(storeSections([{ name: 'a', payload: one }, { name: 'b', payload: one }], false).filter(x => x.type === 'block').length, Object.keys(JSON.parse(one.document).blocks).length, 'the same document twice stores its blocks once');
      } finally {
        pack.close();
      }
    } finally {
      process.chdir(before);
    }
  }
  console.log('main tests passed.');
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}
