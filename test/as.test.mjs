// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { applyBodySubstitutions } from '../dist/src/primitives.js';
import { applyForceLevels } from '../dist/src/forceLevel.js';

// --- Unit: AS slug resolution via applyBodySubstitutions ---
// applyBodySubstitutions resolves ONLY the slug, keeping the AS keyword so the
// downstream applyForceLevels renders the force-level intro.

const subst = (text, templates = []) =>
  applyBodySubstitutions(text, { templates });

{
  // basic resolution against a TEMPLATE → keyword kept, slug becomes back-ref
  const templates = [{ name: 'bug-report', refId: 'tpl-5.2' }];
  const out = subst('AS bug-report\n', templates);
  assert.equal(out, 'AS `bug-report` (tpl-5.2)\n', 'AS keeps keyword + resolves slug to back-ref');
}

{
  // force-level markers preserved: AS! / AS!! / !AS
  const templates = [{ name: 'spec', refId: 'tpl-4.0' }];
  assert.equal(subst('AS! spec\n', templates),  'AS! `spec` (tpl-4.0)\n',  'AS! preserved');
  assert.equal(subst('AS!! spec\n', templates), 'AS!! `spec` (tpl-4.0)\n', 'AS!! preserved');
  assert.equal(subst('!AS spec\n', templates),  '!AS `spec` (tpl-4.0)\n',  '!AS preserved');
}

{
  // indentation preserved (e.g. AS inside a flow STEP)
  const templates = [{ name: 'spec', refId: 'tpl-2.3' }];
  const out = subst('    AS spec\n', templates);
  assert.equal(out, '    AS `spec` (tpl-2.3)\n', 'leading indent preserved');
}

{
  // unknown slug → throws
  const templates = [{ name: 'foo', refId: 'tpl-1.1' }];
  assert.throws(() => subst('AS nonexistent\n', templates), /unknown shape "nonexistent"/);
}

{
  // multiple occurrences resolved independently
  const templates = [{ name: 'a', refId: 'tpl-4.1' }, { name: 'b', refId: 'tpl-6.2' }];
  const out = subst('AS a\n\nsome text\n\nAS b\n', templates);
  assert.ok(out.includes('AS `a` (tpl-4.1)'));
  assert.ok(out.includes('AS `b` (tpl-6.2)'));
}

{
  // multi-token argument must NOT match (AS only binds a single slug)
  const out = subst('AS something inline in a sentence\n', []);
  assert.equal(out, 'AS something inline in a sentence\n', 'multi-token argument left untouched');
}

console.log('AS slug-resolution unit tests passed.');

// --- Integration: applyBodySubstitutions → applyForceLevels renders the intro ---

{
  const templates = [{ name: 'bug-report', refId: 'tpl-5.2' }];
  const resolved = applyBodySubstitutions('AS bug-report\n', { templates });
  const rendered = applyForceLevels(resolved);
  assert.ok(
    rendered.includes('Shape your response as `bug-report` (tpl-5.2)'),
    `force-level intro applied to AS, got: ${JSON.stringify(rendered)}`,
  );
}

{
  // negation level renders the -1 intro
  const templates2 = [{ name: 'gantt', refId: 'tpl-3.1' }];
  const resolved = applyBodySubstitutions('!AS gantt\n', { templates: templates2 });
  const rendered = applyForceLevels(resolved);
  assert.ok(
    rendered.includes('Do not shape your response as `gantt` (tpl-3.1)'),
    `negation intro applied, got: ${JSON.stringify(rendered)}`,
  );
}

{
  // amplified level renders the level-2 intro
  const templates = [{ name: 'task-spec', refId: 'tpl-7.4' }];
  const resolved = applyBodySubstitutions('AS!! task-spec\n', { templates });
  const rendered = applyForceLevels(resolved);
  assert.ok(
    rendered.includes('Shape your response to match exactly: `task-spec` (tpl-7.4)'),
    `level-2 intro applied, got: ${JSON.stringify(rendered)}`,
  );
}


// --- LENS-OUT agent key: sugar over AS! — the agent's default response shape ---

{
  const { LensOutPrimitive } = await import('../dist/src/primitives.js');
  assert.equal(LensOutPrimitive.renderNeutral([]), '', 'no LENS-OUT → no injection');
  assert.equal(LensOutPrimitive.renderNeutral(['idea-verdict']), 'AS! idea-verdict\n\n', 'LENS-OUT renders the AS! binding line');

  // full pipeline: resolution + calibrated force-level intro
  const templates = [{ name: 'idea-verdict', refId: 'tpl-1.2' }];
  const resolved = applyBodySubstitutions(LensOutPrimitive.renderNeutral(['idea-verdict']), { templates });
  const rendered = applyForceLevels(resolved);
  assert.ok(
    rendered.includes('Strictly shape your response as — no deviation: `idea-verdict` (tpl-1.2)'),
    `LENS-OUT binding fully rendered, got: ${JSON.stringify(rendered)}`,
  );
  console.log('LENS-OUT agent-key tests passed.');
}

console.log('AS force-level rendering tests passed.');
