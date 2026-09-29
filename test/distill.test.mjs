// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * DISTILL — a procedure's reasoning distilled into a deterministic script. A
 * bare line in a PROCEDURE (`DISTILL`, `DISTILL!`, `DISTILL!!`, `!DISTILL`);
 * the contract is the procedure's own: input `LENS-IN <template>` (optional),
 * output `AS <template>` (required). The instruction carries example JSON of
 * both; the apx runs the script (`run <dst-id>`), checking input and output;
 * `bundle all` reports scripts no procedure owns any more.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { distillId, orphanScripts } = await import('../dist/src/distill.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { ApDocument } = await import('../dist/src/apdoc/document.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');

// --- the id follows the procedure and its contract, not the level ---
assert.notEqual(distillId('DO a'), distillId('DO b'), 'the id follows the content');
assert.notEqual(distillId('DO a', ['t1']), distillId('DO a', ['t2']), 'and the contract templates');
assert.equal(distillId('DISTILL\nDO a'), distillId('DISTILL!!\nDO a'), 'a new level is not a new program');
assert.equal(distillId('DO   a\n\n  DO b'), distillId('DO a\nDO b'), 'spacing is not a new program');

const tmp = mkdtempSync(join(tmpdir(), 'ap-distill-'));
const lib = join(tmp, 'library');
mkdirSync(join(lib, 'templates'), { recursive: true });
const write = (file, lines) => writeFileSync(file, lines.join('\n'));
write(join(lib, 'templates', 'line.ap'), [
  'EXPORT TEMPLATE line:', '    ABOUT  one invoice line', '    SLOTS:',
  '        amount:   NUMBER >=0     "net amount"', '        vat-rate: NUMBER 0..100  "VAT percent"',
  '    BODY:', '        {amount} @ {vat-rate}%', '',
]);
write(join(lib, 'templates', 'invoice.ap'), [
  'IMPORT line FROM @main.templates', '',
  'EXPORT TEMPLATE invoice:', '    ABOUT  an invoice', '    SLOTS:',
  '        supplier: TEXT MAX_WORDS 6  "who issued it"', '        lines:    LIST <line> >=1   "its lines"',
  '    BODY:', '        {supplier}: {lines}', '',
]);
write(join(lib, 'templates', 'totals.ap'), [
  'EXPORT TEMPLATE totals:', '    ABOUT  the totals', '    SLOTS:',
  '        net:   NUMBER >=0  "net"', '        vat:   NUMBER >=0  "VAT"', '        gross: NUMBER >=0  "gross"',
  '    BODY:', '        net {net} vat {vat} gross {gross}', '',
]);
const agent = (extra = [], procedure = ['    LENS-IN   invoice', '    AS        totals', '    DISTILL!!']) => {
  const file = join(tmp, 'accountant.ap');
  write(file, [
    'IMPORT invoice, totals FROM @main.templates', '',
    'EXPORT AGENT accountant AS accountant-role:', '    ABOUT    keeps the books', '    OWNS     books/**', ...extra,
    '    WHEN an invoice arrives:', '        RUN  compute-totals', '',
    'ROLE accountant-role:', '    ABOUT  an accountant', '',
    'PROCEDURE compute-totals:', '    ABOUT     add up an invoice', ...procedure,
    '    DO        add net, VAT and gross from the invoice lines', '',
  ]);
  return bundleAgentObject({ agentName: 'accountant', agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};

try {
  const compiled = await agent();
  const md = compiled.body;
  const doc = ApDocument.fromJson(compiled.structure.asJson());
  const [{ mark, block }] = doc.distillMarks();
  assert.equal(block.name, 'compute-totals');
  assert.equal(mark.force, 2, 'DISTILL!! = must');
  const tpl = name => doc.all().find(b => b.name === name).id;

  // --- the procedure: its contract, then the instruction with example JSON ---
  assert.ok(md.includes(`Its input arrives shaped as **invoice** (${tpl('invoice')}).`), "LENS-IN is a procedure's input");
  assert.ok(md.includes(`Distilled as \`${mark.id}\`: run \`node .agent-pack/apx/accountant.apx run ${mark.id}\``));
  assert.ok(md.includes(`once the work is done you must write \`distilled/${mark.id}.<ext>\` — in the project root, beside \`.agent-pack/\``), "the script's place is said in full");
  assert.ok(md.includes('Input, e.g.: `{"supplier":"…","lines":[{"amount":0,"vat-rate":0}]}`'), 'input example from the templates');
  assert.ok(md.includes('Output, e.g.: `{"net":0,"vat":0,"gross":0}`'), 'output example');
  assert.ok(md.includes('`books/**`, `distilled/**`'), 'writing its scripts is inside the perimeter');

  // --- a nested template of the contract is part of the program ---
  write(join(lib, 'templates', 'line.ap'), [
    'EXPORT TEMPLATE line:', '    ABOUT  one invoice line', '    SLOTS:',
    '        amount:   NUMBER >=0     "net amount"', '        vat-rate: NUMBER 0..100  "VAT percent"',
    '        discount: NUMBER 0..100  "discount percent"', '    BODY:', '        {amount} @ {vat-rate}%', '',
  ]);
  const [{ mark: renewed }] = ApDocument.fromJson((await agent()).structure.asJson()).distillMarks();
  assert.notEqual(renewed.id, mark.id, 'a change in a nested template gives a new id');
  write(join(lib, 'templates', 'line.ap'), [
    'EXPORT TEMPLATE line:', '    ABOUT  one invoice line', '    SLOTS:',
    '        amount:   NUMBER >=0     "net amount"', '        vat-rate: NUMBER 0..100  "VAT percent"',
    '    BODY:', '        {amount} @ {vat-rate}%', '',
  ]);

  // --- compile errors: only a procedure, only with an output ---
  await assert.rejects(agent([], ['    DISTILL']), /accountant\.ap:12  a PROCEDURE with DISTILL needs its result contract — add AS <template>/);
  await assert.rejects(agent(['    DISTILL']), /accountant\.ap:6  DISTILL goes directly inside a PROCEDURE — found inside AGENT/);
  await assert.rejects(agent([], ['    AS totals', '    IF the invoice is foreign', '        DISTILL']), /DISTILL goes directly inside a PROCEDURE — found inside IF/);
  await assert.rejects(agent([], ['    AS totals', '    DISTILL', '    DISTILL!!']), /a PROCEDURE takes one DISTILL line — found 2/);
  await assert.rejects(agent([], ['    AS totals', '    DISTILL!!!']), /`DISTILL!!!` is not a level of DISTILL — use !DISTILL, DISTILL, DISTILL!, DISTILL!!/);
  await assert.rejects(agent([], ['    AS totals', '    DISTILL!! now']), /DISTILL!! takes no text/);
  await assert.rejects(agent(['    NEVER     accept an invoice without a VAT number DISTILL']), /DISTILL is no longer a suffix/);

  // --- the apx: live ids, input and output checked, failures send back to reasoning ---
  const project = join(tmp, 'project');
  mkdirSync(join(project, 'distilled'), { recursive: true });
  const exe = join(project, '.agent-pack', 'apx', 'accountant.apx');
  const apx = (...args) => { const lines = []; const code = new ApxEngine(doc, { builtAt: 'x', agentPackVersion: 'x', hash: 'x' }, exe, l => lines.push(l)).run(args); return { out: lines.join('\n'), code }; };
  const invoice = '{"supplier":"Acme","lines":[{"amount":100,"vat-rate":22}]}';

  let r = apx('run', 'dst-00000000', invoice);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("no distilled procedure with id 'dst-00000000'"), 'only live ids run');
  r = apx('run', mark.id, invoice);
  assert.ok(r.code === 1 && r.out.includes('no script for'), 'no script yet: reason, then write it');
  assert.ok(apx('scope').out.includes(`${mark.id}  procedure compute-totals  (no script yet)`));

  const script = join(project, 'distilled', `${mark.id}.mjs`);
  writeFileSync(script, '#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n=0,v=0;for(const l of JSON.parse(s).lines){n+=l.amount;v+=l.amount*l["vat-rate"]/100}console.log(JSON.stringify({net:n,vat:v,gross:n+v}))});\n');
  chmodSync(script, 0o755);
  r = apx('run', mark.id, invoice);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out), { net: 100, vat: 22, gross: 122 }, 'the script answers');
  r = apx('run', mark.id, '{"supplier":"Acme"}');
  assert.ok(r.code === 2 && r.out.includes('the input is not shaped as `invoice`: lines: required field missing'), 'the input is checked');
  r = apx('run', mark.id, '{"supplier":"Acme","lines":[{"amount":100,"vat-rate":220},"x"]}');
  assert.ok(r.code === 2 && r.out.includes('lines[0].vat-rate: expected ≤100, got 220') && r.out.includes('lines[1]: expected a JSON object'), `nested items are checked too: ${r.out}`);

  writeFileSync(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify({sum:1}));\n');
  r = apx('run', mark.id, invoice);
  assert.ok(r.code === 1 && r.out.includes('answered outside `totals`'), 'the output is checked');
  writeFileSync(script, '#!/bin/sh\necho "boom" >&2\nexit 3\n');
  r = apx('run', mark.id, invoice);
  assert.ok(r.code === 1 && r.out.includes('did not answer (exit 3): boom'), 'stderr says why');
  writeFileSync(script, '#!/usr/bin/env node\nthrow new Error("the rate is missing");\n');
  r = apx('run', mark.id, invoice);
  assert.ok(r.code === 1 && r.out.includes('Error: the rate is missing') && !r.out.includes('Node.js v'), `a runtime crash shows its cause: ${r.out}`);

  // --- scripts no procedure owns any more are reported, never deleted ---
  writeFileSync(join(project, 'distilled', 'dst-00000000.py'), '');
  assert.deepEqual(orphanScripts(project, new Set([mark.id])), ['distilled/dst-00000000.py']);

  console.log('DISTILL tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
