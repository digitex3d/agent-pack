// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Variables (D32, I7) — constants substituted at compile time; session
 * variables declared in a body or exported by a module and imported, assigned by `VAR x:` blocks and
 * `DO … INTO x`, typed by a template (declared or inferred from a procedure's
 * AS), read as `{{x}}` through the apx, which keeps their values per harness
 * session in one tabeli table the project's agents share.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { checkVocabulary, lintFile } = await import('../dist/src/lint.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { apxFiles } = await import('../dist/src/apx/write.js');
const { apxPath } = await import('../dist/src/apx/paths.js');
const { TABELI_ENGINE } = await import('../dist/src/config.js');
const { default: claudeCode } = await import('../dist/adapters/claude-code/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-vars-'));
const lib = join(tmp, 'library');
const shared = join(tmp, 'shared');
mkdirSync(join(shared, 'procedures'), { recursive: true });
mkdirSync(lib);
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, lines.join('\n')); return file; };

/** A session id variable of these tests' own: the harness running them may set the real one. */
const SESSION = 'AP_TEST_SESSION_ID';
const adapter = { ...claudeCode(), sessionEnv: SESSION };

const TAIL = [
  'ROLE a-role:', '    ABOUT   a worker', '    ALWAYS  do the work', '',
  'TEMPLATE verdict:', '    ABOUT  a verdict', '    SLOTS:', '        decision: ENUM[accept reject]  "the decision"',
  '        reason: TEXT  "why"', '    BODY:', '        {decision}: {reason}', '',
  'TEMPLATE note:', '    ABOUT  a note', '    SLOTS:', '        text: TEXT "the note"', '',
  'PROCEDURE judge:', '    ABOUT  judge the claim', '    DO weigh it', '    AS verdict', '',
  'PROCEDURE jot:', '    ABOUT  jot it down', '    DO write it', '    AS note', '',
  'PROCEDURE plain:', '    ABOUT  no result shape', '    DO something', '',
];
/** Compile agent `name` from its body lines (indented under its EXPORT AGENT block). */
const compile = (lines, { vars = {}, name = 'a', extra = [], libraries } = {}) => {
  const file = write(join(tmp, `${name}.ap`), [
    ...extra, `EXPORT AGENT ${name} AS a-role:`, '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '', ...TAIL,
  ]);
  return bundleAgentObject({
    agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib],
    libraries: libraries ?? { '@main': lib }, bundleConfig: { runtime: false }, vars, adapter,
  });
};
/** The compile errors' text — '' when it compiles. */
const errorsOf = async (lines, opts) => {
  try { await compile(lines, opts); return ''; } catch (e) { return e.message; }
};
const fails = async (lines, re, opts) => assert.match(await errorsOf(lines, opts), re);
const compiles = async (lines, opts) => assert.equal(await errorsOf(lines, opts), '', `should compile: ${lines.join(' / ')}`);

