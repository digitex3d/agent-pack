// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Programs and delegates at run time (I2): what a delegate or a program carries
 * out has a contract (`exe-…`), and the apx is the only way through it.
 * `input` gives what the piece receives; a delegate's answer goes back with
 * `answer`, checked against the contract and stored; a program — written by the
 * agent at the first run, in `distilled/<dst-id>/` with its manifest and tests —
 * runs with `run`: its tests first when it is new, then the program. A refusal
 * (exit ≠ 0) stops the procedure; a timeout hands that one run to the agent.
 * Every run and answer is recorded in the session. No network, no model.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = resolve(fileURLToPath(import.meta.url), '../../dist/index.js');
const root = mkdtempSync(join(tmpdir(), 'ap-programs-'));
const write = (file, lines) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, lines.join('\n') + '\n'); return file; };
const bundle = () => spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: root, encoding: 'utf-8' });
const apx = (args, input) => {
  const r = spawnSync(process.execPath, [join(root, '.agent-pack', 'apx', 'clerk.apx'), ...args], {
    cwd: root, encoding: 'utf-8', input, env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** The JSON part of `apx input` — what follows it is the answer's shape. */
const inputOf = id => JSON.parse(apx(['input', id]).out.split('\n# answer')[0]);
const program = (dir, script, manifest, tests) => {
  const folder = join(root, 'distilled', dir);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'script.js'), `#!/usr/bin/env node\nconst i = JSON.parse(require('fs').readFileSync(0, 'utf8'));\n${script}\n`);
  chmodSync(join(folder, 'script.js'), 0o755);
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(folder, 'tests.json'), JSON.stringify(tests));
  return folder;
};

