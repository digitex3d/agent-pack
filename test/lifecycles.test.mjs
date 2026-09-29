// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Lifecycle-hook desugar oracle.
 *
 * Lifecycle hooks (`ON-AGENT-PROMPTED`, `ON-TASK-COMPLETED`, `ON-ERROR`,
 * `ON-DELEGATE`, `ON-INVOKE`) are syntactic sugar over canonical module-level
 * `WHEN <phase>`. The table lives in `src/config/lifecycles.json`; this test
 * pins that every alias desugars to its canonical WHEN rest, that the block
 * colon survives (`ON-X:` → `WHEN <phase>:` — a block opener byte-identical to
 * a hand-written WHEN), and that the legacy `ON-INVOKE` forms are unchanged.
 */
import { strict as assert } from 'assert';
import { lex, lexRaw } from '../dist/src/lexer.js';
import { getLifecycleAliases, lifecycleToWhen } from '../dist/src/lifecycleConfig.js';

function firstKeyword(source) {
  const t = lex(source).find(t => t.kind === 'keyword');
  if (!t) throw new Error(`no keyword token in: ${source}`);
  return t;
}

// --- config table is the single source of truth ---

const aliases = getLifecycleAliases();
for (const expected of ['ON-INVOKE', 'ON-AGENT-PROMPTED', 'ON-TASK-COMPLETED', 'ON-ERROR', 'ON-DELEGATE']) {
  assert.ok(aliases.includes(expected), `lifecycles.json declares ${expected}`);
}

const CANONICAL = {
  'ON-AGENT-PROMPTED': 'the agent receives a new user prompt',
  'ON-TASK-COMPLETED': 'the agent is about to declare the task complete',
  'ON-ERROR': 'a step or tool call fails unexpectedly',
  'ON-DELEGATE': 'the agent is about to delegate work to another agent',
  'ON-INVOKE': 'this agent is called',
};

// --- each alias desugars to WHEN with the canonical rest (bare form) ---

for (const [alias, when] of Object.entries(CANONICAL)) {
  assert.equal(lifecycleToWhen(alias), when, `lifecycleToWhen(${alias})`);

  const bare = firstKeyword(alias);
  assert.equal(bare.keyword, 'WHEN', `${alias} desugars to WHEN`);
  assert.equal(bare.rest, when, `${alias} rest is canonical (no colon)`);
}

// --- colon form: `ON-X:` → `WHEN <phase>:` (a block opener) ---

for (const [alias, when] of Object.entries(CANONICAL)) {
  const opener = firstKeyword(`${alias}:`);
  assert.equal(opener.keyword, 'WHEN', `${alias}: desugars to WHEN`);
  assert.equal(opener.rest, `${when}:`, `${alias}: carries the block colon`);
}

// --- byte-identity: `ON-AGENT-PROMPTED:` lexes identically to the hand WHEN ---

{
  const fromHook = firstKeyword('ON-AGENT-PROMPTED:');
  const fromHand = firstKeyword('WHEN the agent receives a new user prompt:');
  assert.equal(fromHook.keyword, fromHand.keyword);
  assert.equal(fromHook.rest, fromHand.rest, 'hook and hand-written WHEN share keyword+rest');
}

// --- position is preserved from the source line for error reporting ---

{
  const t = lex('# intro\n\nON-ERROR:\n    RUN recover').find(t => t.kind === 'keyword' && t.keyword === 'WHEN');
  assert.equal(t.raw, 'ON-ERROR:', 'raw is the original source line');
  assert.equal(t.line, 3, 'line points to the ON-ERROR source line');
  assert.equal(t.col, 1, 'col preserved');
}

// --- legacy ON-INVOKE forms unchanged ---

{
  // bare, no colon
  const bare = firstKeyword('ON-INVOKE');
  assert.equal(bare.keyword, 'WHEN');
  assert.equal(bare.rest, 'this agent is called', 'bare ON-INVOKE → canonical, no colon');

  // with-rest legacy form: rest is overridden by the canonical value
  const withRest = firstKeyword('ON-INVOKE this agent is invoked');
  assert.equal(withRest.keyword, 'WHEN');
  assert.equal(withRest.rest, 'this agent is called', 'ON-INVOKE <text> → canonical (rest discarded)');

  // lexRaw still sees the raw alias (desugar runs only in lex)
  assert.equal(lexRaw('ON-INVOKE')[0].keyword, 'ON-INVOKE', 'lexRaw preserves the raw alias');
}

console.log('lifecycle hook tests passed.');
