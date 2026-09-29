// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for src/definition.ts:
 * - defaults() convention derivation
 * - STRATEGIES registry
 * - strategyFor lookup
 * - allRunnables / resolveRunTarget
 */
import { strict as assert } from 'assert';

const {
  defaults,
  STRATEGIES,
  strategyFor,
  allRunnables,
  resolveRunTarget,
} = await import('../dist/src/definition.js');

// ---------------------------------------------------------------------------
// 1. defaults('procedure') produces all fields by convention
// ---------------------------------------------------------------------------

{
  const s = defaults('procedure');
  assert.equal(s.kind, 'procedure', 'kind matches input');
  assert.equal(s.headerKeyword, 'PROCEDURE', 'headerKeyword uppercased from kind');
  assert.equal(s.runnable, false, 'runnable defaults to false');
  assert.equal(s.sectionTitle, 'Procedures', 'sectionTitle is capitalized plural');
  assert.equal(s.formatHeading('my-proc'), '`my-proc`', 'default formatHeading (no kind-word prefix — the chapter H1 already names the kind)');

  console.log('defaults(procedure) convention test passed.');
}

// ---------------------------------------------------------------------------
// 2. Override on formatHeading wins over convention
// ---------------------------------------------------------------------------

{
  const base = defaults('procedure');
  const overridden = { ...base, formatHeading: n => `Procedure named "${n}"` };
  assert.equal(overridden.formatHeading('deploy'), 'Procedure named "deploy"', 'override wins');
  // Convention not affected
  assert.equal(base.formatHeading('deploy'), '`deploy`', 'base unchanged');

  console.log('formatHeading override test passed.');
}

// ---------------------------------------------------------------------------
// 3. strategyFor('procedure') returns the correct strategy
// ---------------------------------------------------------------------------

{
  const s = strategyFor('procedure');
  assert.ok(s !== null, 'strategyFor finds procedure');
  assert.equal(s.kind, 'procedure');
  assert.equal(s.runnable, true, 'procedure is runnable in STRATEGIES');
  assert.equal(s.formatHeading('deploy'), '`deploy`', 'procedure heading format in registry (no kind-word prefix)');

  console.log('strategyFor(procedure) test passed.');
}

// ---------------------------------------------------------------------------
// 5. allRunnables returns only procedure + flow (not template/lens/role)
// ---------------------------------------------------------------------------

{
  const ctx = buildCtx({
    procedures: [makeEntry('procedure', 'deploy')],
    flows: [makeEntry('flow', 'tdd')],
    templates: [makeEntry('template', 'report')],
    roles: [makeEntry('role', 'senior')],
  });

  const runnables = allRunnables(ctx);
  assert.equal(runnables.length, 2, 'only procedure + flow are runnable');
  const names = runnables.map(r => r.name);
  assert.ok(names.includes('deploy'), 'procedure included');
  assert.ok(names.includes('tdd'), 'flow included');
  assert.ok(!names.includes('report'), 'template excluded');
  assert.ok(!names.includes('senior'), 'role excluded');

  console.log('allRunnables exclusion test passed.');
}

// ---------------------------------------------------------------------------
// 6. resolveRunTarget('tdd', ctx) with an imported flow returns the definition
// ---------------------------------------------------------------------------

{
  const tddFlow = makeEntry('flow', 'tdd');
  const ctx = buildCtx({ flows: [tddFlow] });

  const resolved = resolveRunTarget('tdd', ctx);
  assert.ok(resolved !== null, 'tdd flow is found');
  assert.equal(resolved.name, 'tdd', 'name matches');
  assert.equal(resolved.kind, 'flow', 'kind is flow');

  console.log('resolveRunTarget found test passed.');
}

// ---------------------------------------------------------------------------
// 7. resolveRunTarget('unknown', ctx) returns null
// ---------------------------------------------------------------------------

{
  const ctx = buildCtx({ flows: [makeEntry('flow', 'tdd')] });
  const resolved = resolveRunTarget('unknown', ctx);
  assert.equal(resolved, null, 'unknown name returns null');

  console.log('resolveRunTarget not-found test passed.');
}

// ---------------------------------------------------------------------------
// 8. strategyFor returns null for retired kinds (lens was merged into template)
// ---------------------------------------------------------------------------

{
  assert.equal(strategyFor('lens'), null, 'lens kind retired — no strategy');
  console.log('retired-kind test passed.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(kind, name) {
  return {
    kind, name, about: null, body: '',
    path: `/lib/${kind}/${name}.${kind}.ap`,
    tags: [], breadcrumb: [], breadcrumbSegments: [],
  };
}

function buildCtx(overrides = {}) {
  return {
    procedures: [],
    flows: [],
    templates: [],
    roles: [],
    ...overrides,
  };
}

console.log('All definition tests passed.');
