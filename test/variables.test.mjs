// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Variables (D32, I7) — constants substituted at compile time; session
 * variables declared in vars.ap or a body, assigned by `VAR x:` blocks and
 * `DO … INTO x`, typed by a template (declared or inferred from a procedure's
 * AS), read as `{{x}}` through the apx, which keeps their values per harness
 * session in one tabeli table the project's agents share.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { spawnSync } from 'child_process';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { parseVarsAp, varsFilesFor } = await import('../dist/src/varsAp.js');
const { checkVocabulary } = await import('../dist/src/lint.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');
const { apxFiles } = await import('../dist/src/apx/write.js');
const { apxPath } = await import('../dist/src/apx/paths.js');
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
const compile = (lines, { vars = {}, varsFiles = [], name = 'a', extra = [], libraries } = {}) => {
  const file = write(join(tmp, `${name}.ap`), [
    ...extra, `EXPORT AGENT ${name} AS a-role:`, '    ABOUT    an agent', '    MANDATE  do the work', ...lines, '', ...TAIL,
  ]);
  return bundleAgentObject({
    agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib],
    libraries: libraries ?? { '@main': lib }, bundleConfig: { runtime: false }, vars, varsFiles, adapter,
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

  // --- 3. vars.ap: constants and variables, linted; the hierarchy project < team < agent ---
  {
    const parsed = parseVarsAp(['# shared', 'VAR board = "Product"', 'VAR best-pizza', 'SESSION VAR report AS verdict', 'VAR g = Hello:', ''].join('\n'), 'vars.ap');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.constants, { board: 'Product', g: 'Hello:' }, '`VAR g = Hello:` is a constant, never a block');
    assert.deepEqual(parsed.variables.map(s => [s.name, s.scope, s.type, s.line]), [['best-pizza', 'private', null, 3], ['report', 'session', 'verdict', 4]]);
    const bad = parseVarsAp(['VAR x', 'VAR x = 1', 'VAR tpl-1234abcd', 'VAR y AS! verdict', 'VAR z:', '    DO z', 'DO no'].join('\n'), 'vars.ap');
    const messages = bad.errors.map(e => `${e.line}: ${e.message}`);
    assert.ok(messages.some(m => /^2: `x` is declared twice in vars\.ap \(first at line 1\)/.test(m)), messages.join('\n'));
    assert.ok(messages.some(m => /^3: `tpl-1234abcd` has the shape of a block id/.test(m)), messages.join('\n'));
    assert.ok(messages.some(m => /^4: `AS!`: the AS of a VAR is its type and takes no force level/.test(m)), messages.join('\n'));
    assert.ok(messages.some(m => /^5: `z:` assigns a block's outcome .* never in vars\.ap/.test(m)), messages.join('\n'));
    assert.ok(messages.some(m => /^7: vars\.ap holds only VAR lines/.test(m)), messages.join('\n'));

    const project = join(tmp, 'proj');
    const team = join(project, 'teams', 'crew');
    const member = write(join(team, 'm.ap'), ['EXPORT AGENT m AS r:']);
    write(join(team, 'flows.ap'), ['# crew']);
    write(join(project, 'vars.ap'), ['VAR lang = Italian', 'VAR board = Main', 'SESSION VAR shared-note']);
    write(join(team, 'vars.ap'), ['VAR lang = English', 'SESSION VAR crew-note AS verdict']);
    const files = varsFilesFor(member, project);
    assert.deepEqual(files.map(f => f.level), ['project', 'team'], "a team member's folder is its team's: one file, read once");
    const { body, structure } = await compile(['    ALWAYS  write in {{lang}} on {{board}}', '    VAR draft'], { varsFiles: files });
    assert.ok(body.includes('write in English on Main'), 'a deeper constant overrides');
    assert.deepEqual(structure.byKind('var').map(v => [v.name, v.scope, v.about]), [
      ['shared-note', 'session', 'SESSION variable, declared in vars.ap (project)'],
      ['crew-note', 'session', 'SESSION variable shaped as `verdict`, declared in vars.ap (team)'],
      ['draft', 'private', 'private variable, declared in agent a'],
    ]);
    write(join(team, 'vars.ap'), ['SESSION VAR shared-note']);
    await fails([], /vars\.ap:1  variable `shared-note` is declared twice — first in vars\.ap \(project\)/, { varsFiles: files });
    await fails(['    VAR tpl-1234abcd'], /a\.ap:4  `tpl-1234abcd` has the shape of a block id/);
    await fails(['    VAR board'], /a\.ap:4  `board` is already a constant/, { varsFiles: files });
  }

  // --- scope: private by default, SESSION shared, GLOBAL reserved — each where it may be declared ---
  {
    const team = (lines, level = 'team') => ({ varsFiles: [{ path: write(join(tmp, 'scope', level, 'vars.ap'), lines), level }] });
    // SESSION in an agent's vars.ap or in a body
    await fails([], /vars\.ap:1  a SESSION variable is shared — declare it in a team's or the project's vars\.ap/, team(['SESSION VAR plan'], 'agent'));
    await fails(['    SESSION VAR plan'], /a\.ap:4  a SESSION variable is declared in a team's or the project's vars\.ap/);
    // private in a team's or the project's vars.ap
    for (const level of ['team', 'project']) {
      await fails([], /vars\.ap:1  a private variable belongs to one agent — declare it in the agent's vars\.ap or body, or write SESSION VAR/, team(['VAR draft'], level));
    }
    await compiles([], team(['VAR draft'], 'agent'));
    // a scoped constant, GLOBAL, a scope word not before VAR
    assert.match(parseVarsAp('SESSION VAR x = v').errors[0].message, /a constant has no scope — write `VAR x = …`/);
    assert.match(parseVarsAp('GLOBAL VAR x').errors[0].message, /GLOBAL variables are not available yet/);
    await fails(['    GLOBAL VAR x'], /a\.ap:4  GLOBAL variables are not available yet/);
    assert.match(parseVarsAp('SESSION plan').errors[0].message, /SESSION is a variable's scope — it stands only right before VAR/);
    await fails(['    SESSION  keep it short'], /a\.ap:4  SESSION is a variable's scope — it stands only right before VAR/);
    // a body's `VAR x:` assigns the SESSION variable a team declares — RUN and type inference included
    const shared = team(['SESSION VAR plan', 'SESSION VAR verdict AS verdict']);
    const { body, structure } = await compile(['    VAR plan:', '        RUN  judge', '    VAR verdict:', '        RUN  judge'], shared);
    assert.deepEqual(structure.byKind('var').map(v => [v.name, v.scope, v.type?.target]), [
      ['plan', 'session', '@main.templates/verdict'], ['verdict', 'session', '@main.templates/verdict'],
    ], 'assigned, not redeclared; the type comes from the procedure');
    assert.ok(body.includes('Work out `plan`'), body);
    await fails(['    VAR verdict:', '        RUN  jot'], /`verdict` is a `verdict`, but this block yields a `note`/, shared);
    // no shadowing: a private declaration taking a SESSION variable's name
    await fails(['    VAR plan'], /a\.ap:4  `plan` is already a SESSION variable \(vars\.ap \(team\)\) — no variable of another scope takes its name/, shared);
    await fails(['    VAR plan AS verdict:', '        RUN  judge'], /`plan` is already a SESSION variable/, shared);
    await fails([], /`plan` is already a SESSION variable/, { varsFiles: [...shared.varsFiles, { path: write(join(tmp, 'scope', 'own', 'vars.ap'), ['VAR plan']), level: 'agent' }] });
  }

  // --- 4. INTO: only a trailing, uppercase INTO on a DO line assigns ---
  {
    const { structure } = await compile(['    DO  put it INTO the box now', '    DO  put it into x', '    DO  pass the INTO keyword.']);
    assert.equal(structure.byKind('var').length, 0, 'mid-line and lowercase INTO stay prose');
    await fails(['    DO  sum it up INTO nowhere'], /a\.ap:4  INTO nowhere: no variable `nowhere` — declare it with `VAR nowhere`/);
    await fails(['    DO  sum it up INTO board'], /a\.ap:4  INTO board: `board` is a constant/, { vars: { board: 'x' } });
    await fails(['    VAR x', '    RUN  judge INTO x'], /a\.ap:5  `RUN judge INTO x`: RUN takes no INTO — write `VAR x:` with `RUN judge` beneath/);
    await fails(['    VAR x', '    MUST  keep it INTO x'], /a\.ap:5  INTO ends only a DO line — `MUST` takes none/);
  }

  // --- 5. `VAR x:` blocks: the outcome of DO lines, a RUN, an IF/ELSE, an UNTIL ---
  {
    await compiles(['    VAR summary:', '        DO  read the notes', '        DO  write one paragraph']);
    await compiles(['    VAR claim:', '        RUN  judge']);
    await compiles(['    VAR verdict AS verdict:', '        IF the claim holds', '            RUN  judge', '        ELSE', '            DO  reject it']);
    await compiles(['    VAR draft:', '        UNTIL the draft reads well', '            DO  rewrite it']);
    await compiles(['    WHEN asked:', '        VAR answer:', '            DO  work it out INTO answer']);
    await fails(['    VAR x:', '        VAR y:', '            DO  z'], /a\.ap:5  a VAR block holds no VAR/);
    await compiles(['    VAR x:', '        NEVER  guess', '        MUST!  cite a source', '        DO  look it up']);
    await fails(['    VAR x:', '        DO  z', '        AS  note'], /a\.ap:6  AS is not allowed inside VAR — a VAR block's type sits on its head/);
    await fails(['    VAR x:', '        WHEN  asked:', '            DO  z'], /a\.ap:5  WHEN is not allowed inside VAR/);
    await fails(['    UNTIL done', '        VAR y:', '            DO  z'], /a\.ap:5  a VAR inside UNTIL would declare its variable again on every pass/);
    await fails(['    VAR x', '        DO  z'], /a\.ap:4  `VAR x` has indented lines beneath — missing ':'/);
    await fails(['    VAR g = Hello:'], /a\.ap:4  a constant is declared in vars\.ap/);
    const procedure = write(join(lib, 'procedures', 'p.ap'), ['EXPORT PROCEDURE p:', '    ABOUT  p', '    VAR found:', '        DO  look', '    DO  use {{found}}', '']);
    const { structure } = await compile(['    WHEN asked:', '        RUN  p'], { extra: ['IMPORT p FROM @main.procedures', ''] });
    assert.equal(structure.byKind('var')[0].about, 'private variable, declared in procedure p', 'a procedure body declares too');
    const policy = checkVocabulary('x.ap', ['EXPORT POLICY x:', '    ABOUT  x', '    VAR y', '    ALWAYS  z'].join('\n'));
    assert.ok(policy.some(e => /VAR goes in the body of one of: AGENT, ROLE, PROCEDURE — found inside POLICY/.test(e.message)), JSON.stringify(policy));
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

  // --- playbooks have no executable yet: no session variable — declared, assigned or read; constants as before ---
  {
    const NO = /playbooks have no executable yet — session variables are not available/;
    const legacy = checkVocabulary(join(tmp, 'playbooks', 'p.ap'), ['ABOUT  p', 'WHEN  asked', 'VAR x', 'DO  work INTO x'].join('\n'));
    assert.deepEqual(legacy.map(e => e.line), [3, 4], JSON.stringify(legacy));
    assert.ok(legacy.every(e => NO.test(e.message)), JSON.stringify(legacy));
    const block = checkVocabulary('p.ap', ['EXPORT PLAYBOOK p:', '    ABOUT  p', '    VAR x:', '        DO  work'].join('\n'));
    assert.ok(block.some(e => e.line === 3 && NO.test(e.message)), JSON.stringify(block));
    const dir = join(tmp, 'pb', 'playbooks');
    write(join(dir, 'vars.ap'), ['VAR seen', 'VAR lang = English']);
    const playbook = write(join(dir, 'p.playbook.ap'), ['ABOUT  p', 'WHEN  asked', 'DO  use {{seen}} in {{lang}}', '']);
    const { buildPlaybookBundle } = await import('../dist/src/compiler/index.js');
    const config = { libraryRoot: lib, sharedLibraries: [], userRoot: '' };
    await assert.rejects(buildPlaybookBundle(playbook, config), /p\.playbook\.ap:3  `\{\{seen\}\}`: playbooks have no executable yet/);
    write(playbook, ['ABOUT  p', 'WHEN  asked', 'DO  use it in {{lang}}', '']);
    assert.ok((await buildPlaybookBundle(playbook, config)).body.includes('{{lang}}'), 'a constant in a playbook stays as today');
  }

  // --- 8. RETURN is gone from the language ---
  await fails(['    RETURN  the answer'], /a\.ap:4  unknown keyword `RETURN`/);

  // --- 9. a store named like an apx verb would be unreachable ---
  for (const verb of ['set', 'ls']) {
    await fails(['', `STORE ${verb}:`, '    ABOUT  notes', '    TYPE   tabeli', '    SLOTS:', '        topic: TEXT "t"'], new RegExp(`STORE ${verb}: \`${verb}\` is a verb of the apx`));
  }
  console.log('variables: compile tests passed.');

  // --- 10–14. the apx keeps variables per session: SESSION ones shared by the project's agents, private ones each agent's own ---
  const ensure = spawnSync(join(homedir(), '.claude/skills/tabeli/scripts/ensure-engine.sh'), { encoding: 'utf-8' });
  if (ensure.status !== 0 && !process.env.APX_TABELI) {
    console.log('variables: apx tests skipped (tabeli engine not available).');
  } else {
    const project = join(tmp, 'apx-project');
    const teamVars = write(join(tmp, 'team-vars', 'vars.ap'), ['SESSION VAR answer', 'SESSION VAR verdict AS verdict', 'VAR board = Product']);
    const varsFiles = [{ path: teamVars, level: 'team' }];
    const docOf = async name => ApDocument.fromJson((await compile(['    VAR mine', '    DO  read {{answer}} on {{board}}, with {{mine}}', '    DO  decide INTO verdict'], { name, varsFiles })).structure.asJson());
    const docs = { a: await docOf('a'), b: await docOf('b') };
    const BUILD = { builtAt: '', agentPackVersion: '', hash: '' };
    const apx = (agent, ...args) => {
      const lines = [];
      const code = new ApxEngine(docs[agent], BUILD, join(project, apxPath(agent)), l => lines.push(l)).run(args);
      return { out: lines.join('\n'), code };
    };
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
      assert.ok(ls.out.includes('var (3)') && /var-[0-9a-f]{8}  verdict  — SESSION variable shaped as `verdict`, declared in vars\.ap \(team\)/.test(ls.out)
        && /var-[0-9a-f]{8}  mine  — private variable, declared in agent a/.test(ls.out), ls.out);
      let r = apx('a', 'get', 'answer');
      assert.equal(r.code, 0, r.out);
      assert.ok(r.out.includes('SESSION variable') && r.out.includes('read by:\n  agent a') && r.out.endsWith('# value: (empty — nothing stored in this session yet)'), r.out);
      assert.ok(apx('a', 'get', 'verdict').out.includes('used by:\n  agent a'), 'who stores it: the DO … INTO line');
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
      r = apx('a', 'set', 'verdict', '{"decision":"accept"}');
      assert.equal(r.code, 2);
      assert.match(r.out, /the value is not shaped as `verdict`: reason: required field missing — nothing was written/);
      assert.ok(apx('a', 'get', 'verdict').out.endsWith('# value: (empty — nothing stored in this session yet)'), 'a refused value writes nothing');
      assert.match(apx('a', 'set', 'verdict', 'not json').out, /not valid JSON/);
      const verdict = '{"decision":"reject","reason":"two sources disagree"}';
      assert.equal(apx('a', 'set', 'verdict', verdict).code, 0);
      assert.equal(valueOf(apx('a', 'get', 'verdict').out), verdict);

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
      for (const args of [['get', 'answer'], ['set', 'answer', 'x']]) {
        r = apx('a', ...args);
        assert.equal(r.code, 2);
        assert.equal(r.out, `# error: variables need the harness session id, and ${SESSION} is not set — nothing was read or written`);
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
      const priorTabeli = process.env.APX_TABELI;
      process.env.APX_TABELI = fake;
      process.env[SESSION] = 'session-old';
      try {
        r = apx('a', 'set', 'answer', 'x');
        assert.equal(r.code, 2);
        assert.match(r.out, /variables: tabeli v2 or newer is needed, and .*fake-tabeli is v1/, 'the engine that would create the table is checked');
        // a table already there, made by a v1 engine, is checked too: it runs its own engine
        process.env.APX_TABELI = priorTabeli ?? ensure.stdout.trim();
        const old = join(project, '.agent-pack', 'state', 'session-old', 'session.tbl');
        write(old, ['#!/bin/sh', 'echo "# tabeli v1 - fake"', '']);
        chmodSync(old, 0o755);
        assert.match(apx('a', 'get', 'answer').out, /variables: tabeli v2 or newer is needed, and .*session\.tbl is v1/);
      } finally {
        if (priorTabeli === undefined) delete process.env.APX_TABELI; else process.env.APX_TABELI = priorTabeli;
      }
    } finally {
      if (prior === undefined) delete process.env[SESSION]; else process.env[SESSION] = prior;
    }
    console.log('variables: apx tests passed.');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
