// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Checked conditions (I1) — `IF!` (the agent sees the condition, a judge
 * decides it), `IF!!` (a sealed gate), `UNTIL!` / `UNTIL!!` (the same as a loop
 * head, with a round limit). The question is built at compile time; the apx
 * answers `check <cnd-id>` by asking the judge on the session's variables,
 * closed when in doubt, and records every check. A fake judge answers here:
 * no test ever reaches Jev or needs a key.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { checkVocabulary } = await import('../dist/src/lint.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { apxPath, STATE_DIR } = await import('../dist/src/apx/paths.js');
const { queryTable } = await import('../dist/src/apx/tabeli.js');
const { TABELI_ENGINE } = await import('../dist/src/config.js');
const { checkId } = await import('../dist/src/check.js');
const { JudgeError } = await import('../dist/src/judge/types.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { buildPlaybookBundle } = await import('../dist/src/compiler/index.js');
const { compileWorkflow } = await import('../dist/adapters/claude-code/workflow.js');
const { default: claudeCode } = await import('../dist/adapters/claude-code/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-check-'));
const lib = join(tmp, 'library');
mkdirSync(lib);
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };

/** A session id variable of these tests' own: the harness running them may set the real one. */
const SESSION = 'AP_TEST_CHECK_SESSION';
const adapter = { ...claudeCode(), sessionEnv: SESSION };

/** The fake judge: answers `reply.p` for the one question, or throws `reply.error`; every call is kept. */
const calls = [];
const reply = { p: 0.9, error: null };
const fakeJudge = {
  type: 'judge', name: 'fake', maxStateChars: 400,
  async ask(state, checks, model) {
    calls.push({ state, checks, model });
    if (reply.error) throw reply.error;
    return { model: 'fake-1.0', answers: { [checks[0].id]: reply.p } };
  },
};
const CHECKS = { adapter: fakeJudge, threshold: 0.7, rounds: 3 };

const TAIL = [
  'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work', '',
  'TEMPLATE verdict:', '    ABOUT  a verdict', '    SLOTS:', '        decision: ENUM[accept reject]  "the decision"',
  '        reason: TEXT  "why it was decided"', '    BODY:', '        {decision}: {reason}', '',
];
/** Compile agent `name` from its body lines; `checks` null compiles without the config key. */
const compile = (lines, { name = 'a', checks = CHECKS, vars = {} } = {}) => {
  const file = write(join(tmp, `${name}.ap`), [
    `EXPORT AGENT ${name} AS a-role:`, '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '', ...TAIL,
  ]);
  return bundleAgentObject({
    agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib],
    libraries: { '@main': lib }, bundleConfig: { runtime: false }, vars, adapter, checks,
  });
};
const errorsOf = async (lines, opts) => { try { await compile(lines, opts); return ''; } catch (e) { return e.message; } };
/** What a compilation prints to stderr — its warnings. */
const stderrOf = async run => {
  const prior = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { return { result: await run(), stderr: seen.join('\n') }; } finally { console.error = prior; }
};

const BUILD = { builtAt: '', agentPackVersion: '', hash: '', tabeli: TABELI_ENGINE, checks: { adapter: 'fake', threshold: 0.7, rounds: 3 } };
const project = join(tmp, 'project');
/** One run of an agent's apx engine, with the fake judge loaded by name. */
const apx = async (doc, agent, ...args) => {
  const lines = [];
  const code = await new ApxEngine(doc, BUILD, join(project, apxPath(agent)), l => lines.push(l), undefined, () => fakeJudge).run(args);
  return { out: lines.join('\n'), code, lines };
};
const docOf = async (lines, opts) => ApDocument.fromJson((await compile(lines, opts)).structure.asJson());
const idOf = doc => Object.keys(doc.meta.checks ?? {})[0];