try {
  write(join(root, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
  write(join(root, 'library', 'templates', 'dose-result.ap'), [
    'EXPORT TEMPLATE dose-result:', '    ABOUT  a dose', '    SLOTS:', '        mg:  NUMBER  "mg"', '    BODY:', '        {mg} mg',
  ]);
  write(join(root, 'library', 'vars', 'clerk.ap'), ['EXPORT VAR tolerance = 1', 'EXPORT VAR totals', 'EXPORT VAR document_total', 'EXPORT VAR weight_kg', 'EXPORT VAR dose AS dose-result', 'EXPORT VAR summary']);
  const AGENT = [
    'IMPORT dose-result FROM @main.templates', 'IMPORT tolerance, totals, document_total, weight_kg, dose, summary FROM @main.vars',
    'EXPORT AGENT clerk AS clerk-role:', '    ABOUT    clerk', '    MANDATE  check invoices',
    '    WHEN an invoice arrives:',
    '        ASK  summarise the invoice for {{weight_kg}} INTO summary',
    '        ASK  note anything odd about {{weight_kg}}',
    '        IF** {{totals}} differ from {{document_total}} by more than {{tolerance}} cent:',
    '            DO  write to the supplier',
    '        VAR dose:', '            RUN  pediatric',
    '        UNTIL* {{summary}} is short enough:', '            DO  shorten it',
    '        ASK  estimate a dose for {{weight_kg}} INTO dose', '',
    'ROLE clerk-role:', '    ABOUT   a clerk', '    ALWAYS  check twice', '',
    'COMPUTE pediatric:', '    REQUIRE:', '        MUST  {{weight_kg}} be between 2 and 80', '    RETURN AS dose-result:', '        DO  mg = {{weight_kg}} × 15', '    ENSURE:', '        MUST  mg be a whole number',
  ];
  write(join(root, 'agents', 'standalone', 'clerk.ap'), AGENT);
  let built = bundle();
  assert.equal(built.status, 0, built.stderr);

  const doc = JSON.parse(readFileSync(join(root, '.agent-pack', 'compiled', 'clerk.ap.json'), 'utf-8'));
  const specs = Object.entries(doc.meta.executors);
  const [cond] = specs.find(([, s]) => s.site === 'condition');
  const [ask] = specs.find(([, s]) => s.site === 'line');
  const [proc, procSpec] = specs.find(([, s]) => s.site === 'procedure');
  const condSpec = doc.meta.executors[cond];

  // --- the default delegate: an ASK without BY is handed to `quick`, shipped with the package, bundled with the project ---
  const quickMd = readFileSync(join(root, '.claude', 'agents', 'quick.md'), 'utf-8');
  assert.ok(/^model: haiku$/m.test(quickMd), 'quick runs on a fast model on Claude Code');
  assert.ok(/^tools: \[\]$/m.test(quickMd), 'quick gets no tool: it answers from the input it is handed alone');
  const clerkMd = readFileSync(join(root, '.claude', 'agents', 'clerk.md'), 'utf-8');
  assert.ok(clerkMd.includes('— delegate: `quick` — hand it over its input and the shape of its answer, both from `node .agent-pack/apx/clerk.apx input exe-'), 'the prompt names the default delegate and how to hand it over');
  assert.ok(/^model: inherit$/m.test(clerkMd), 'any other agent inherits the session\'s model');
  assert.ok(/^tools: "\*"$/m.test(clerkMd) || /^tools: \*$/m.test(clerkMd), 'any other agent keeps its tools');

  // --- scope: every contract, and whether its program is written yet ---
  const scope = apx(['scope']).out;
  assert.ok(scope.includes(`${cond}  a program  condition:`) && scope.includes('(no program yet)'), scope);
  assert.ok(scope.includes(`${ask}  a delegate  line: summarise the invoice for {{weight_kg}}`));

  // --- input: one key per variable read (as stored) and per constant (with its value) ---
  assert.equal(apx(['input', cond]).code, 1, 'an empty variable: nothing to carry out yet');
  apx(['set', 'totals', '349.48']);
  apx(['set', 'document_total', '350.48']);
  assert.deepEqual(inputOf(cond), { tolerance: 1, totals: 349.48, document_total: 350.48 });
  assert.ok(apx(['input', cond]).out.endsWith('# answer: {"holds": true | false} — JSON only\n'), 'a condition\'s answer shape');

  // --- run, first time: no program yet — where to write it, and its contract ---
  let r = apx(['run', cond]);
  assert.equal(r.code, 10);
  assert.ok(r.out.includes(`no program yet for ${cond} — write it now, in distilled/${condSpec.program}/ at the project root (beside .agent-pack/): manifest.json, the script, tests.json`), r.out);
  assert.ok(r.out.includes('tests.json: [{"why": "…", "input": {…}, "output": <the JSON it must answer>}, {"why": "…", "input": {…}, "exit": 1}]'), 'the formats are told, not to be guessed');
  const writer = r.out.match(/how: node \.agent-pack\/apx\/clerk\.apx get (prc-[0-9a-f]{8})/)?.[1];
  assert.ok(writer, `the apx says how to write it: ${r.out}`);
  assert.ok(apx(['get', writer]).out.includes('# procedure write-program'), 'an agent a program works for gets the write-program procedure, from @builtin');

  // --- the agent writes it; a new program runs its own tests first, then the program ---
  const condDir = program(condSpec.program,
    "if (typeof i.totals !== 'number') { console.error('totals must be a number'); process.exit(1); }\nconsole.log(JSON.stringify({ holds: Math.abs(Math.round(i.totals * 100) - Math.round(i.document_total * 100)) > i.tolerance }));",
    { version: 1, timeout_ms: 2000 },
    [{ why: '1 euro off', input: { tolerance: 1, totals: 1, document_total: 2 }, output: { holds: true } },
     { why: 'CHOICE: 1 cent apart does not count', input: { tolerance: 1, totals: 1, document_total: 1.01 }, output: { holds: false } },
     { why: 'text is refused', input: { tolerance: 1, totals: 'x', document_total: 1 }, exit: 1 }]);
  r = apx(['run', cond]);
  assert.deepEqual([r.code, JSON.parse(r.out)], [0, { holds: true }]);
  assert.ok(JSON.parse(readFileSync(join(condDir, 'manifest.json'), 'utf-8')).tested, 'its passing tests are recorded in the manifest');
  assert.ok(apx(['scope']).out.includes('(program ready)'));

  // --- a refusal stops the procedure; the agent never carries the piece out ---
  apx(['set', 'totals', '"abc"']);
  r = apx(['run', cond]);
  assert.equal(r.code, 3);
  assert.ok(r.out.includes('refused its input (exit 1: totals must be a number) — stop the procedure and report it; never carry this piece out yourself'), r.out);
  apx(['set', 'totals', '349.48']);

  // --- a test that fails blocks the program until it is fixed ---
  const tests = JSON.parse(readFileSync(join(condDir, 'tests.json'), 'utf-8'));
  writeFileSync(join(condDir, 'tests.json'), JSON.stringify([{ ...tests[1], output: { holds: true } }]));
  r = apx(['run', cond]);
  assert.equal(r.code, 6);
  assert.ok(r.out.includes('fails its own test "CHOICE: 1 cent apart does not count": it answered {"holds":false}'), r.out);
  writeFileSync(join(condDir, 'tests.json'), JSON.stringify(tests));

  // --- a test too slow for the manifest's timeout: the timeout is to fix, not the program ---
  writeFileSync(join(condDir, 'manifest.json'), JSON.stringify({ version: 1, timeout_ms: 1 }));
  r = apx(['run', cond]);
  assert.equal(r.code, 6);
  assert.ok(r.out.includes('did not answer its test "1 euro off" within 1 ms — raise timeout_ms in'), r.out);
  writeFileSync(join(condDir, 'manifest.json'), JSON.stringify({ version: 1, timeout_ms: 2000 }));

  // --- a timeout hands this one run to the agent ---
  const slow = readFileSync(join(condDir, 'script.js'), 'utf-8');
  writeFileSync(join(condDir, 'script.js'), slow.replace("console.log(JSON.stringify({ holds:", "if (i.totals === 349.48) { const t = Date.now(); while (Date.now() - t < 3000); }\nconsole.log(JSON.stringify({ holds:"));
  writeFileSync(join(condDir, 'manifest.json'), JSON.stringify({ version: 1, timeout_ms: 500 }));
  r = apx(['run', cond]);
  assert.equal(r.code, 4);
  assert.ok(r.out.includes('did not answer within 500 ms — carry this one out yourself, and say so'), r.out);
  writeFileSync(join(condDir, 'script.js'), slow);
  writeFileSync(join(condDir, 'manifest.json'), JSON.stringify({ version: 1, timeout_ms: 2000 }));

  // --- a delegate: its answer is checked against the contract, stored, recorded ---
  apx(['set', 'weight_kg', '18']);
  assert.deepEqual(inputOf(ask), { weight_kg: 18 });
  assert.ok(apx(['input', ask]).out.endsWith('# answer: plain text\n'), 'an untyped variable takes plain text');
  r = apx(['answer', ask, '-'], 'An invoice for 18 kg.');
  assert.equal(r.code, 0, r.out);
  assert.ok(apx(['get', 'summary']).out.includes('# value:\nAn invoice for 18 kg.'), 'stored as written in its INTO variable — no JSON needed');
  // A typed variable: the delegate is handed its template, AS <template>, with an example to fill.
  const [estimate] = specs.find(([, s]) => s.site === 'line' && s.text.startsWith('estimate a dose'));
  assert.ok(apx(['input', estimate]).out.endsWith('# answer AS `dose-result` — JSON only, shaped like:\n{"mg":0}\n'), apx(['input', estimate]).out);
  assert.equal(apx(['answer', estimate, '-'], 'about 270 mg').code, 6, 'a typed answer must be its JSON');
  assert.equal(apx(['answer', estimate, '-'], '{"mg": 270}').code, 0);
  assert.equal(apx(['answer', cond, '-'], '{"holds":true}').code, 1, 'a program\'s piece takes no answer');
  // A delegated line that stores nothing takes any answer — prose included — and records it.
  const [note] = specs.find(([, s]) => s.site === 'line' && s.text.startsWith('note anything odd'));
  r = apx(['answer', note, '-'], 'Nothing odd: the weight is plausible.');
  assert.equal(r.code, 0, r.out);
  assert.equal(apx(['run', ask]).code, 1, 'a delegate\'s piece has no program');

  // --- an UNTIL*: the loop runs at most checks.rounds rounds (3 by default), its condition asked after each one ---
  const [loop] = specs.find(([, s]) => s.site === 'condition' && s.text.includes('short enough'));
  assert.equal(doc.meta.executors[loop].rounds, 3);
  assert.ok(clerkMd.includes(`answer ${loop} -\`; after each round, ask again — at most 3 rounds: at the limit, stop and report that the condition never held`), clerkMd);
  r = apx(['answer', loop, '-'], '{"holds":false}');
  assert.ok(r.out.includes('# round 1 of 3 — do the next round, then ask again'), r.out);
  assert.ok(apx(['answer', loop, '-'], '{"holds":false}').out.includes('# round 2 of 3'));
  r = apx(['answer', loop, '-'], '{"holds":false}');
  assert.ok(r.out.includes('# round limit reached (3 of 3): stop and report that the condition never held'), r.out);
  assert.equal(r.code, 7, 'at the limit the loop ends: an exit of its own, so a chained command never runs another round');
  r = apx(['answer', loop, '-'], '{"holds":true}');
  assert.ok(!r.out.includes('round'), 'it holds: the loop ends');
  assert.ok(apx(['answer', loop, '-'], '{"holds":false}').out.includes('# round 1 of 3'), 'a new loop counts from its first round');

  // --- a COMPUTE block: its program answers in its RETURN AS template ---
  r = apx(['run', proc]);
  assert.equal(r.code, 10);
  const procDir = program(procSpec.program,
    "if (i.weight_kg < 2 || i.weight_kg > 80) { console.error('weight outside 2-80'); process.exit(1); }\nconsole.log(JSON.stringify({ mg: i.weight_kg * 15 }));",
    { version: 1, timeout_ms: 2000, lineage: procSpec.lineage },
    [{ why: 'normal', input: { weight_kg: 18 }, output: { mg: 270 } }, { why: 'too heavy', input: { weight_kg: 95 }, exit: 1 }]);
  r = apx(['run', proc]);
  assert.deepEqual([r.code, JSON.parse(r.out)], [0, { mg: 270 }]);
  // `VAR dose:` + a lone RUN (or `RUN pediatric INTO dose`): the prompt says `--into`, and the apx stores the result itself.
  assert.ok(clerkMd.includes(`\`node .agent-pack/apx/clerk.apx run ${proc} --into dose\` stores its result as \`dose\``), 'the call site runs it into its variable');
  assert.ok(!clerkMd.includes('store the result as `dose`'), 'no set to tell');
  r = apx(['run', proc, '--into', 'dose']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('stored as `dose`'), r.out);
  const dose = apx(['get', 'dose']).out;
  assert.deepEqual(JSON.parse(dose.slice(dose.indexOf('# value:\n') + '# value:\n'.length)), { mg: 270 }, 'stored, shaped as dose-result');
  assert.equal(apx(['run', proc, '--into', 'nowhere']).code, 2, 'only a variable of the agent');
  assert.equal(apx(['run', cond, '--into', 'dose']).code, 2, 'only a procedure\'s result: a condition answers holds');
  writeFileSync(join(procDir, 'script.js'), readFileSync(join(procDir, 'script.js'), 'utf-8').replace('{ mg: i.weight_kg * 15 }', '{ milligrams: i.weight_kg * 15 }'));
  writeFileSync(join(procDir, 'tests.json'), JSON.stringify([{ why: 'normal', input: { weight_kg: 18 }, output: { milligrams: 270 } }]));
  r = apx(['run', proc]);
  assert.equal(r.code, 6);
  assert.ok(r.out.includes('answered outside its contract: not shaped as `dose-result`'), r.out);

  // --- the session records every run and answer ---
  const table = join(root, '.agent-pack', 'state', 'test-session', 'executors.tbl');
  const listed = spawnSync(table, ['q'], { encoding: 'utf-8' });
  assert.equal(listed.status, 0, `the session's table stays readable: ${listed.stderr}`);
  for (const outcome of ['ran', 'refused', 'timeout', 'answered', 'broken']) assert.ok(listed.stdout.includes(`outcome=${outcome}`), `recorded: ${outcome}`);
  assert.ok(listed.stdout.includes('who=quick') && listed.stdout.includes('who=program'), 'who carried it out: the default delegate by name, or the program');

  // --- an edited block: a new folder, which starts from the previous version; the old one is reported ---
  write(join(root, 'agents', 'standalone', 'clerk.ap'), AGENT.map(l => l.replace('mg = {{weight_kg}} × 15', 'mg = {{weight_kg}} × 20')));
  built = bundle();
  assert.equal(built.status, 0, built.stderr);
  assert.ok(built.stderr.includes(`distilled/${procSpec.program} is the program of no piece any more`), built.stderr);
  const next = Object.entries(JSON.parse(readFileSync(join(root, '.agent-pack', 'compiled', 'clerk.ap.json'), 'utf-8')).meta.executors).find(([, s]) => s.site === 'procedure');
  assert.notEqual(next[1].program, procSpec.program, 'a new program folder');
  r = apx(['run', next[0]]);
  assert.equal(r.code, 10);
  assert.ok(r.out.includes(`its previous version is distilled/${procSpec.program}/ — start from it: version + 1, "previous": "${procSpec.program}", then delete that folder`), r.out);
  assert.ok(readdirSync(join(root, 'distilled')).includes(procSpec.program), 'reported, never deleted');

  // --- the config sets a delegate's model: the source never does ---
  write(join(root, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", "  delegate: { models: { quick: 'sonnet' } },", '};']);
  assert.equal(bundle().status, 0);
  assert.ok(/^model: sonnet$/m.test(readFileSync(join(root, '.claude', 'agents', 'quick.md'), 'utf-8')));

  // --- a DISTILL line is an error that says what replaces it ---
  write(join(root, 'agents', 'standalone', 'clerk.ap'), [...AGENT, '', 'PROCEDURE old:', '    AS  dose-result', '    DISTILL!!', '    DO  compute it']);
  built = bundle();
  assert.notEqual(built.status, 0);
  assert.ok(`${built.stdout}${built.stderr}`.includes('DISTILL was removed — mark the procedure PROCEDURE** or write a COMPUTE block'));
  assert.ok(!existsSync(join(root, 'distilled', 'dst-00000000')));

  console.log('programs: passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
