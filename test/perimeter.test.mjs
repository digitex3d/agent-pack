// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Domains (D44) and an agent's perimeter: `EXPORT DOMAIN <name>:` declares a
 * region of the code — `WRITES IN <glob>, …` the files work within it may
 * write, `READS IN <glob>, …` the ones it may only read — and `@WITHIN <domain>`
 * above an AGENT puts its work within it. The compiled definition opens with
 * the scope warning — their globs — and lists the domains in their chapter.
 * A formula is decided by the judge of the lines, file by file — an error
 * without one; a domain names files that are there; WRITES and READS in an
 * agent, and OWNS, fail with the rewrite.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { lintFile } = await import('../dist/src/lint.js');
const { keywordCatalog } = await import('../dist/src/keywordCatalog.js');
const { JudgeRun, finishJudgeRun } = await import('../dist/src/judge/phase.js');
const { JudgeLock } = await import('../dist/src/judge/lock.js');
const { UnitStore } = await import('../dist/src/judge/units.js');

const root = mkdtempSync(join(tmpdir(), 'ap-perimeter-'));
const lib = join(root, 'library');
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
for (const f of ['src/api/routes.ts', 'src/shared/http.ts', 'src/db/schema.ts', 'docs/index.md']) write(join(root, f), ['x']);
const domain = (name, lines) => write(join(lib, 'domains', `${name}.ap`), [`EXPORT DOMAIN ${name}:`, ...lines.map(l => `    ${l}`)]);
domain('api', ['ABOUT   the HTTP layer', 'APPLIES #backend', 'WRITES  IN src/api/**, src/shared/http.ts', 'READS   IN src/db/**']);
domain('db', ['ABOUT   schema and queries', 'APPLIES #backend', 'WRITES  IN src/db/**']);
domain('ghost', ['ABOUT   nothing there', 'WRITES  IN nowhere/**']);

const compile = (above, lines = [], top = ['IMPORT api, db FROM @main.domains', ''], judge) => {
  const file = write(join(root, 'a.ap'), [
    ...top, ...above,
    'EXPORT AGENT a AS a-role:', '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '',
    'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work',
  ]);
  return bundleAgentObject({ agentName: 'a', agentFile: file, agentDir: root, projectRoot: root, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false }, ...(judge ? { judge } : {}) });
};
const has = (text, ...needles) => { for (const n of needles) assert.ok(text.includes(n), `missing ${JSON.stringify(n)} in:\n${text}`); };

