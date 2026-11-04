// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'node:assert';
import { applyEnumPrimitives, renderEnumLegend } from '../dist/src/enumPrimitives.js';

// Helper: build a minimal BundleContext stub with a lintErrors array
function makeCtx() {
  return { lintErrors: [] };
}

// --- 1. BUDGET cheap → resolved string, indent kept ---
{
  assert.equal(applyEnumPrimitives('BUDGET cheap'), 'fast, shallow work — the cheapest model', 'BUDGET cheap resolves to its string');
  assert.equal(applyEnumPrimitives('  BUDGET costly'), '  deep reasoning — the strongest model', 'an indented line keeps its leading spaces');
  console.log('enumPrimitives: BUDGET values test passed.');
}

// --- 2. Unknown arg → unchanged + lint warning ---
{
  const ctx = makeCtx();
  const result = applyEnumPrimitives('BUDGET foobar', ctx);
  assert.equal(result, 'BUDGET foobar', 'unknown BUDGET value leaves line unchanged');
  assert.equal(ctx.lintErrors.length, 1, 'one lint warning emitted for unknown value');
  assert.ok(ctx.lintErrors[0].message.includes('"foobar"'), 'warning mentions the unknown value');
  assert.equal(ctx.lintErrors[0].severity, 'warning', 'severity is warning');
  console.log('enumPrimitives: unknown arg warning test passed.');
}

// --- 3. Mid-line mention not matched; CONTEXT is no enum any more ---
{
  assert.equal(applyEnumPrimitives('something about BUDGET in prose'), 'something about BUDGET in prose', 'mid-line BUDGET mention not rewritten');
  assert.equal(applyEnumPrimitives('CONTEXT full'), 'CONTEXT full', 'CONTEXT was removed: the form of a DELEGATE says the context');
  console.log('enumPrimitives: mid-line and removed CONTEXT test passed.');
}

// --- 4. Adapter override wins over neutral prose; it cannot introduce new values ---
{
  const ctx = { lintErrors: [], renderings: { BUDGET: { cheap: 'the haiku model' } } };
  assert.equal(applyEnumPrimitives('BUDGET cheap', ctx), 'the haiku model', 'adapter rendering replaces the neutral prose');
  assert.equal(applyEnumPrimitives('BUDGET costly', ctx), 'deep reasoning — the strongest model', 'values the adapter leaves out fall back to neutral prose');
  const extra = { lintErrors: [], renderings: { BUDGET: { teleport: 'not a real tier' } } };
  assert.equal(applyEnumPrimitives('BUDGET teleport', extra), 'BUDGET teleport', 'adapter-only value stays literal');
  assert.equal(extra.lintErrors.length, 1, 'adapter-only value still warns');
  console.log('enumPrimitives: adapter override test passed.');
}

// --- 5. renderEnumLegend — neutral and adapter-native ---
{
  const neutral = renderEnumLegend('BUDGET');
  for (const tier of ['cheap', 'moderate', 'costly']) assert.ok(neutral.includes(`- \`${tier}\` — `), `legend lists ${tier}`);
  const native = renderEnumLegend('BUDGET', { lintErrors: [], renderings: { BUDGET: { cheap: 'the haiku model' } } });
  assert.ok(native.includes('- `cheap` — the haiku model'), 'legend uses adapter rendering');
  assert.ok(native.includes('- `costly` — deep reasoning — the strongest model'), 'legend falls back per value');
  assert.equal(renderEnumLegend('NOPE'), '', 'unknown keyword renders empty legend');
  assert.equal(renderEnumLegend('CONTEXT'), '', 'CONTEXT has no legend: it was removed');
  console.log('enumPrimitives: renderEnumLegend test passed.');
}

console.log('All enumPrimitives tests passed.');