try {
  // --- 1. constants: substituted at compile time, an undeclared one fails — unchanged ---
  {
    const { body } = await compile(['    ALWAYS  write in {{lang}} for {{name}}'], { vars: { lang: 'English', name: 'a' } });
    assert.ok(body.includes('You must always write in English for a'), 'a constant is its value in the text');
    await fails(['    ALWAYS  write in {{lang}}'], /a\.ap:4  unknown variable `\{\{lang\}\}`/);
  }

  // --- 2. a hyphenated name is a name: `{{a-b}}` undeclared fails (it passed silently) ---
  {
    await fails(['    DO  read {{a-b}}'], /a\.ap:4  unknown variable `\{\{a-b\}\}`/);
    const { body } = await compile(['    DO  read {{a-b}}'], { vars: { 'a-b': 'it' } });
    assert.ok(body.includes('Do read it'), 'and a declared one is substituted');
  }

  // --- 3. EXPORT VAR: a module's declarations, found by IMPORT like every export ---
  const mod = (path, lines) => write(join(lib, ...path.split('/')) + '.ap', lines);
  {
    mod('vars/crew', ['# crew', 'EXPORT VAR lang = English', 'EXPORT VAR board = Main', 'EXPORT VAR g = Hello:',
      'EXPORT SESSION VAR shared-note', 'EXPORT SESSION VAR crew-note AS verdict', 'EXPORT VAR own-note']);
    const imp = ['IMPORT lang, board, g, shared-note, crew-note, own-note FROM @main.vars'];
    const { body, structure } = await compile(['    ALWAYS  write in {{lang}} on {{board}}, {{g}}', '    VAR draft'], { extra: imp });
    assert.ok(body.includes('write in English on Main, Hello:'), 'an imported constant is its value — `= Hello:` never opens a block');
    assert.deepEqual(structure.byKind('var').map(v => [v.name, v.scope, v.about]), [
      ['shared-note', 'session', 'SESSION variable, declared in `@main.vars`'],
      ['crew-note', 'session', 'SESSION variable shaped as `verdict`, declared in `@main.vars`'],
      ['own-note', 'private', 'private variable, declared in `@main.vars`'],
      ['draft', 'private', 'private variable, declared in agent a'],
    ]);
    // exported but not imported: the agent does not see it
    await fails(['    DO  read {{shared-note}}'], /a\.ap:4  unknown variable `\{\{shared-note\}\}` — declare it in the body \(`VAR shared-note`\), or IMPORT it FROM the module that exports it/);
    // a variable exported from any module of the library — next to a template
    mod('templates/tally', ['EXPORT SESSION VAR tally AS tally-row', '', 'EXPORT TEMPLATE tally-row:', '    ABOUT  a row', '    SLOTS:', '        n: TEXT "n"']);
    await compiles(['    DO  count {{tally}}'], { extra: ['IMPORT tally FROM @main.templates'] });
    // a variable is no unit of the library's catalogue: IMPORT finds it directly
    const { buildMetadataIndex } = await import('../dist/src/libraryIndex.js');
    const names = Object.values(buildMetadataIndex({ libraryRoot: lib, sharedLibraries: [] }).exports).map(e => `${e.kind} ${e.name}`);
    assert.ok(names.includes('template tally-row') && !names.some(n => / tally$/.test(n)) && !names.some(n => / crew$|^generic /.test(n)), names.join(', '));
    // imports never pass on: a procedure's import serves its own reads, never the agent's
    mod('procedures/peek', ['IMPORT shared-note FROM @main.vars', '', 'EXPORT PROCEDURE peek:', '    ABOUT  peek', '    DO  look at {{shared-note}}']);
    await fails(['    WHEN asked:', '        RUN  peek', '        DO  read {{shared-note}}'],
      /a\.ap:7  `\{\{shared-note\}\}`: `shared-note` is imported by .*peek\.ap, not here — an import never passes on: IMPORT shared-note FROM @main\.vars in this file too/,
      { extra: ['IMPORT peek FROM @main.procedures'] });
    await compiles(['    WHEN asked:', '        RUN  peek', '        DO  read {{shared-note}}'], { extra: ['IMPORT peek FROM @main.procedures', 'IMPORT shared-note FROM @main.vars'] });
    // nor do writes: assigning a variable only a procedure imports fails the same way
    for (const write of [['        DO  note it INTO shared-note'], ['        VAR shared-note:', '            DO  note it']]) {
      await fails(['    WHEN asked:', '        RUN  peek', ...write], /a\.ap:7  `[^`]*shared-note[^`]*`: `shared-note` is imported by .*peek\.ap, not here — an import never passes on/,
        { extra: ['IMPORT peek FROM @main.procedures'] });
    }
    // the same name from two modules collides
    mod('more/notes', ['EXPORT SESSION VAR shared-note']);
    await fails([], /notes\.ap:1  variable name "shared-note" collides with already-imported variable at .*crew\.ap/, { extra: [...imp, 'IMPORT shared-note FROM @main.more'] });
    // a module only declares: no block, no assignment, top level only
    mod('bad/broken', ['EXPORT VAR z:', 'EXPORT SESSION VAR x = v', 'EXPORT GLOBAL VAR y', 'EXPORT VAR ok', 'EXPORT SESSION plan']);
    const broken = await errorsOf([], { extra: ['IMPORT ok FROM @main.bad'] });
    assert.match(broken, /broken\.ap:1  `EXPORT VAR z:`: a module declares a variable, never assigns it/, broken);
    assert.match(broken, /broken\.ap:2  a constant has no scope/, broken);
    assert.match(broken, /broken\.ap:3  GLOBAL variables are not available yet/, broken);
    assert.match(broken, /broken\.ap:5  SESSION is a variable's scope — it stands only right before VAR/, broken);
    // one name, one line, at the top of a module: twice, or with a body, is an error
    const lintMod = lines => lintFile(join(lib, 'vars', 'probe.ap'), lines.join('\n')).map(e => `${e.line}: ${e.message}`);
    assert.deepEqual(lintMod(['EXPORT VAR x = one', 'EXPORT VAR x = two']), ['2: `x` is exported twice in this module — first at line 1']);
    assert.deepEqual(lintMod(['EXPORT VAR x', '    DO  something']), ['2: `EXPORT VAR x` is one line — an exported variable has no body']);
    // next to a policy or a role, a variable is no line of theirs
    assert.deepEqual(lintFile(join(lib, 'policies', 'calm.ap'), ['EXPORT VAR tone = calm', '', 'EXPORT POLICY be-calm:', '    ABOUT  calm', '    ALWAYS  stay {{tone}}'].join('\n')), []);
    // an agent's file exports no variable: it would be no one's
    await fails(['    DO  read it'], /a\.ap:\d+  `EXPORT VAR k = v`: a library module exports variables/, { extra: ['EXPORT VAR k = v', ''] });
    // indented, `EXPORT VAR` is a template's literal text, kept
    const kept = await compile(['    VAR line-text', '    DO  show {{line-text AS ap-line}}'], { extra: ['TEMPLATE ap-line:', '    ABOUT  a line', '    SLOTS:', '        n: TEXT "n"', '    EXAMPLE:', '        EXPORT SESSION VAR plan AS x', ''] });
    assert.ok(kept.body.includes('EXPORT SESSION VAR plan AS x'), kept.body);
    await fails(['    VAR tpl-1234abcd'], /a\.ap:4  `tpl-1234abcd` has the shape of a block id/);
    await fails(['    VAR board'], /a\.ap:5  `board` is already a constant/, { extra: imp });
  }

  // --- a name means one thing: a variable never shares a template's name; reading a template says so ---
  {
    await fails(['    DO  read {{verdict}}'], /a\.ap:4  `\{\{verdict\}\}`: `verdict` is a template, not a variable — declare `VAR <name> AS verdict` and read that/);
    await fails(['    VAR verdict AS verdict'], /`verdict` names both a variable and a template/);
    mod('vars/clash', ['EXPORT SESSION VAR note']);
    await fails([], /`note` names both a variable and a template/, { extra: ['IMPORT note FROM @main.vars'] });
  }

  // --- scope: private by default, SESSION shared, GLOBAL reserved ---
  {
    await fails(['    SESSION VAR plan'], /a\.ap:4  a module exports a SESSION variable \(`EXPORT SESSION VAR plan`\)/);
    await fails(['    VAR x = 1'], /a\.ap:4  a module exports a constant \(`EXPORT VAR x = …`\)/);
    await fails(['    GLOBAL VAR x'], /a\.ap:4  GLOBAL variables are not available yet/);
    await fails(['    SESSION  keep it short'], /a\.ap:4  SESSION is a variable's scope — it stands only right before VAR/);
    // a body's `VAR x:` assigns the SESSION variable a module exports — RUN and type inference included
    mod('vars/scope', ['EXPORT SESSION VAR plan', 'EXPORT SESSION VAR the-verdict AS verdict']);
    const shared = { extra: ['IMPORT plan, the-verdict FROM @main.vars'] };
    const { body, structure } = await compile(['    VAR plan:', '        RUN  judge', '    VAR the-verdict:', '        RUN  judge'], shared);
    assert.deepEqual(structure.byKind('var').map(v => [v.name, v.scope, v.type?.target]), [
      ['plan', 'session', '@main.templates/verdict'], ['the-verdict', 'session', '@main.templates/verdict'],
    ], 'assigned, not redeclared; the type comes from the procedure');
    assert.ok(body.includes('Work out `plan`'), body);
    await fails(['    VAR the-verdict:', '        RUN  jot'], /`the-verdict` is a `verdict`, but this block yields a `note`/, shared);
    // no shadowing: a private declaration taking a SESSION variable's name
    await fails(['    VAR plan'], /a\.ap:5  `plan` is already a SESSION variable \(`@main\.vars`\) — no variable of another scope takes its name/, shared);
    await fails(['    VAR plan AS verdict:', '        RUN  judge'], /`plan` is already a SESSION variable/, shared);
  }

  // --- 4. INTO: only a trailing, uppercase INTO on a DO line assigns ---
  {
    const { structure } = await compile(['    DO  put it INTO the box now', '    DO  put it into x', '    DO  pass the INTO keyword.']);
    assert.equal(structure.byKind('var').length, 0, 'mid-line and lowercase INTO stay prose');
    await fails(['    DO  sum it up INTO nowhere'], /a\.ap:4  INTO nowhere: no variable `nowhere` — declare it with `VAR nowhere`/);
    await fails(['    DO  sum it up INTO board'], /a\.ap:4  INTO board: `board` is a constant/, { vars: { board: 'x' } });
    // RUN p INTO x: the procedure's result fills x, typed by its AS — as `VAR x:` with the RUN beneath
    {
      const { body, structure } = await compile(['    VAR x', '    RUN  judge INTO x']);
      assert.equal(structure.byKind('var').find(v => v.name === 'x').type?.target, '@main.templates/verdict', 'the type comes from the procedure');
      const run = body.indexOf('Run the procedure `judge`');
      assert.ok(run >= 0 && body.indexOf('store the result as `x`', run) > run, 'the agent runs it, then stores its result');
    }
    await fails(['    VAR x AS verdict', '    RUN  jot INTO x'], /`x` is a `verdict`, but this procedure yields a `note`/);
    await fails(['    RUN  judge INTO nowhere'], /a\.ap:4  INTO nowhere: no variable `nowhere`/);
    await fails(['    VAR x', '    MUST  keep it INTO x'], /a\.ap:5  INTO ends only a DO, ASK, COMPUTE or RUN line — `MUST` takes none/);
  }

  // --- 5. `VAR x:` blocks: the outcome of DO lines, a RUN, an IF/ELSE, an UNTIL ---
  {
    await compiles(['    VAR summary:', '        DO  read the notes', '        DO  write one paragraph']);
    await compiles(['    VAR claim:', '        RUN  judge']);
    await compiles(['    VAR the-verdict AS verdict:', '        IF the claim holds', '            RUN  judge', '        ELSE', '            DO  reject it']);
    await compiles(['    VAR draft:', '        UNTIL the draft reads well', '            DO  rewrite it']);
    await compiles(['    WHEN asked:', '        VAR answer:', '            DO  work it out INTO answer']);
    await fails(['    VAR x:', '        VAR y:', '            DO  z'], /a\.ap:5  a VAR block holds no VAR/);
    await compiles(['    VAR x:', '        NEVER  guess', '        MUST!  cite a source', '        DO  look it up']);
    await fails(['    VAR x:', '        DO  z', '        AS  note'], /a\.ap:6  AS is not allowed inside VAR — a VAR block's type sits on its head/);
    await fails(['    VAR x:', '        WHEN  asked:', '            DO  z'], /a\.ap:5  WHEN is not allowed inside VAR/);
    await fails(['    UNTIL done', '        VAR y:', '            DO  z'], /a\.ap:5  a VAR inside UNTIL would declare its variable again on every pass/);
    await fails(['    VAR x', '        DO  z'], /a\.ap:4  `VAR x` has indented lines beneath — missing ':'/);
    await fails(['    VAR g = Hello:'], /a\.ap:4  a module exports a constant/);
    const procedure = write(join(lib, 'procedures', 'p.ap'), ['EXPORT PROCEDURE p:', '    ABOUT  p', '    VAR found:', '        DO  look', '    DO  use {{found}}', '']);
    const { structure } = await compile(['    WHEN asked:', '        RUN  p'], { extra: ['IMPORT p FROM @main.procedures', ''] });
    assert.equal(structure.byKind('var')[0].about, 'private variable, declared in procedure p', 'a procedure body declares too');
    const policy = checkVocabulary('x.ap', ['EXPORT POLICY x:', '    ABOUT  x', '    VAR y', '    ALWAYS  z'].join('\n'));
    assert.ok(policy.some(e => /VAR goes in the body of one of: AGENT, SKILL, ROLE, PROCEDURE — found inside POLICY/.test(e.message)), JSON.stringify(policy));
    rmSync(procedure);
  }

  // --- 6. types: inferred from a procedure's AS, one per variable, imposed on the step that fills it ---
  {
    const { body, structure } = await compile([
      '    VAR claim:', '        RUN  judge',
      '    VAR summary AS note:', '        RUN  plain',
      '    VAR remark AS note',
      '    DO  note what you saw INTO remark',
    ]);
    const types = Object.fromEntries(structure.byKind('var').map(v => [v.name, v.type?.target]));
    assert.deepEqual(types, { claim: '@main.templates/verdict', summary: '@main.templates/note', remark: '@main.templates/note' });
    const tpl = name => structure.all().find(b => b.kind === 'template' && b.name === name).id;
    assert.ok(body.includes(`Work out \`summary\` — its value is the outcome of the lines below:\n    Strictly shape your response as — no deviation: \`note\` (${tpl('note')})\n    Run the procedure \`plain\``),
      `a typed variable shapes the block that fills it, a RUN of a procedure without AS too:\n${body}`);
    assert.ok(body.includes(`Do note what you saw\n  Strictly shape your response as — no deviation: \`note\` (${tpl('note')})\n  When done, store the result as \`remark\`: \`node .agent-pack/apx/a.apx set remark -\`, the value on stdin as JSON with the fields of that template.`),
      `and the DO line whose result it stores:\n${body}`);
    await fails(['    VAR x AS verdict:', '        RUN  jot'], /a\.ap:4  `x` is a `verdict`, but this block yields a `note` — a variable keeps one type for its whole life/);
    const later = await compile(['    VAR x:', '        RUN  judge', '    WHEN later:', '        DO  judge again INTO x']);
    assert.ok(later.body.includes('Do judge again\n      Strictly shape your response as — no deviation: `verdict`'), `the inferred type shapes every later assignment:\n${later.body}`);
    await fails(['    VAR x:', '        IF a', '            RUN  judge', '        ELSE', '            RUN  jot'], /a\.ap:4  `x`: the IF and ELSE branches yield different types — `verdict` and `note`/);
    await fails(['    VAR x AS! verdict'], /a\.ap:4  `AS!`: the AS of a VAR is its type and takes no force level/);
    await fails(['    VAR x AS missing'], /unknown template `missing`/);
  }

  // --- 7. reads: no field access yet, none in a template's text, comments aside, none from a shared library ---
  {
    await fails(['    VAR x AS verdict', '    DO  read {{x.reason}}'], /a\.ap:5  `\{\{x\.reason\}\}`: reading a field of a variable is not supported yet/);
    const body = checkVocabulary('t.ap', ['TEMPLATE t:', '    ABOUT  t', '    SLOTS:', '        a: TEXT "a"', '    BODY:', '        {a} for {{who}}', '    EXAMPLE:', '        x for {{who}}'].join('\n'));
    assert.deepEqual(body.map(e => [e.line, e.message]), [
      [6, "a template's BODY is literal text — no `{{…}}` is read there"],
      [8, "a template's EXAMPLE is literal text — no `{{…}}` is read there"],
    ]);
    await compiles(['    DO  work'], { extra: ['# the {{undeclared}} in a comment is never read', ''] });
    write(join(shared, 'procedures', 'reader.ap'), ['EXPORT PROCEDURE reader:', '    ABOUT  reads ambient state', '    DO  use {{seen}}', '']);
    const libraries = { '@main': lib, '@shared': shared };
    await fails(['    VAR seen', '    WHEN asked:', '        RUN  reader'], /reader\.ap:3  `\{\{seen\}\}`: a block of a shared library reads no variable — take the value as its input, through LENS-IN/,
      { libraries, extra: ['IMPORT reader FROM @shared.procedures', ''] });
    write(join(shared, 'procedures', 'reader.ap'), ['EXPORT PROCEDURE reader:', '    ABOUT  reads a constant', '    DO  use {{seen}}', '']);
    await compiles(['    WHEN asked:', '        RUN  reader'], { libraries, vars: { seen: 'it' }, extra: ['IMPORT reader FROM @shared.procedures', ''] });
  }

  // --- a skill is an agent: its body declares and assigns variables like an agent's ---
  {
    const skill = checkVocabulary('p.ap', ['EXPORT SKILL p AS r:', '    ABOUT  p', '    MANDATE  p', '    VAR x', '    DO  work INTO x', '    VAR y:', '        DO  work'].join('\n'));
    assert.deepEqual(skill, [], JSON.stringify(skill));
  }

  // --- shaped reads: `{{x AS template}}` — the agent keeps only what fits the template ---
  {
    const tpl = (structure, name) => structure.all().find(b => b.kind === 'template' && b.name === name).id;
    // an untyped variable: read it, then keep only what fits the template
    const untyped = await compile(['    VAR found', '    DO  compare {{found AS note}} with last year\'s', '    IF {{found AS note}} is empty', '        DO  stop']);
    const shaped = `\`found\` (read its value: \`node .agent-pack/apx/a.apx get found\`), keeping only what fits **note** (${tpl(untyped.structure, 'note')}) and shaped as it`;
    assert.ok(untyped.body.includes(`Do compare ${shaped} with last year's`), untyped.body);
    assert.ok(untyped.body.includes(`If ${shaped} is empty:`), 'in a condition too');
    // a variable already typed with that template: a plain read
    const same = await compile(['    VAR found AS note', '    DO  compare {{found AS note}} with {{found}}']);
    assert.ok(same.body.includes('Do compare `found` (read its value: `node .agent-pack/apx/a.apx get found`) with `found` (read its value: `node .agent-pack/apx/a.apx get found`)'), same.body);
    await fails(['    DO  compare {{lang AS note}}'], /a\.ap:4  `\{\{lang AS note\}\}`: a constant has no shape to take — write the part you need/, { vars: { lang: 'English' } });
    await fails(['    VAR found', '    DO  compare {{found AS missing}}'], /a\.ap:5  `\{\{found AS missing\}\}`: unknown template `missing` — define it, or IMPORT it/);
    await fails(['    VAR found', '    DO  compare {{found AS! note}}'], /a\.ap:5  `\{\{found AS! note\}\}`: the AS of a read is a shape and takes no force level/);
    await fails(['    DO  compare {{nothing AS note}}'], /unknown variable `\{\{nothing AS note\}\}`/);
    const inBody = checkVocabulary('t.ap', ['TEMPLATE t:', '    ABOUT  t', '    SLOTS:', '        a: TEXT "a"', '    BODY:', '        {a} for {{who AS note}}'].join('\n'));
    assert.deepEqual(inBody.map(e => e.line), [6], 'never in a template\'s text');
    write(join(shared, 'procedures', 'reader.ap'), ['EXPORT PROCEDURE reader:', '    ABOUT  reads ambient state', '    DO  use {{seen AS note}}', '']);
    await fails(['    VAR seen', '    WHEN asked:', '        RUN  reader'], /reader\.ap:3  `\{\{seen AS note\}\}`: a block of a shared library reads no variable/,
      { libraries: { '@main': lib, '@shared': shared }, extra: ['IMPORT reader FROM @shared.procedures', ''] });
  }

  // --- 8. RETURN is gone from the language ---
  await fails(['    RETURN  the answer'], /a\.ap:4  unknown keyword `RETURN`/);

  // --- 9. a store named like an apx verb would be unreachable ---
  for (const verb of ['set', 'ls']) {
    await fails(['', `STORE ${verb}:`, '    ABOUT  notes', '    TYPE   tabeli', '    SLOTS:', '        topic: TEXT "t"'], new RegExp(`STORE ${verb}: \`${verb}\` is a verb of the apx`));
  }
  console.log('variables: compile tests passed.');

  // --- 10–14. the apx keeps variables per session: SESSION ones shared by the project's agents, private ones each agent's own ---
  {
    const project = join(tmp, 'apx-project');
    mod('vars/apx-team', ['EXPORT SESSION VAR answer', 'EXPORT SESSION VAR the-verdict AS verdict', 'EXPORT VAR board = Product']);
    const extra = ['IMPORT answer, the-verdict, board FROM @main.vars'];
    const docOf = async name => ApDocument.fromJson((await compile(['    VAR mine', '    DO  read {{answer}} on {{board}}, with {{mine}}', '    DO  decide INTO the-verdict'], { name, extra })).structure.asJson());
    const docs = { a: await docOf('a'), b: await docOf('b') };
    const BUILD = { builtAt: '', agentPackVersion: '', hash: '', tabeli: TABELI_ENGINE };
    /** One run of `agent`'s engine; `build` names the tabeli it creates tables with. */
    const apxBuilt = (build, agent, ...args) => {
      const lines = [];
      const code = new ApxEngine(docs[agent], build, join(project, apxPath(agent)), l => lines.push(l)).run(args);
      return { out: lines.join('\n'), code };
    };
    const apx = (agent, ...args) => apxBuilt(BUILD, agent, ...args);
    const valueOf = out => out.slice(out.indexOf('# value:\n') + '# value:\n'.length);
    const prior = process.env[SESSION];
    try {
      process.env[SESSION] = 'session-one';

      // 10. get <block id> unchanged; ls kind=var; get <name> empty, then set; set refuses what it must
      const tplId = docs.a.all().find(b => b.kind === 'template' && b.name === 'verdict').id;
      const block = apx('a', 'get', tplId);
      assert.equal(block.code, 0);
      assert.ok(block.out.includes(`# template verdict  ${tplId}`) && block.out.includes('used by:'), block.out);
      const ls = apx('a', 'ls', 'kind=var');
      assert.ok(ls.out.includes('var (3)') && /var-[0-9a-f]{8}  the-verdict  — SESSION variable shaped as `verdict`, declared in `@main\.vars`/.test(ls.out)
        && /var-[0-9a-f]{8}  mine  — private variable, declared in agent a/.test(ls.out), ls.out);
      let r = apx('a', 'get', 'answer');
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.includes('SESSION variable') && r.out.includes('read by:\n  agent a') && r.out.endsWith('# value: (empty — nothing stored in this session yet)'), r.out);
      assert.ok(apx('a', 'get', 'the-verdict').out.includes('used by:\n  agent a'), 'who stores it: the DO … INTO line');
      assert.match(apx('a', 'get', 'board').out, /^# constant board = Product/);
      r = apx('a', 'set', 'answer', '42');
      assert.equal(r.code, 0, r.out);
      assert.equal(valueOf(apx('a', 'get', 'answer').out), '42');
      r = apx('a', 'set', 'nothing', 'x');
      assert.equal(r.code, 1);
      assert.match(r.out, /no variable `nothing` in this agent .* nothing was written/);
      r = apx('a', 'set', 'board', 'x');
      assert.equal(r.code, 1);
      assert.match(r.out, /`board` is a constant, fixed at compile time/);
      r = apx('a', 'set', 'the-verdict', '{"decision":"accept"}');
      assert.equal(r.code, 2);
      assert.match(r.out, /the value is not shaped as `verdict`: reason: required field missing — nothing was written/);
      assert.ok(apx('a', 'get', 'the-verdict').out.endsWith('# value: (empty — nothing stored in this session yet)'), 'a refused value writes nothing');
      assert.match(apx('a', 'set', 'the-verdict', 'not json').out, /not valid JSON/);
      const verdict = '{"decision":"reject","reason":"two sources disagree"}';
      assert.equal(apx('a', 'set', 'the-verdict', verdict).code, 0);
      assert.equal(valueOf(apx('a', 'get', 'the-verdict').out), verdict);

      // 11. byte for byte: a literal \n in code, real newlines, quotes, `=`, UTF-8 — through argv and stdin
      const tricky = 'console.log("a\\nb");\nline 2 \'single\' "double" x=y a==b\nàé€ 日本 \\\\ end\n\n';
      assert.equal(apx('a', 'set', 'answer', tricky).code, 0);
      assert.equal(valueOf(apx('a', 'get', 'answer').out), tricky);
      for (const f of apxFiles('a', docs.a.asJson(), project, false)) write(f.path, [f.content]);
      const node = (args, input) => spawnSync('node', [apxPath('a'), ...args], { cwd: project, encoding: 'utf-8', input, env: { ...process.env, [SESSION]: 'session-one' } });
      const piped = 'from stdin: printf("%s\\n", s);\r\n= ünïcode =\n';
      assert.equal(node(['set', 'answer', '-'], piped).status, 0);
      const got = node(['get', 'answer']);
      assert.equal(got.status, 0, got.stdout + got.stderr);
      assert.equal(valueOf(got.stdout).slice(0, -1), piped, 'the value, then one newline');

      // 12. another session sees nothing of it; another agent of the same session sees it all
      assert.equal(valueOf(apx('b', 'get', 'answer').out), piped, 'agents of one session share its variables');
      process.env[SESSION] = 'session-two';
      assert.ok(apx('a', 'get', 'answer').out.endsWith('# value: (empty — nothing stored in this session yet)'), 'a session sees only its own');
      apx('b', 'set', 'answer', 'two');
      process.env[SESSION] = 'session-one';
      assert.equal(valueOf(apx('a', 'get', 'answer').out), piped);

      // private: each agent its own — isolated between two agents, kept across two invocations of one
      assert.match(apx('a', 'get', 'mine').out, /# var mine .*[\s\S]*# value: \(empty/);
      assert.equal(apx('a', 'set', 'mine', 'only a').code, 0);
      assert.equal(apx('b', 'set', 'mine', 'only b').code, 0);
      assert.equal(valueOf(apx('a', 'get', 'mine').out), 'only a', 'a private value is its agent\'s alone');
      assert.equal(valueOf(apx('b', 'get', 'mine').out), 'only b');
      assert.equal(node(['get', 'mine']).stdout.endsWith('# value:\nonly a\n'), true, 'the same agent, invoked again in the session, finds its own value');
      process.env[SESSION] = 'session-two';
      assert.ok(apx('a', 'get', 'mine').out.endsWith('# value: (empty — nothing stored in this session yet)'), 'and only in its session');
      process.env[SESSION] = 'session-one';

      // 13. no session id: session variables fail closed, everything else works
      delete process.env[SESSION];
      for (const [args, what] of [[['get', 'answer'], 'read or written'], [['set', 'answer', 'x'], 'written']]) {
        r = apx('a', ...args);
        assert.equal(r.code, 2);
        assert.equal(r.out, `# error: variables need the harness session id, and ${SESSION} is not set — nothing was ${what}`);
      }
      process.env[SESSION] = '../escape';
      assert.match(apx('a', 'get', 'answer').out, /holds no usable session id/);
      delete process.env[SESSION];
      for (const args of [['ls'], ['scope'], ['get', 'board'], ['get', tplId]]) assert.equal(apx('a', ...args).code, 0, args.join(' '));
      const unnamed = ApDocument.fromJson(JSON.stringify({ ...JSON.parse(docs.a.asJson()), meta: { ...JSON.parse(docs.a.asJson()).meta, sessionEnv: undefined } }));
      const lines = [];
      assert.equal(new ApxEngine(unnamed, BUILD, join(project, apxPath('a')), l => lines.push(l)).run(['get', 'answer']), 2);
      assert.match(lines.join('\n'), /compiled without an adapter that names where it is/);

      // 14. a tabeli older than v2 is refused: it does not keep the bytes
      const fake = write(join(tmp, 'fake-tabeli'), [
        '#!/bin/sh',
        'if [ -z "$1" ]; then echo "# tabeli v1 seed - fake"; exit 0; fi',
        'if [ "$1" = init ]; then printf \'#!/bin/sh\\necho "# tabeli v1 - fake"\\n\' > "$2"; chmod +x "$2"; exit 0; fi',
        'exit 1', '',
      ]);
      chmodSync(fake, 0o755);
      process.env[SESSION] = 'session-old';
      r = apxBuilt({ ...BUILD, tabeli: fake }, 'a', 'set', 'answer', 'x');
      assert.equal(r.code, 2);
      assert.match(r.out, /variables: tabeli v2 or newer is needed, and .*fake-tabeli is v1 — build agent-pack/, 'the engine that would create the table is checked');
      // a table already there, made by a v1 engine, is checked too: it runs its own engine
      const old = join(project, '.agent-pack', 'state', 'session-old', 'session.tbl');
      write(old, ['#!/bin/sh', 'echo "# tabeli v1 - fake"', '']);
      chmodSync(old, 0o755);
      assert.match(apx('a', 'get', 'answer').out, /variables: tabeli v2 or newer is needed, and .*session\.tbl is v1 — upgrade it: .*tabeli upgrade /);
      // an apx written before agent-pack shipped its engine records none
      process.env[SESSION] = 'session-none';
      assert.match(apxBuilt({ ...BUILD, tabeli: undefined }, 'a', 'set', 'answer', 'x').out, /variables: this apx records no tabeli engine — build agent-pack/);
    } finally {
      if (prior === undefined) delete process.env[SESSION]; else process.env[SESSION] = prior;
    }
    console.log('variables: apx tests passed.');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