try {
  // --- the words: DOMAIN opens a block, WRITES and READS are its lines ---
  const catalog = keywordCatalog();
  assert.equal(catalog.DOMAIN, 'block');
  assert.notEqual(catalog.WRITES, 'meta', 'WRITES is no agent field any more');

  // --- @WITHIN above the agent: the scope warning lists the domain's globs, the chapter its files ---
  {
    const out = await compile(['@WITHIN api'], ['    WHEN asked:', '        DO  it']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['src/api/**', 'src/shared/http.ts'], reads: ['src/db/**'] });
    has(out.body,
      '> This agent may write only: `src/api/**`, `src/shared/http.ts`.',
      '> Read only: `src/db/**` — and what you may write.',
      'For the work below, act only within the domain `api` (dom-',
      'Domains',
      'Writes: `src/api/**`, `src/shared/http.ts`.',
      'Reads only: `src/db/**`.');
    assert.ok(out.body.indexOf('SCOPE — WARNING') < out.body.indexOf('# '), 'the scope warning comes first');
  }
  // --- two domains, none with READS: it reads whatever it needs; a tag selects them ---
  {
    const out = await compile(['@WITHIN db'], ['    WHEN asked:', '        DO  it']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['src/db/**'], reads: null });
    has(out.body, '> Read whatever you need.');
    assert.deepEqual((await compile(['@WITHIN #backend'])).structure.perimeter().writes, ['src/api/**', 'src/shared/http.ts', 'src/db/**']);
  }
  // --- no @WITHIN: no perimeter, no scope warning ---
  {
    const out = await compile([], [], []);
    assert.equal(out.structure.perimeter(), null);
    assert.ok(!out.body.includes('SCOPE — WARNING'));
  }
  // --- a domain declared in the agent's own file ---
  {
    const out = await compile(['@WITHIN docs'], [], ['DOMAIN docs:', '    ABOUT  the documentation', '    WRITES IN docs/**', '']);
    assert.deepEqual(out.structure.perimeter(), { writes: ['docs/**'], reads: null });
  }

  // --- the names: a domain it imports; files that are there ---
  await assert.rejects(compile(['@WITHIN nope']), /`@WITHIN nope`: no imported domain is called `nope`/);
  await assert.rejects(compile(['@WITHIN ghost'], [], ['IMPORT ghost FROM @main.domains', '']), /ghost\.ap:1 {2}DOMAIN ghost: no file of the project matches `nowhere\/\*\*`/);

  // --- where @WITHIN stands: right above an AGENT, a TEAM, a FLOW or a STEP — never in a body, never opening a block ---
  await assert.rejects(compile([], ['    @WITHIN api', '    WHEN asked:', '        DO  it']), /`@WITHIN` stands above WHEN — @WITHIN stands only right above AGENT, TEAM, FLOW or STEP/);
  await assert.rejects(compile([], ['    @WITHIN api:', '        DO  it']), /`@WITHIN …:` opens a block — @WITHIN stands only right above AGENT, TEAM, FLOW or STEP/);

  // --- WRITES and READS are a domain's lines: in an agent, the rewrite; OWNS is gone ---
  await assert.rejects(compile([], ['    WRITES   api']), /WRITES is a line of a DOMAIN block — found inside AGENT: an agent works within a domain by its decorator — write `@WITHIN <domain>` above its AGENT/);
  await assert.rejects(compile([], ['    OWNS     src/**']), /OWNS was removed — declare the files as `EXPORT DOMAIN <name>:` with `WRITES IN src\/\*\*`, and write `@WITHIN <name>` above the agent/);

  // --- a domain file: ABOUT, WRITES and READS lines, globs inside the project, a formula only with a judge ---
  {
    const lint = lines => lintFile(write(join(lib, 'domains', 'web.ap'), lines), `${lines.join('\n')}\n`).map(e => e.message);
    const web = (...lines) => lint(['EXPORT DOMAIN web:', '    ABOUT  the web app', ...lines.map(l => `    ${l}`)]);
    assert.deepEqual(web('WRITES IN web/**', 'WRITES IN shared/ui.ts', 'READS IN lib/**'), [], 'lines add up');
    assert.ok(web().some(m => /DOMAIN block requires at least one of: WRITES, READS/.test(m)), 'a domain says its files');
    assert.ok(web('FOR    web/**').some(m => m.startsWith('FOR is not allowed inside DOMAIN — a domain says its files with `WRITES IN <glob>, …`')), 'FOR names the rewrite');
    assert.ok(web('WRITES IN ../web/**').some(m => m.startsWith('WRITES `../web/**`: a glob is read from the project root')), 'a glob stays in the project');
    assert.ok(web('WRITES IN web/** lib/**').some(m => m === '`WRITES IN web/** lib/**`: separate the items with commas — `WRITES IN web/**, lib/**`'));
    assert.ok(web('WRITES the pages of the web app').some(m => /^WRITES the pages of the web app: a formula is decided by a judge — say how much it weighs: `WRITES! <formula>`/.test(m)), 'a formula takes its `!`s');
    assert.deepEqual(web('WRITES! the pages IN web/**', 'READS!! the shared code'), [], 'a weighed formula is a line of its own — whether a judge decides it is the compilation\'s');
    assert.ok(web('WRITES!! IN web/**').some(m => m === "WRITES!! IN …: the `!`s weigh a formula's judgement, and this line has none — write `WRITES IN web/**`"));
    assert.ok(web('WRITES IN web/**', 'APPLIES team:delivery').some(m => /APPLIES: a perimeter .* goes on a POLICY or a SKILL — found on DOMAIN/.test(m)), 'a domain carries tags only');
    assert.ok(web('WRITES IN web/**', 'ALWAYS be fast').some(m => /ALWAYS is not allowed inside DOMAIN/.test(m)), 'a domain holds no rule');
  }
  // --- where a DOMAIN goes: the file top or an agent's body; WRITES stands in a DOMAIN only ---
  {
    const msgs = lines => lintFile(join(root, 'p.ap'), `${lines.join('\n')}\n`).map(e => e.message);
    assert.ok(msgs(['EXPORT PROCEDURE p:', '    ABOUT  p', '    DOMAIN docs:', '        ABOUT  d', '        WRITES IN docs/**'])
      .some(m => m === "a DOMAIN is declared at the file top or directly in an agent's body — found inside PROCEDURE"));
    assert.ok(msgs(['EXPORT PROCEDURE p:', '    ABOUT  p', '    FOR    docs/**']).some(m => m === 'FOR is a line of a DIMENSION block — found inside PROCEDURE'));
    assert.ok(msgs(['EXPORT PROCEDURE p:', '    ABOUT  p', '    READS  IN docs/**']).some(m => m === 'READS is a line of a DOMAIN block — found inside PROCEDURE'));
  }

  // --- a formula: the judge of the lines places each file — within, outside, or the agent's to decide ---
  {
    const P = { 'src/api/routes.ts': 0.95, 'src/shared/http.ts': 0.5, 'src/db/schema.ts': 0.1, 'docs/index.md': 0.05 };
    const asks = [];
    let down = false;
    const fake = { type: 'judge', name: 'fake', ask: async (state, checks, model) => {
      if (down) throw new Error('fake judge unreachable');
      const file = state.split('\n')[0];
      asks.push(file);
      return { model: model ?? 'fake-1.0', answers: Object.fromEntries(checks.map(c => [c.id, P[file] ?? 0.05])) };
    } };
    const lockPath = join(root, 'agent-pack.judge.lock');
    const open = (domains = { in: 0.8, out: 0.2 }) => {
      const lock = JudgeLock.load(lockPath, 'fake');
      return new JudgeRun({ adapter: fake, threshold: 0.5, offline: 'warn', lock: lockPath, concurrency: 4 }, [], lock,
        new UnitStore(join(root, '.agent-pack', 'units'), root, lock.model, { '@main': lib }), domains);
    };
    const http = line => domain('http', ['ABOUT   the HTTP code', line]);
    const top = ['IMPORT http FROM @main.domains', ''];
    const judged = async (run, line = 'WRITES! the code that serves HTTP') => { http(line); return compile(['@WITHIN http'], [], top, run); };

    // No judge: a formula is an error, at its line.
    http('WRITES! the code that serves HTTP');
    await assert.rejects(compile(['@WITHIN http'], [], top), /http\.ap:3 {2}WRITES! the code that serves HTTP: a domain formula needs a judge — add `judge` to the config/);

    // `!`: at or above `in` within, at or below `out` outside, between them the agent decides.
    let run = open();
    let out = await judged(run);
    const perimeter = out.structure.perimeter();
    assert.deepEqual(perimeter.writes, ['src/api/routes.ts', 'src/shared/http.ts'], 'a file within, and the uncertain one, are globs of their own');
    assert.deepEqual(perimeter.judged.writes, { formulas: ['the code that serves HTTP'], uncertain: { 'src/shared/http.ts': 0.5 } });
    assert.ok(Object.keys(P).every(f => asks.filter(a => a === f).length === 1) && asks.includes('a.ap'), 'no IN: every file of the project is asked about, once');
    has(out.body, 'the files a judge placed in “the code that serves HTTP”',
      'decide each in context, from what the work needs: `src/shared/http.ts` (p=0.50)',
      'Writes: the 1 files a judge placed in “the code that serves HTTP”.');
    const dom = Object.values(JSON.parse(out.structure.asJson()).blocks).find(b => b.kind === 'domain');
    assert.deepEqual(Object.fromEntries(Object.keys(P).map(f => [f, dom.args.formulas[0].p[f]])), P, 'the probabilities travel in the document — the apx carries them');
    assert.deepEqual(dom.args.thresholds, { in: 0.8, out: 0.2 });
    finishJudgeRun(run, { prune: false });

    // The cache: an unchanged file is not asked again; a changed one is; a changed formula asks about every file.
    asks.length = 0;
    await judged(open());
    assert.deepEqual(asks, [], 'nothing changed: every verdict from the unit');
    write(join(root, 'src/db/schema.ts'), ['y']);
    run = open();
    await judged(run);
    assert.deepEqual(asks, ['src/db/schema.ts'], 'only the changed file');
    finishJudgeRun(run, { prune: false });
    asks.length = 0;
    await judged(open(), 'WRITES! the HTTP layer');
    assert.ok(Object.keys(P).every(f => asks.includes(f)), 'another formula: every file again');

    // `!!`: the judge alone — within at or above `in`, the rest outside; an IN bounds the files asked about.
    asks.length = 0;
    out = await judged(open(), 'WRITES!! the HTTP layer IN src/**');
    assert.deepEqual(out.structure.perimeter().writes, ['src/api/routes.ts']);
    assert.deepEqual(out.structure.perimeter().judged.writes.uncertain, {});
    assert.ok(!asks.includes('docs/index.md'), 'IN src/**: docs/ is not asked about');

    // The thresholds are the config's.
    out = await judged(open({ in: 0.4, out: 0.2 }), 'WRITES!! the HTTP layer');
    assert.deepEqual(out.structure.perimeter().writes, ['src/api/routes.ts', 'src/shared/http.ts']);

    // A formula that places no file is a domain that puts work nowhere.
    await assert.rejects(judged(open(), 'WRITES!! the payment code IN docs/**'), /DOMAIN http: a judge placed no file in “the payment code”/);

    // The judge down: a warning, and the files it did not answer for stay outside.
    down = true;
    run = open();
    out = await judged(run, 'WRITES! the network code');
    assert.deepEqual(out.structure.perimeter().writes, []);
    assert.ok(run.warnings.some(w => /DOMAIN http: WRITES! the network code: some files not judged yet — fake is unavailable/.test(w.message)), run.warnings.map(w => w.message).join('\n'));
    down = false;
    rmSync(join(lib, 'domains', 'http.ap'));
  }

  // --- a team, a flow, a step: nested, @WITHIN narrows by naming what the one around it names; a delegation stays within its agent's ---
  {
    const team = join(root, 'teams', 'crew');
    const member = (name, above = []) => write(join(team, `${name}.ap`), ['IMPORT api, db FROM @main.domains', '', ...above,
      `EXPORT AGENT ${name} AS ${name}-role:`, '    ABOUT    a member', '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  do the work']);
    const crew = (aboveTeam, aboveFlow, aboveStep) => write(join(team, 'crew.ap'), ['IMPORT api, db FROM @main.domains', '', ...aboveTeam,
      'EXPORT TEAM crew:', '    MEMBER  builder, checker', '    ABOUT   a crew', '', '    WHEN asked to ship:', '        RUN ship', '',
      ...aboveFlow.map(l => `    ${l}`), '    FLOW ship:', ...aboveStep.map(l => `        ${l}`),
      '        STEP build it:', '            DELEGATE compile the code BY builder',
      '        STEP check it:', '            DELEGATE run the checks BY checker']);
    const build = () => bundleAgentObject({ agentName: 'builder', agentFile: join(team, 'builder.ap'), agentDir: team, projectRoot: root, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
    member('builder', ['@WITHIN api']); member('checker');
    crew(['@WITHIN api, db'], [], ['@WITHIN api']);
    const flow = Object.values(JSON.parse((await build()).structure.asJson()).blocks).find(b => b.kind === 'flow');
    assert.deepEqual([flow.body[0].keyword, flow.body[0].uses.length], ['@WITHIN', 2], "the team's @WITHIN decorates its flow");
    assert.ok(flow.body[0].body.some(n => n.keyword === '@WITHIN' && n.body.some(m => m.type === 'step' && m.title === 'build it')), "the step's, inside it");
    crew(['@WITHIN api'], [], ['@WITHIN db']);
    await assert.rejects(build(), /crew\.ap:12 {2}`@WITHIN db`: the @WITHIN around it names `api` — a nested @WITHIN names only what that one does/);
    crew([], ['@WITHIN db'], []);
    await assert.rejects(build(), /crew\.ap:13 {2}@WITHIN db: `builder`, whom this line delegates to, works within `api` — a step's @WITHIN names only domains of the agents it delegates to/);
    member('builder');
    await build();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('perimeter tests passed.');
