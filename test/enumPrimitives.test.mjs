// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { applyEnumPrimitives, renderEnumLegend } from '../dist/src/enumPrimitives.js';

// Helper: build a minimal BundleContext stub with a lintErrors array
function makeCtx() {
  return { lintErrors: [] };
}

// --- 1. CONTEXT full → resolved string ---

{
  const result = applyEnumPrimitives('CONTEXT full');
  assert.equal(result, 'passes the full upstream context, as-is', 'CONTEXT full resolves to correct string');

  console.log('enumPrimitives: CONTEXT full test passed.');
}

// --- 2. CONTEXT summary ---

{
  const result = applyEnumPrimitives('CONTEXT summary');
  assert.equal(result, 'passes a synthesized digest with provenance preserved', 'CONTEXT summary resolves to correct string');

  console.log('enumPrimitives: CONTEXT summary test passed.');
}

// --- 3. CONTEXT isolated ---

{
  const result = applyEnumPrimitives('CONTEXT isolated');
  assert.equal(result, 'passes nothing — the step receives only its own intent', 'CONTEXT isolated resolves to correct string');

  console.log('enumPrimitives: CONTEXT isolated test passed.');
}

// --- 4. Indented CONTEXT preserves indent ---

{
  const result = applyEnumPrimitives('  CONTEXT full');
  assert.equal(result, '  passes the full upstream context, as-is', 'indented CONTEXT full preserves leading spaces');

  console.log('enumPrimitives: indented CONTEXT full test passed.');
}

// --- 5. Unknown arg → unchanged + lint warning ---

{
  const ctx = makeCtx();
  const result = applyEnumPrimitives('CONTEXT foobar', ctx);
  assert.equal(result, 'CONTEXT foobar', 'unknown CONTEXT value leaves line unchanged');
  assert.equal(ctx.lintErrors.length, 1, 'one lint warning emitted for unknown value');
  assert.ok(ctx.lintErrors[0].message.includes('"foobar"'), 'warning mentions the unknown value');
  assert.equal(ctx.lintErrors[0].severity, 'warning', 'severity is warning');

  console.log('enumPrimitives: unknown arg warning test passed.');
}

// --- 6. Mid-line mention not matched ---

{
  const result = applyEnumPrimitives('something about CONTEXT in prose');
  assert.equal(result, 'something about CONTEXT in prose', 'mid-line CONTEXT mention not rewritten');

  console.log('enumPrimitives: mid-line CONTEXT not matched test passed.');
}

// --- 7. CONTEXT inherited (neutral) ---

{
  const result = applyEnumPrimitives('CONTEXT inherited');
  assert.equal(
    result,
    "runs as a fork of the caller — natively inherits the caller's full conversation context",
    'CONTEXT inherited resolves to the neutral fork prose',
  );

  console.log('enumPrimitives: CONTEXT inherited test passed.');
}

// --- 8. Adapter override wins over neutral prose ---

{
  const ctx = {
    lintErrors: [],
    renderings: { CONTEXT: { inherited: 'fork via the Agent tool' } },
  };
  assert.equal(
    applyEnumPrimitives('CONTEXT inherited', ctx),
    'fork via the Agent tool',
    'adapter rendering replaces the neutral prose',
  );
  assert.equal(
    applyEnumPrimitives('CONTEXT full', ctx),
    'passes the full upstream context, as-is',
    'values the adapter leaves out fall back to neutral prose',
  );

  console.log('enumPrimitives: adapter override test passed.');
}

// --- 9. Adapter cannot introduce new values ---

{
  const ctx = {
    lintErrors: [],
    renderings: { CONTEXT: { teleport: 'not a real mode' } },
  };
  const result = applyEnumPrimitives('CONTEXT teleport', ctx);
  assert.equal(result, 'CONTEXT teleport', 'adapter-only value stays literal');
  assert.equal(ctx.lintErrors.length, 1, 'adapter-only value still warns');

  console.log('enumPrimitives: adapter-only value rejected test passed.');
}

// --- 10. renderEnumLegend — neutral and adapter-native ---

{
  const neutral = renderEnumLegend('CONTEXT');
  assert.ok(neutral.startsWith('Context modes'), 'legend opens with the legendIntro');
  for (const mode of ['isolated', 'summary', 'full', 'inherited']) {
    assert.ok(neutral.includes(`- \`${mode}\` — `), `legend lists ${mode}`);
  }

  const ctx = {
    lintErrors: [],
    renderings: { CONTEXT: { inherited: 'fork via the Agent tool' } },
  };
  const native = renderEnumLegend('CONTEXT', ctx);
  assert.ok(native.includes('- `inherited` — fork via the Agent tool'), 'legend uses adapter rendering');
  assert.ok(native.includes('- `full` — passes the full upstream context, as-is'), 'legend falls back per value');

  assert.equal(renderEnumLegend('NOPE'), '', 'unknown keyword renders empty legend');

  console.log('enumPrimitives: renderEnumLegend test passed.');
}

console.log('All enumPrimitives tests passed.');
