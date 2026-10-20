// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * AS in a WHEN block — the shape of the answer that trigger gives. An `AS`
 * line written directly in a `WHEN <trigger>:` (an `ON-…` hook too) shapes that
 * moment's answer, opening its body; it never becomes the agent's own shape.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-when-shape-'));
const lib = join(tmp, 'library');
mkdirSync(lib);

const TEMPLATES = [
  'TEMPLATE report:', '    ABOUT  a report', '    SLOTS:', '        v: TEXT "verdict"', '    BODY:', '        {v}', '',
  'TEMPLATE note:', '    ABOUT  a note', '    SLOTS:', '        n: TEXT "the note"', '    BODY:', '        {n}', '',
];
async function compile(name, lines) {
  const file = join(tmp, `${name}.ap`);
  writeFileSync(file, [`EXPORT AGENT ${name} AS ${name}-role:`, '    ABOUT  an agent', ...lines, '',
    `ROLE ${name}-role:`, '    ABOUT  a worker', '', ...TEMPLATES].join('\n'));
  return bundleAgentObject({ agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false } });
}
const idOf = (compiled, name) => compiled.structure.all().find(b => b.kind === 'template' && b.name === name).id;

try {
  // --- AS! in a WHEN: the trigger's shape, opening its body — never the agent's ---
  {
    const c = await compile('rev', [
      '    WHEN asked to review:',
      '        AS!   report',
      '        DO    read the diff',
      '    WHEN asked for a note:',
      '        DO    write it down',
      '        AS    note',
    ]);
    const report = idOf(c, 'report'), note = idOf(c, 'note');
    assert.ok(c.body.includes(`When asked to review:\n    Strictly shape your response as — no deviation: \`report\` (${report})\n    Do read the diff`), c.body);
    assert.ok(c.body.includes(`When asked for a note:\n    Shape your response as \`note\` (${note})\n    Do write it down`), 'the shape opens the body, wherever the AS line sits in it');
    assert.equal(c.structure.root().shape, null, "the agent's own answer shape is untouched");
    const whens = c.structure.root().body.filter(n => n.type === 'when');
    assert.deepEqual(whens.map(w => [w.condition, w.shape?.force, w.shape?.ref.id]),
      [['asked to review', 1, report], ['asked for a note', 0, note]], 'each WHEN node carries its own shape');
    assert.equal(whens[0].toJSON().shape.ref.id, report, 'the shape is serialized with the node');
  }

  // --- a lifecycle hook is a WHEN: ON-INVOKE takes its AS the same way ---
  {
    const c = await compile('hook', ['    ON-INVOKE:', '        AS    report', '        DO    say hello']);
    assert.ok(c.body.includes(`When this agent is called:\n    Shape your response as \`report\` (${idOf(c, 'report')})\n    Do say hello`), c.body);
  }

  // --- an AS nested deeper (under an IF in the WHEN) is not the trigger's ---
  {
    const c = await compile('deep', ['    WHEN asked to review:', '        IF the diff is large', '            AS  report', '            DO  split it']);
    assert.equal(c.structure.root().body.find(n => n.type === 'when').shape, undefined, 'only an AS written directly in the WHEN shapes it');
  }

  console.log('AS in WHEN tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