try {
  // --- the ids: stable for one agent and text, new when the text changes ---
  assert.match(checkId('a', 'the {{report}} is clean'), /^cnd-[0-9a-f]{8}$/);
  assert.equal(checkId('a', 'the {{report}} is clean'), checkId('a', 'the {{report}} is clean'), 'the same condition, the same id');
  assert.notEqual(checkId('a', 'the {{report}} is clean'), checkId('a', 'the {{report}} is clear'), 'editing the text makes a new condition');
  assert.notEqual(checkId('a', 'the {{report}} is clean'), checkId('b', 'the {{report}} is clean'), 'another agent, another condition');

  // --- IF!: the condition, and the check whose answer decides it ---
  {
    const { body, structure } = await compile(['    VAR report', '    IF! {{report}} lists no failing test:', '        DO  ship it', '    ELSE', '        DO  fix it']);
    const id = idOf(structure);
    assert.equal(id, checkId('a', '{{report}} lists no failing test'));
    assert.ok(body.includes(`If \`report\` (read its value: \`node .agent-pack/apx/a.apx get report\`) lists no failing test — run \`node .agent-pack/apx/a.apx check ${id}\`: its answer decides, not your own judgement:`), body);
    assert.ok(body.includes('Else:\n'), 'its ELSE renders as for IF');
    assert.deepEqual(structure.meta.checks[id], { kind: 'IF', level: 1, question: 'In the state, report lists no failing test?', vars: ['report'] });
  }

  // --- IF!!: sealed — in no prompt, in no view of the apx ---
  const SECRET = 'every migration in {{plan}} is reversible';
  const sealedDoc = await docOf(['    VAR plan', `    IF!! ${SECRET}:`, '        DO  run the migrations', '    ELSE', '        DO  stop and tell the user']);
  const sealedId = idOf(sealedDoc);
  {
    const { body } = await compile(['    VAR plan', `    IF!! ${SECRET}:`, '        DO  run the migrations', '    ELSE', '        DO  stop and tell the user']);
    assert.ok(body.includes(`If \`node .agent-pack/apx/a.apx check ${sealedId}\` answers open:\n    Do run the migrations\nElse:\n    Do stop and tell the user`), body);
    assert.ok(!body.includes('reversible'), 'the sealed condition is not in the prompt');
    const blocks = JSON.stringify(JSON.parse(sealedDoc.asJson()).blocks);
    assert.ok(!blocks.includes('reversible'), 'nor in any block of the document');
    assert.equal(sealedDoc.meta.checks[sealedId].question, 'In the state, every migration in plan is reversible?', 'only the apx keeps it');
    const views = [];
    for (const args of [['md'], ['start'], ['scope'], ['ls'], ['find', 'reversible'], ['get', sealedDoc.root().id], ['get', sealedDoc.root().id, 'json'], ['get', sealedId], ['help']]) {
      const r = await apx(sealedDoc, 'a', ...args);
      assert.ok(!r.out.includes('reversible'), `apx ${args.join(' ')} shows no sealed condition:\n${r.out}`);
      views.push(r);
    }
    assert.match(views[7].out, new RegExp(`^# check ${sealedId}  IF!!  — a judge decides it: node .*a\\.apx check ${sealedId}\\n# sealed`), views[7].out);
    assert.ok(views[2].out.includes(`  ${sealedId}  IF!!  (sealed)`), views[2].out);
  }

  // --- UNTIL!!: repeat until the gate opens, at most the configured rounds ---
  {
    const { body, structure } = await compile(['    VAR draft', '    UNTIL!! {{draft}} reads as plain English:', '        DO  rewrite the draft INTO draft'], { checks: { ...CHECKS, rounds: 4 } });
    const id = idOf(structure);
    assert.ok(body.includes(`Repeat until \`node .agent-pack/apx/a.apx check ${id}\` answers open — run it after each round, at most 4 rounds; at the limit, stop and report that the gate stayed closed:`), body);
    assert.ok(!body.includes('plain English'));
    const untilOne = await compile(['    VAR draft', '    UNTIL! {{draft}} reads well:', '        DO  rewrite it INTO draft']);
    assert.ok(untilOne.body.includes('reads well — after each round run `node .agent-pack/apx/a.apx check'), untilOne.body);
    assert.ok(untilOne.body.includes('at most 3 rounds'), untilOne.body);
  }

  // --- what a checked condition must read, and how its question is built ---
  {
    assert.match(await errorsOf(['    IF! the tests pass:', '        DO  ship']), /a\.ap:4  IF!: a checked condition reads at least one variable/);
    assert.match(await errorsOf(['    IF! the {{lang}} tests pass:', '        DO  ship'], { vars: { lang: 'go' } }), /IF!: a checked condition reads at least one variable/, 'a constant is no state');
    assert.match(await errorsOf(['    VAR report AS verdict', '    IF! {{report.decision}} is accept:', '        DO  ship']), /`\{\{report\.decision\}\}`: reading a field of a variable is not supported yet/);
    const shaped = await compile(['    VAR notes', '    IF! {{notes AS verdict}} accepts the change in {{lang}}:', '        DO  merge'], { vars: { lang: 'Go' } });
    const id = idOf(shaped.structure);
    assert.equal(shaped.structure.meta.checks[id].question,
      'In the state, "notes read as verdict (decision — the decision; reason — why it was decided)" accepts the change in Go?',
      'a shaped read carries the template fields; a constant is written in');
    assert.deepEqual(shaped.structure.meta.checks[id].vars, ['notes']);
    // `!IF` means nothing
    assert.deepEqual(checkVocabulary('t.ap', ['EXPORT AGENT t:', '    !IF the tests pass:', '        DO  x', ''].join('\n')).map(e => [e.line, e.message]),
      [[2, '`!IF` is not allowed — write IF, IF! (a judge decides) or IF!! (a sealed gate): "!IF the tests pass:"']]);
  }

  // --- without `checks`: IF! warns and reads as IF; IF!! fails ---
  {
    const { result, stderr } = await stderrOf(() => compile(['    VAR report', '    IF! {{report}} is clean:', '        DO  ship'], { checks: null }));
    assert.match(stderr, /a\.ap:5  IF!: no judge for checked conditions is configured — the condition is the agent's: it reads as IF; to have a judge decide it, add checks: \{ adapter: 'jev' \}/);
    assert.ok(result.body.includes('If `report` (read its value: `node .agent-pack/apx/a.apx get report`) is clean:\n    Do ship'), result.body);
    assert.equal(result.structure.meta.checks, undefined);
    assert.match(await errorsOf(['    VAR report', '    IF!! {{report}} is clean:', '        DO  ship'], { checks: null }),
      /a\.ap:5  IF!! needs checks: \{ adapter: 'jev' \} in agent-pack\.config\.mjs/);
  }
  console.log('checked conditions: compile tests passed.');

  // --- apx check: open, closed, closed when in doubt — each recorded ---
  {
    const doc = await docOf(['    VAR report', '    VAR notes', '    IF! {{report}} lists no failing test and {{notes}} agrees:', '        DO  ship']);
    const id = idOf(doc);
    const until = await docOf(['    VAR draft', '    UNTIL!! {{draft}} reads as plain English:', '        DO  rewrite the draft INTO draft'], { name: 'u' });
    const uid = idOf(until);
    const prior = process.env[SESSION];
    const records = agent => queryTable(join(project, STATE_DIR, 'one', 'checks.tbl'), [`agent=${agent}`]);
    try {
      // no session id: closed, nothing asked
      delete process.env[SESSION];
      let r = await apx(doc, 'a', 'check', id);
      assert.equal(r.code, 2);
      assert.deepEqual(r.lines, ['closed', `# error: variables need the harness session id, and ${SESSION} is not set — the gate stays closed`]);
      process.env[SESSION] = 'one';
      assert.equal((await apx(doc, 'a', 'check')).lines[0], 'closed', 'no id: closed, a usage error');
      assert.equal((await apx(doc, 'a', 'check', 'cnd-00000000')).code, 2);

      // an empty variable: closed, the judge never asked
      await apx(doc, 'a', 'set', 'report', 'all 42 tests pass');
      r = await apx(doc, 'a', 'check', id);
      assert.equal(r.code, 1);
      assert.deepEqual(r.lines, ['closed', '`notes` is empty — nothing is stored in it in this session: the condition cannot hold']);
      assert.equal(calls.length, 0);

      // open at or above the threshold — the state is each variable as stored, in order of first appearance
      const notes = '{"decision":"accept","reason":"green"}';
      await apx(doc, 'a', 'set', 'notes', notes);
      r = await apx(doc, 'a', 'check', id);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.lines, ['open', 'the judge answered p=0.9, at or above 0.7 — the condition holds']);
      assert.equal(calls[0].state, `### report\nall 42 tests pass\n\n### notes\n${notes}`);
      assert.equal(calls[0].checks[0].question, 'In the state, report lists no failing test and notes agrees?', 'the question as built, asked as is');

      // closed below it
      reply.p = 0.42;
      r = await apx(doc, 'a', 'check', id);
      assert.deepEqual([r.code, ...r.lines], [1, 'closed', 'the judge answered p=0.42, below 0.7 — the condition does not hold']);

      // closed when the judge cannot answer
      reply.error = new JudgeError('offline', 'fake: no API key');
      r = await apx(doc, 'a', 'check', id);
      assert.deepEqual([r.code, ...r.lines], [1, 'closed', 'the judge could not answer (fake: no API key)']);
      reply.error = null;

      // closed when the state is too large: never sent
      const before = calls.length;
      await apx(doc, 'a', 'set', 'report', 'x'.repeat(500));
      r = await apx(doc, 'a', 'check', id);
      assert.equal(r.code, 1);
      assert.match(r.lines[1], /^the state is too large for the judge \(\d+ characters, at most 400\) — it was not sent$/);
      assert.equal(calls.length, before);

      // every check recorded: a fingerprint of the state, never the state
      const recorded = records('a');
      assert.deepEqual(recorded.map(x => x.outcome), ['closed', 'open', 'closed', 'closed', 'closed']);
      assert.deepEqual(Object.keys(recorded[1]).filter(k => k !== 'id').sort(), ['agent', 'at', 'cnd', 'fingerprint', 'level', 'model', 'outcome', 'p', 'round', 'threshold']);
      assert.equal(recorded[1].cnd, id);
      assert.equal(recorded[1].model, 'fake-1.0');
      assert.equal(recorded[1].p, '0.9');
      assert.equal(recorded[1].threshold, '0.7');
      assert.match(recorded[1].fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(recorded).includes('42 tests'), 'the state itself is not recorded');

      // a sealed UNTIL: rounds counted, the limit, reset on open — no answer quotes the condition
      reply.p = 0.3;
      await apx(until, 'u', 'set', 'draft', 'Ce brouillon');
      const rounds = [];
      for (let i = 0; i < 3; i++) rounds.push(await apx(until, 'u', 'check', uid));
      assert.deepEqual(rounds.map(x => x.lines), [
        ['closed', 'the gate stayed closed — p=0.3, below 0.7', 'round 1 of 3 — do the next round, then check again'],
        ['closed', 'the gate stayed closed — p=0.3, below 0.7', 'round 2 of 3 — do the next round, then check again'],
        ['closed', 'the gate stayed closed — p=0.3, below 0.7', 'round limit reached (3 of 3): stop and report that the gate stayed closed'],
      ]);
      reply.p = 0.95;
      r = await apx(until, 'u', 'check', uid);
      assert.deepEqual([r.code, ...r.lines], [0, 'open', 'the gate opened (p=0.95)']);
      reply.p = 0.1;
      r = await apx(until, 'u', 'check', uid);
      assert.equal(r.lines[2], 'round 1 of 3 — do the next round, then check again', 'an open answer resets the count');
      await apx(until, 'u', 'set', 'draft', '');
      r = await apx(until, 'u', 'check', uid);
      assert.equal(r.lines[1], 'the gate stayed closed — a variable it reads is empty');
      for (const out of [...rounds, r].map(x => x.out)) assert.ok(!/plain English|draft/.test(out), `a sealed answer never quotes its condition: ${out}`);
      assert.deepEqual(records('u').map(x => [x.round, x.outcome, x.level]), [['1', 'closed', '2'], ['2', 'closed', '2'], ['3', 'closed', '2'], ['4', 'open', '2'], ['1', 'closed', '2'], ['2', 'closed', '2']]);
    } finally {
      if (prior === undefined) delete process.env[SESSION]; else process.env[SESSION] = prior;
    }
  }
  console.log('checked conditions: apx check tests passed.');

  // --- a checked condition in a flow STEP: checked by the step's BY agent, through its own apx ---
  {
    const team = join(tmp, 'teams', 'crew');
    const teamVars = write(join(team, 'vars.ap'), ['SESSION VAR report']);
    const flows = lines => write(join(team, 'flows.ap'), ['ABOUT  a crew', '', 'WHEN asked to ship:', '    RUN ship', '', 'FLOW ship:', ...lines]);
    const member = name => write(join(team, `${name}.ap`), [
      `EXPORT AGENT ${name} AS ${name}-role:`, '    ABOUT    a member', '    MANDATE  ship', '',
      `ROLE ${name}-role:`, '    ABOUT   a member', '    ALWAYS  test first',
    ]);
    const files = { builder: member('builder'), lead: member('lead') };
    const bundle = (name, checks = CHECKS) => bundleAgentObject({
      agentName: name, agentFile: files[name], agentDir: team, libraryRoot: lib, libraryRoots: [lib],
      libraries: { '@main': lib }, bundleConfig: { runtime: false }, adapter, checks, varsFiles: [{ path: teamVars, level: 'team' }],
    });
    const stepErrors = async name => { try { await bundle(name); return ''; } catch (e) { return e.message; } };
    const orchestration = async () => (await buildOrchestrationContent({
      cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'),
      libraryRoots: [lib], libraries: { '@main': lib }, config: { checks: CHECKS },
    })).content;
    const views = async (doc, agent) => {
      const flow = doc.byKind('flow').find(b => b.name === 'ship');
      return {
        md: await orchestration(),
        apxFlow: (await apx(doc, agent, 'flow', flow.id)).out,
        script: compileWorkflow(doc.block(flow.address), doc),
      };
    };

    // IF!: the BY agent's check line, in AGENTS.md, `apx flow` and the Workflow script
    flows(['    STEP judge it:', '        BY builder', '        IF! {{report}} says clean:', '            DO  hand it on', '        ELSE', '            DO  send it back']);
    const id = checkId('builder', '{{report}} says clean');
    const builderDoc = ApDocument.fromJson((await bundle('builder')).structure.asJson());
    const leadDoc = ApDocument.fromJson((await bundle('lead')).structure.asJson());
    assert.ok(builderDoc.meta.checks?.[id], 'the check is compiled into the BY agent\'s apx');
    assert.equal(leadDoc.meta.checks, undefined, 'and only there');
    const one = await views(leadDoc, 'lead');
    const head = `says clean — run \`node .agent-pack/apx/builder.apx check ${id}\`: its answer decides, not your own judgement:`;
    assert.ok(one.md.includes(`   If \`report\` (read its value: \`node .agent-pack/apx/builder.apx get report\`) ${head}`), `AGENTS.md:\n${one.md}`);
    assert.ok(one.apxFlow.includes(`check ${id}\`: its answer decides`) && one.apxFlow.includes('builder.apx check'), one.apxFlow);
    assert.ok(one.script.includes(`builder.apx check ${id}`), one.script);

    // IF!!: sealed in all three
    flows(['    STEP judge it:', '        BY builder', '        IF!! {{report}} shows no regression:', '            DO  hand it on', '        ELSE', '            DO  send it back']);
    const sid = checkId('builder', '{{report}} shows no regression');
    const sealed = await views(ApDocument.fromJson((await bundle('lead')).structure.asJson()), 'lead');
    // `apx flow` names the sibling apx by its path beside this one; AGENTS.md and the script from the project root
    const gate = `builder.apx check ${sid}\` answers open:`;
    for (const [where, text] of Object.entries(sealed)) {
      assert.ok(!text.includes('regression'), `${where} shows no sealed condition:\n${text}`);
      assert.ok(text.includes(gate), `${where} names the gate:\n${text}`);
    }
    assert.ok(sealed.md.includes(`   If \`node .agent-pack/apx/${gate}`) && sealed.script.includes(`If \`node .agent-pack/apx/${gate}`), 'the BY agent\'s apx, from the project root');
    assert.equal(ApDocument.fromJson((await bundle('builder')).structure.asJson()).meta.checks[sid].question, 'In the state, report shows no regression?');

    // a variable the BY agent does not see
    flows(['    STEP judge it:', '        BY builder', '        IF! {{verdict}} says clean:', '            DO  hand it on']);
    assert.match(await stepErrors('builder'), /flows\.ap:9  IF!: `\{\{verdict\}\}` is no variable the step's agent sees/);

    // BY names a team: no one agent to answer for the check
    flows(['    STEP judge it:', '        BY crew', '        IF! {{report}} says clean:', '            DO  hand it on']);
    assert.match(await stepErrors('lead'), /flows\.ap:9  IF!: a checked condition needs the step's agent: BY must name an agent/);

    // a checked condition at the flow's own level: not supported yet
    flows(['    UNTIL!! {{report}} says clean:', '        STEP fix it:', '            BY builder', '            DO  fix the next failure']);
    assert.match(await stepErrors('lead'), /flows\.ap:7  UNTIL!! at a flow's own level is not supported yet — put it inside a STEP/);    // the routing of the team: no executable — IF! warns and reads as IF, IF!! fails
    const routing = lines => write(join(team, 'flows.ap'), ['ABOUT  a crew', '', 'WHEN asked to ship:', ...lines, '',
      'FLOW ship:', '    STEP judge it:', '        BY builder', '        DO  hand it on']);
    routing(['    IF! the request is urgent:', '        RUN ship']);
    const routed = await stderrOf(orchestration);
    assert.match(routed.stderr, /flows\.ap:4  IF!: no executable here — the condition is the agent's: it reads as IF; checks run in an agent's body, a procedure an agent runs, or a flow step whose BY is an agent/);
    assert.ok(routed.result.includes('If the request is urgent:'), routed.result);
    routing(['    IF!! the request is urgent:', '        RUN ship']);
    await assert.rejects(orchestration, /flows\.ap:4  IF!!: no executable here — a sealed condition can never be checked here/);

    // BY written as the role its member takes: AGENTS.md and the member's apx resolve the same agent, the same id
    flows(['    STEP judge it:', '        BY builder-role', '        IF!! {{report}} shows no regression:', '            DO  hand it on']);
    const byRole = ApDocument.fromJson((await bundle('builder')).structure.asJson());
    assert.deepEqual(Object.keys(byRole.meta.checks), [sid], 'the role names its member: the id is the one BY builder makes');
    assert.ok((await orchestration()).includes(`builder.apx check ${sid}\` answers open:`), 'AGENTS.md prints that same id');
  }
  console.log('checked conditions: flow step tests passed.');

  // --- a playbook has no executable: IF! warns and reads as IF, IF!! fails ---
  {
    const config = { libraryRoot: lib, sharedLibraries: [], userRoot: join(tmp, 'home') };
    const playbook = lines => write(join(tmp, 'playbooks', 'release.ap'), ['# release', 'ABOUT  cut a release', 'WHEN asked for a release', 'DO  read the changes', ...lines]);
    playbook(['IF! the changes are small:', '    DO  release now']);
    const { result, stderr } = await stderrOf(() => buildPlaybookBundle(join(tmp, 'playbooks', 'release.ap'), config));
    assert.match(stderr, /release\.ap:5  IF!: no executable here — the condition is the agent's: it reads as IF/);
    assert.ok(result.body.includes('If the changes are small:'), result.body);
    playbook(['IF!! the changes are small:', '    DO  release now']);
    await assert.rejects(() => buildPlaybookBundle(join(tmp, 'playbooks', 'release.ap'), config), /release\.ap:5  IF!!: no executable here — a sealed condition can never be checked here/);
  }
  console.log('checked conditions: playbook tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
