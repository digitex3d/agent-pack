// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Executors (I2): who carries out a line. `DO` the agent, `ASK` a delegate,
 * `COMPUTE` a program; on a condition head the stars say it — `IF*` a delegate,
 * `IF**` a program decides. ASK ends with `BY <agent>` to name who it is handed
 * to; ASK and COMPUTE take INTO like DO. A star with a `!` is an error (a
 * condition has one judge), and a starred condition reads at least one variable.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { lexRaw } = await import('../dist/src/lexer.js');
const { lintFile } = await import('../dist/src/lint.js');
const { splitBy } = await import('../dist/src/vars.js');
const { bundleAgentObject, bundleAgentObjectFromConfig } = await import('../dist/src/compiler/index.js');
const { loadConfig } = await import('../dist/src/config.js');
const { openJudgeRun, finishJudgeRun } = await import('../dist/src/judge/phase.js');
const { executorOf, splitExecutorMark } = await import('../dist/src/executor.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { renderTree } = await import('../dist/src/bundlers/renderTree.js');
const refNameOf = shape => shape?.ref?.target?.split('/').pop();

// --- the lexer: stars on IF/UNTIL heads, before or after the `!`s; ASK and COMPUTE are keywords ---
{
  const head = line => { const t = lexRaw(line)[0]; return [t.kind, t.keyword, t.level ?? 0, t.executor ?? 0]; };
  assert.deepEqual(head('IF* {{a}} holds:'), ['keyword', 'IF', 0, 1]);
  assert.deepEqual(head('IF** {{a}} holds:'), ['keyword', 'IF', 0, 2]);
  assert.deepEqual(head('UNTIL** {{a}} holds:'), ['keyword', 'UNTIL', 0, 2]);
  assert.deepEqual(head('IF!* {{a}} holds:'), ['keyword', 'IF', 1, 1], 'bangs then stars');
  assert.deepEqual(head('IF*! {{a}} holds:'), ['keyword', 'IF', 1, 1], 'stars then bangs');
  assert.deepEqual(head('IF! {{a}} holds:'), ['keyword', 'IF', 1, 0], 'a checked head is unchanged');
  assert.equal(lexRaw('IF*** {{a}} holds:')[0].kind, 'unknown', 'three stars are no head');
  assert.deepEqual(head('ASK read {{p}} INTO lines BY legal'), ['keyword', 'ASK', 0, 0]);
  assert.deepEqual(head('COMPUTE sum {{l}} INTO t'), ['keyword', 'COMPUTE', 0, 0]);
  assert.deepEqual(splitBy('check {{c}} INTO risks BY legal-reviewer'), { text: 'check {{c}} INTO risks', name: 'legal-reviewer' });
  assert.equal(splitBy('sort by name'), null, 'a lowercase by is prose');
}

// --- the tree renderer (playbooks, team routing) says the same as the document ---
assert.equal(renderTree('WHEN asked:\n    IF** {{a}} is odd:\n        DO  stop\n    UNTIL* {{b}} holds:\n        DO  retry\n    ASK  explain it BY legal\n    ASK  summarise it'), [
  'When asked:',
  '    If {{a}} is odd — a program decides:',
  '        Do stop',
  '    Until {{b}} holds — a delegate decides:',
  '        Do retry',
  '    Ask a delegate to:',
  '    - explain it — delegate: `legal`',
  '    - summarise it',
].join('\n'));

const tmp = mkdtempSync(join(tmpdir(), 'ap-executors-'));
const write = (file, lines) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };
try {
  const lib = join(tmp, 'library');
  mkdirSync(lib, { recursive: true });
  const dir = join(tmp, 'agents', 'standalone');
  /** The variables the clerk sees: a module of the library exporting each `VAR` line, imported by the agent. */
  let varNames = [];
  const setVars = (lines, root = lib) => {
    varNames = lines.map(l => /^VAR\s+([^\s=]+)/.exec(l)[1]);
    write(join(root, 'vars', 'clerk.ap'), lines.map(l => `EXPORT ${l}`));
  };
  const agent = (...when) => [
    `IMPORT ${varNames.join(', ')} FROM @main.vars`,
    'EXPORT AGENT clerk AS clerk-role:',
    '    ABOUT    clerk',
    '    MANDATE  handle invoices',
    '    WHEN an invoice arrives:',
    ...when.map(l => `        ${l}`),
    '',
    'ROLE clerk-role:',
    '    ABOUT   a clerk',
    '    ALWAYS  check twice',
  ];
  setVars(['VAR pdf_text', 'VAR contract', 'VAR lines', 'VAR risks', 'VAR totals', 'VAR document_total']);

  // --- the lint: the forms are accepted where DO is; a star with a `!`, a COMPUTE with BY, a BY before INTO are errors ---
  {
    const lint = lines => lintFile(join(dir, 'clerk.ap'), agent(...lines).join('\n') + '\n').map(e => e.message);
    assert.deepEqual(lint([
      'ASK      read the invoice lines from {{pdf_text}} INTO lines',
      'ASK      check the clauses of {{contract}} INTO risks BY legal-reviewer',
      'COMPUTE  group {{lines}} by VAT rate INTO totals',
      'IF** {{totals}} differ from {{document_total}}:',
      '    DO  write to the supplier',
      'UNTIL* {{risks}} are all reviewed:',
      '    DO  review the next risk',
    ]), [], 'ASK, COMPUTE, INTO, BY and starred heads lint clean');
    assert.deepEqual(lint(['IF!* {{totals}} is odd:', '    DO  x']), [
      '`IF!*` is not allowed — a condition has one judge: write IF! / IF!! (a judge decides) or IF* / IF** (a delegate or a program decides): "IF!* {{totals}} is odd:"',
    ]);
    assert.deepEqual(lint(['UNTIL**! {{totals}} is odd:', '    DO  x']).length, 1, 'stars then bangs too');
    assert.deepEqual(lint(['COMPUTE  sum {{lines}} BY quick']), ['BY ends only an ASK line — COMPUTE is carried out by a program']);
    assert.deepEqual(lint(['ASK  check {{contract}} BY legal INTO risks']), ['BY legal must end the ASK line — write `ASK … INTO <name> BY legal`']);
    assert.deepEqual(lint(['RUN  check INTO risks']), [], 'RUN takes an INTO: its procedure\'s result');
  }

  // --- the document and the md: who carries out each line ---
  {
    const file = write(join(dir, 'clerk.ap'), agent(
      'ASK      read the invoice lines from {{pdf_text}} INTO lines',
      'ASK      check the clauses of {{contract}} INTO risks BY legal-reviewer',
      'COMPUTE  group {{lines}} by VAT rate INTO totals',
      'COMPUTE  round the totals',
      'IF** {{totals}} differ from {{document_total}}:',
      '    DO  write to the supplier',
      'UNTIL* {{risks}} are all reviewed:',
      '    DO  review the next risk',
    ));
    const opts = { agentName: 'clerk', agentFile: file, agentDir: dir, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } };
    const { body, structure } = await bundleAgentObject(opts);
    const text = l => [l.primitive, l.text];
    assert.deepEqual(structure.lines('ASK').map(text), [['ASK', 'read the invoice lines from {{pdf_text}}'], ['ASK', 'check the clauses of {{contract}}']],
      'an ASK line\'s text keeps neither its INTO nor its BY');
    assert.deepEqual(structure.lines('COMPUTE').map(text), [['COMPUTE', 'group {{lines}} by VAT rate'], ['COMPUTE', 'round the totals']]);
    const nodes = structure.lines().filter(l => ['ASK', 'COMPUTE', 'IF', 'UNTIL'].includes(l.primitive));
    const json = JSON.parse(structure.asJson());
    const flat = []; JSON.stringify(json, (k, v) => { if (v && typeof v === 'object' && (v.type === 'directive' || v.type === 'if' || v.type === 'until')) flat.push(v); return v; });
    assert.equal(flat.find(n => n.keyword === 'ASK' && n.by)?.by, 'legal-reviewer', 'the BY agent is kept on the node');
    assert.equal(flat.find(n => n.type === 'if')?.executor, 2, 'IF** — a program decides');
    assert.equal(flat.find(n => n.type === 'until')?.executor, 1, 'UNTIL* — a delegate decides');
    assert.ok(!flat.find(n => n.type === 'if')?.check, 'a starred head is never also checked');
    assert.equal(nodes.length, 6);
    const plain = body.replace(/ \(read its value: `[^`]*`\)/g, '').replace(/node \S+\.apx/g, 'apx');
    for (const line of [
      'Ask a delegate to read the invoice lines from `pdf_text`',
      'Ask a delegate to check the clauses of `contract` — delegate: `legal-reviewer`',
      'Have a program group `lines` by VAT rate',
      'Have a program round the totals',
      'If `totals` differ from `document_total` — a program decides — `apx run exe-',
      'Until `risks` are all reviewed — a delegate decides — hand it over its input and the shape of its answer, both from `apx input exe-',
      'Ask a delegate to read the invoice lines from `pdf_text` — delegate: `quick` — hand it over its input and the shape of its answer, both from `apx input exe-',
      'Have a program group `lines` by VAT rate — `apx run exe-',
    ]) assert.ok(plain.includes(line), `the md says: ${line}`);
    assert.ok(!/store the result as `(lines|risks|totals)`/.test(plain), 'answer / run store the result: no set to tell');

    // A starred condition reads at least one variable: its only input.
    write(join(dir, 'clerk.ap'), agent('IF* the mood is good:', '    DO  smile'));
    await assert.rejects(bundleAgentObject(opts), /IF\*: a condition a delegate or a program decides reads at least one variable/);
  }
  // --- PROCEDURE* / PROCEDURE**: the mark carries the body; a line may raise it, never lower it ---
  {
    assert.deepEqual(splitExecutorMark('PROCEDURE**'), { word: 'PROCEDURE', executor: 2 });
    assert.deepEqual(splitExecutorMark('PROCEDURE'), { word: 'PROCEDURE', executor: 0 });
    write(join(lib, 'procedures', 'totals.ap'), [
      'IMPORT lines FROM @main.vars', '', 'EXPORT PROCEDURE** vat-totals:', '    ABOUT  totals by VAT rate', '    DO  group {{lines}} by VAT rate',
      '    IF {{lines}} has an exempt line:', '        DO  add the stamp duty', '    COMPUTE  round every row to the cent',
    ]);
    assert.deepEqual(lintFile(join(lib, 'procedures', 'totals.ap'), readFileSync(join(lib, 'procedures', 'totals.ap'), 'utf-8')), [], 'an exported PROCEDURE** lints clean');
    assert.deepEqual(lintFile(join(lib, 'policies', 'p.ap'), 'EXPORT POLICY* careful:\n    ABOUT  x\n    ALWAYS  be careful\n').map(e => e.message),
      ['`POLICY*`: only a PROCEDURE head takes an executor mark — a delegate (*) or a program (**) carries its body out']);
    const procs = body => write(join(dir, 'clerk.ap'), [
      'IMPORT vat-totals FROM @main.procedures', '',
      ...agent('RUN  vat-totals', 'ASK  explain {{lines}}', 'DO  file it'), '',
      ...body,
      '', 'PROCEDURE chat:', '    DO  talk to the user',
    ]);
    const opts = { agentName: 'clerk', agentFile: join(dir, 'clerk.ap'), agentDir: dir, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } };
    procs(['PROCEDURE* tidy:', '    DO  tidy {{lines}}', '    COMPUTE  count {{lines}} INTO totals', '    IF** {{totals}} is zero:', '        DO  stop', '    RUN  vat-totals']);
    const { body, structure } = await bundleAgentObject(opts);
    const proc = name => structure.all().find(b => b.kind === 'procedure' && b.name === name);
    assert.equal(proc('vat-totals').executor, 2, 'EXPORT PROCEDURE** — imported, the mark travels with it');
    assert.equal(proc('tidy').executor, 1, 'PROCEDURE* — inline in the agent file');
    assert.equal(proc('chat').executor, null);
    assert.equal(ApDocument.fromJson(structure.asJson()).all().find(b => b.name === 'vat-totals').executor, 2, 'the mark survives the .ap.json round trip');
    const of = (primitive, text) => executorOf(structure.lines(primitive).find(l => l.text.startsWith(text)));
    assert.equal(of('DO', 'group'), 2, 'a DO inherits PROCEDURE**');
    assert.equal(of('DO', 'tidy'), 1, 'a DO inherits PROCEDURE*');
    assert.equal(of('COMPUTE', 'count'), 2, 'a COMPUTE raises PROCEDURE* to a program');
    assert.equal(of('ASK', 'explain'), 1, 'an ASK of the agent is a delegate');
    assert.equal(of('DO', 'file it'), 0, 'a DO of the agent is the agent');
    assert.equal(of('DO', 'talk'), 0, 'a plain procedure is the agent');
    const plain = body.replace(/ \(read its value: `[^`]*`\)/g, '').replace(/ — `node \S+\.apx run exe-[0-9a-f]+`| — hand it over its input and the shape of its answer, both from `node [^`]+`, then store its answer: `node [^`]+`/g, '');
    assert.ok(plain.includes('A program carries out this procedure — never carry it out yourself.\nDo group `lines` by VAT rate'));
    assert.ok(plain.includes('A delegate carries out this procedure — never carry it out yourself.\nDo tidy `lines`'));
    assert.ok(plain.includes('If `lines` has an exempt line — a program decides:'), 'an unmarked condition inside PROCEDURE** is the program\'s too, and says so');

    procs(['PROCEDURE** messy:', '    DO  sum {{lines}}', '    ASK  explain {{lines}}', '    IF* {{lines}} look odd:', '        DO  flag them',
      '    IF! {{lines}} are complete:', '        DO  go on', '    RUN  chat']);
    const messages = await bundleAgentObject(opts).then(() => [], e => e.message.split('\n').slice(1).map(l => l.replace(/^error\s+\S+\s+/, '')));
    assert.deepEqual(messages.sort(), [
      'ASK is not allowed under PROCEDURE** `messy` — a line may raise its executor (agent → delegate → program), never lower it',
      'IF! is not allowed under PROCEDURE** `messy` — its executor decides its conditions: write IF or IF**',
      'IF* is not allowed under PROCEDURE** `messy` — a condition may raise its executor (agent → delegate → program), never lower it',
      'RUN chat: under PROCEDURE** `messy` only a PROCEDURE** may be run — a program cannot stop for the agent',
    ]);
    procs(['PROCEDURE* soft:', '    RUN  chat']);
    await assert.rejects(bundleAgentObject(opts), /RUN chat: under PROCEDURE\* `soft` only a PROCEDURE\* or PROCEDURE\*\* may be run — a delegate cannot hand the work back/);
  }

  // --- COMPUTE <name>: a procedure a program carries out, in three required sections ---
  {
    write(join(lib, 'templates', 'dose-result.ap'), [
      'EXPORT TEMPLATE dose-result:', '    ABOUT  a dose', '    SLOTS:', '        mg:  NUMBER  "mg"', '        ml:  NUMBER  "ml"', '    BODY:', '        {mg} mg, {ml} ml',
    ]);
    const DOSE = [
      'IMPORT dose-result FROM @main.templates', 'IMPORT weight_kg, mg_per_kg, mg_per_ml FROM @main.vars',
      'EXPORT COMPUTE dose:', '    ABOUT  pediatric dose by weight', '    NEVER  read a file, the network or the clock',
      '    REQUIRE:', '        MUST  {{weight_kg}} be between 2 and 80, bounds included', '        IF {{mg_per_ml}} is given:', '            MUST  it be above 0',
      '    RETURN AS dose-result:', '        DO  mg = {{weight_kg}} × {{mg_per_kg}}', '        DO  ml = mg / {{mg_per_ml}}',
      '    ENSURE:', '        MUST  ml be rounded half up to 2 decimals',
    ];
    const doseFile = write(join(lib, 'procedures', 'dose.ap'), DOSE);
    const lintDose = lines => lintFile(doseFile, lines.join('\n') + '\n').map(e => e.message);
    assert.deepEqual(lintDose(DOSE), [], 'a COMPUTE block lints clean');
    assert.deepEqual(lintDose(DOSE.slice(0, 12)), ['COMPUTE `dose` needs its ENSURE section — REQUIRE:, RETURN AS <template>: and ENSURE:, in this order']);
    assert.deepEqual(lintDose(DOSE.map(l => l.replace('RETURN AS dose-result:', 'RETURN:'))), ['RETURN in COMPUTE `dose` needs its result shape — write `RETURN AS <template>:`']);
    assert.deepEqual(lintDose(DOSE.map(l => l.replace('RETURN AS dose-result:', 'RETURN AS! dose-result:'))), ['RETURN AS takes no force level — the program\'s result is always checked against its template']);
    assert.deepEqual(lintDose([...DOSE.slice(0, 7), '        DO  convert pounds to kg', ...DOSE.slice(7)]), ['DO is not allowed in REQUIRE of COMPUTE `dose` — it holds only rules (MUST, NEVER, …) and IF']);
    assert.deepEqual(lintDose([...DOSE.slice(0, 12), '        ASK  explain it', ...DOSE.slice(12)]), ['ASK is not allowed in RETURN of COMPUTE `dose` — a program carries it out: DO, COMPUTE, IF, UNTIL and rules only']);
    assert.deepEqual(lintDose(['EXPORT COMPUTE dose:', '    ABOUT  x', '    REQUIRE:', '    RETURN AS dose-result:', '        DO  y', '    ENSURE:', '        MUST  z']), ['REQUIRE in COMPUTE `dose` holds no line — write at least one']);
    const swapped = lintDose([...DOSE.slice(0, 5), ...DOSE.slice(9, 12), ...DOSE.slice(5, 9), ...DOSE.slice(12)]);
    assert.ok(swapped.length > 0 && swapped.every(m => /out of order or repeated/.test(m)), 'sections out of order');
    assert.deepEqual(lintFile(join(lib, 'procedures', 'p.ap'), 'EXPORT PROCEDURE p:\n    ABOUT  x\n    ENSURE:\n        MUST  be fine\n    DO  y\n').map(e => e.message),
      ['ENSURE is a section of a COMPUTE block — found inside PROCEDURE']);

    setVars(['VAR pdf_text', 'VAR contract', 'VAR lines', 'VAR risks', 'VAR totals', 'VAR document_total', 'VAR weight_kg', 'VAR mg_per_kg', 'VAR mg_per_ml', 'VAR result']);
    write(join(dir, 'clerk.ap'), ['IMPORT dose FROM @main.procedures', '', ...agent('VAR result:', '    RUN  dose', 'DO  show {{result}} to the doctor')]);
    const opts = { agentName: 'clerk', agentFile: join(dir, 'clerk.ap'), agentDir: dir, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } };
    const { body, structure } = await bundleAgentObject(opts);
    const dose = structure.all().find(b => b.name === 'dose');
    assert.equal(dose.kind, 'procedure', 'a COMPUTE block is a procedure…');
    assert.equal(dose.executor, 2, '…a program carries out');
    assert.equal(refNameOf(dose.shape), 'dose-result', 'RETURN AS is its result shape');
    assert.deepEqual(dose.require.map(n => n.type === 'directive' ? `${n.keyword} ${n.text}` : n.type), ['MUST {{weight_kg}} be between 2 and 80, bounds included', 'if']);
    assert.deepEqual(dose.ensure.map(n => `${n.keyword} ${n.text}`), ['MUST ml be rounded half up to 2 decimals']);
    assert.deepEqual(structure.lines('MUST').filter(l => l.block === dose).map(l => l.text),
      ['{{weight_kg}} be between 2 and 80, bounds included', 'it be above 0', 'ml be rounded half up to 2 decimals'], 'the section lines are document lines: the judge sees them');
    const back = ApDocument.fromJson(structure.asJson()).all().find(b => b.name === 'dose');
    assert.equal(back.require.length, 2, 'the sections survive the .ap.json round trip');
    const md = body.replace(/ \(read its value: `[^`]*`\)/g, '').replace(/ \((tpl|prc)-[0-9a-f]+\)/g, '').replace(/ — `node \S+\.apx run exe-[0-9a-f]+`/g, '');
    const start = md.indexOf('## `dose`');
    const section = md.slice(start, md.indexOf('\n#', start + 3));
    assert.deepEqual(section.trim().split('\n').slice(1), [
      'A program carries out this procedure — never carry it out yourself.',
      'You must never read a file, the network or the clock',
      'The program refuses the input — it stops with an error — unless:',
      '    It requires that `weight_kg` be between 2 and 80, bounds included',
      '    If `mg_per_ml` is given — a program decides:',
      '        It requires that it be above 0',
      'It computes:',
      'Shape your response as `dose-result`',
      '    Do:',
      '    - mg = `weight_kg` × `mg_per_kg`',
      '    - ml = mg / `mg_per_ml`',
      'It guarantees on its result:',
      '    It ensures that ml be rounded half up to 2 decimals',
    ], 'the md: rules on top, when it refuses, what it computes, what it guarantees');
    setVars(['VAR pdf_text', 'VAR contract', 'VAR lines', 'VAR risks', 'VAR totals', 'VAR document_total']);
  }

  // --- the contracts: what each delegate or program receives and answers (meta.executors) ---
  {
    setVars(['VAR tolerance = 0.01', 'VAR pdf_text', 'VAR totals', 'VAR document_total', 'VAR weight_kg', 'VAR mg_per_kg', 'VAR mg_per_ml', 'VAR result AS dose-result', 'VAR flag']);
    write(join(dir, 'clerk.ap'), ['IMPORT dose FROM @main.procedures', '', ...agent(
      'ASK      read the document total from {{pdf_text}} INTO document_total',
      'COMPUTE  estimate a dose from {{weight_kg}} INTO result',
      'IF** {{totals}} differ from {{document_total}} by more than {{tolerance}}:',
      '    DO  write to the supplier',
      'VAR result:', '    RUN  dose',
    ), '', 'PROCEDURE* check:', '    DO  look at {{pdf_text}}', '    COMPUTE  count the lines of {{pdf_text}} INTO flag', '    IF* {{flag}} is odd:', '        DO  say so']);
    const opts = { agentName: 'clerk', agentFile: join(dir, 'clerk.ap'), agentDir: dir, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } };
    const { structure } = await bundleAgentObject(opts);
    const specs = Object.values(structure.meta.executors);
    assert.ok(Object.keys(structure.meta.executors).every(id => /^exe-[0-9a-f]{8}$/.test(id)), 'ids are exe-…');
    const raw = (site, text) => specs.find(s => s.site === site && s.text.startsWith(text));
    // The program's folder and a procedure's lineage are checked apart: the rest is the contract.
    const find = (site, text) => { const s = raw(site, text); if (!s) return s; const { program, lineage, ...rest } = s; return rest; };
    assert.ok(/^dst-[0-9a-f]{8}$/.test(raw('condition', '{{totals}}').program), 'a program\'s piece names its folder');
    assert.equal(raw('line', 'read the document total').program, undefined, 'a delegate\'s piece has none');
    assert.ok(raw('procedure', 'dose').lineage.endsWith('/dose'), 'a procedure keeps its lineage: its address');
    assert.deepEqual(find('line', 'read the document total'), {
      executor: 1, site: 'line', text: 'read the document total from {{pdf_text}}',
      input: { vars: ['pdf_text'], constants: {} }, output: { into: 'document_total' },
    });
    assert.deepEqual(find('line', 'estimate').output, { into: 'result', template: 'dose-result' }, 'a typed INTO variable gives its template');
    assert.deepEqual(find('condition', '{{totals}}'), {
      executor: 2, site: 'condition', text: '{{totals}} differ from {{document_total}} by more than {{tolerance}}',
      input: { vars: ['totals', 'document_total'], constants: { tolerance: '0.01' } }, output: { holds: true },
    }, 'a constant is an input key with its value known now');
    assert.deepEqual(find('procedure', 'dose'), {
      executor: 2, site: 'procedure', text: 'dose',
      input: { vars: ['weight_kg', 'mg_per_ml', 'mg_per_kg'], constants: {} }, output: { template: 'dose-result' },
    }, 'a COMPUTE block: every read of its sections, its RETURN AS template');
    assert.equal(find('procedure', 'check').executor, 1);
    assert.equal(find('line', 'count the lines').executor, 2, 'a COMPUTE inside PROCEDURE* raises: its own contract');
    assert.ok(!find('condition', '{{flag}}'), 'IF* inside PROCEDURE* is the procedure\'s own work');
    assert.ok(!find('line', 'look at'), 'a DO is never a contract');
    setVars(['VAR pdf_text', 'VAR contract', 'VAR lines', 'VAR risks', 'VAR totals', 'VAR document_total']);
  }

  // --- ASK … BY: a standalone agent or a team; a team member only from inside its own team ---
  {
    const proj = join(tmp, 'proj');
    const member = (dir, name) => write(join(proj, dir, `${name}.ap`), [
      `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work',
      '    WHEN asked:', `        ASK  check the contract BY {target}`, '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  do the work',
    ]);
    write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
    mkdirSync(join(proj, 'library'), { recursive: true });
    write(join(proj, 'agents', 'teams', 'legal', 'flows.ap'), ['# legal', 'ABOUT  the legal team']);
    write(join(proj, 'agents', 'teams', 'ops', 'flows.ap'), ['# ops', 'ABOUT  the ops team']);
    const prevCwd = process.cwd();
    process.chdir(proj);
    try {
      const target = (who, dir, name) => {
        const file = member(dir, who);
        writeFileSync(file, readFileSync(file, 'utf-8').replace('{target}', name));
      };
      for (const [who, dir] of [['clerk', 'agents/standalone'], ['auditor', 'agents/standalone'], ['reader', 'agents/teams/legal'], ['scribe', 'agents/teams/legal'], ['bot', 'agents/teams/ops']]) {
        target(who, dir, 'auditor');
      }
      const config = await loadConfig([]);
      const bundle = name => bundleAgentObjectFromConfig(name, config);
      const by = async (who, dir, name) => { target(who, dir, name); return bundle(who); };
      await by('clerk', 'agents/standalone', 'auditor');
      await by('clerk', 'agents/standalone', 'legal');
      await assert.rejects(by('clerk', 'agents/standalone', 'reader'), /BY reader: `reader` is a member of team `legal` — ASK names a standalone agent, a team, or a member of its own team/);
      await assert.rejects(by('clerk', 'agents/standalone', 'ghost'), /unknown agent `ghost` — ASK … BY names a standalone agent or a team of the project/);
      await by('scribe', 'agents/teams/legal', 'reader');
      await assert.rejects(by('bot', 'agents/teams/ops', 'reader'), /`reader` is a member of team `legal`/);
    } finally {
      process.chdir(prevCwd);
    }
  }
  // --- an imported playbook: its `COMPUTE …` line (no colon) stays a line, never a COMPUTE block ---
  {
    write(join(lib, 'playbooks', 'triage.ap'), ['EXPORT PLAYBOOK triage:', '    ABOUT  triage an issue', '    DO     read the issue', '    COMPUTE  count the comments of the issue']);
    const file = write(join(dir, 'triager.ap'), ['IMPORT triage FROM @main.playbooks', '', 'EXPORT AGENT triager:', '    ABOUT    triager', '    MANDATE  triage']);
    const { body, structure } = await bundleAgentObject({ agentName: 'triager', agentFile: file, agentDir: dir, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
    assert.ok(body.includes('Have a program count the comments of the issue'), body);
    assert.ok(!structure.byKind('procedure').some(b => b.name === 'count'), 'no procedure named after the line\'s first word');
  }

  // --- the judge: a #executed rule judges only what a delegate or a program carries out, a #program rule only a program's,
  // an #agent rule only the agent's own ---
  {
    const proj = join(tmp, 'judged');
    write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],",
      "  judge: { adapter: { type: 'judge', name: 'fake', ask: (...a) => globalThis.__executedAsk(...a) } },", '};']);
    const rule = (name, tag, force = 'NEVER', layout = '{line}') => write(join(proj, 'library', 'templates', `${name}.ap`), [
      `EXPORT TEMPLATE ${name}:`, '  ABOUT  test rule', `  TAGS   #judge ${tag}`, '  SLOTS:', '    line: TEXT  "a line"', `      ${force}  name a planet`, '  BODY:', `    ${layout}`,
    ]);
    rule('t-executed', '#executed');
    rule('t-program', '#program');
    rule('t-agent', '#agent', 'SHOULD-NOT', 'DO {line}');
    write(join(proj, 'library', 'templates', 'r.ap'), ['EXPORT TEMPLATE r:', '  ABOUT  r', '  SLOTS:', '    v:  NUMBER  "v"', '  BODY:', '    {v}']);
    setVars(['VAR a', 'VAR b'], join(proj, 'library'));
    write(join(proj, 'agents', 'standalone', 'clerk.ap'), [
      'IMPORT r FROM @main.templates', '',
      ...agent('DO  talk to the user', 'ASK  summarise {{a}}', 'IF** {{b}} is odd:', '    DO  say so', 'RUN  twice'), '',
      'PROCEDURE* soft:', '    DO  look at {{a}}', '',
      'COMPUTE twice:', '    REQUIRE:', '        MUST  {{b}} be a number', '    RETURN AS r:', '        DO  v = 2 × {{b}}', '    ENSURE:', '        MUST  v be even',
    ]);
    const seen = { 't-executed': [], 't-program': [], 't-agent': [] };
    globalThis.__executedAsk = async (state, checks, model) => {
      for (const c of checks) if (c.id.startsWith('t-')) seen[c.id.split('.')[0]].push(JSON.parse(state).line);
      return { model: model ?? 'fake-1.0', answers: Object.fromEntries(checks.map(c => [c.id, 0.95])) };
    };
    const prevCwd = process.cwd();
    process.chdir(proj);
    try {
      const config = await loadConfig([]);
      const run = openJudgeRun(config, proj);
      await bundleAgentObjectFromConfig('clerk', config, { judge: run });
      await finishJudgeRun(run, { prune: false });
      assert.deepEqual(seen['t-executed'].sort(), ['b is odd', 'b be a number', 'look at a', 'summarise a', 'v = 2 × b', 'v be even'].sort(),
        '#executed: the ASK, the IF**, the PROCEDURE* body and every COMPUTE section — never the agent\'s DO, never a RUN');
      assert.deepEqual(seen['t-program'].sort(), ['b is odd', 'b be a number', 'v = 2 × b', 'v be even'].sort(), '#program: only what a program carries out');
      // #agent: the DO lines the agent carries out itself — never a delegate's or a program's, never a shipped
      // procedure's (write-program is judged in agent-pack's own build, not in a project's).
      assert.deepEqual(seen['t-agent'].sort(), ['say so', 'talk to the user'], '#agent: only the agent\'s own DO lines');
    } finally {
      process.chdir(prevCwd);
      delete globalThis.__executedAsk;
    }
  }
  console.log('executors: passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
