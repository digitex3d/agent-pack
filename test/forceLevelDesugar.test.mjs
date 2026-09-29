// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { lex } from '../dist/src/lexer.js';
import { desugar } from '../dist/src/desugar.js';

function lexDesugar(source) {
  return desugar(lex(source));
}

function firstKeyword(source) {
  const tokens = lexDesugar(source);
  const t = tokens.find(t => t.kind === 'keyword');
  if (!t) throw new Error(`no keyword token in: ${source}`);
  return t;
}

// --- Force-level alias desugaring ---

{
  const t = firstKeyword('NON-NEGOTIABLE call bundle');
  assert.equal(t.keyword, 'MUST!!', 'NON-NEGOTIABLE desugars to MUST!!');
  assert.equal(t.rest, 'call bundle', 'rest preserved');
}

{
  const t = firstKeyword('NEVER skip tests');
  assert.equal(t.keyword, '!ALWAYS', 'NEVER desugars to !ALWAYS');
  assert.equal(t.rest, 'skip tests', 'rest preserved');
}

{
  const t = firstKeyword('MUST-NOT commit secrets');
  assert.equal(t.keyword, '!MUST', 'MUST-NOT desugars to !MUST');
  assert.equal(t.rest, 'commit secrets', 'rest preserved');
}

// --- Canonical forms pass through unchanged ---

{
  const t = firstKeyword('MUST do X');
  assert.equal(t.keyword, 'MUST', 'MUST passes through as-is');
}

{
  const t = firstKeyword('MUST! do Y');
  assert.equal(t.keyword, 'MUST!', 'MUST! passes through as-is');
}

{
  const t = firstKeyword('!MUST do Z');
  assert.equal(t.keyword, '!MUST', '!MUST passes through as-is (canonical negation)');
}

{
  const t = firstKeyword('MUST!! enforce always');
  assert.equal(t.keyword, 'MUST!!', 'MUST!! passes through as-is');
}

{
  const t = firstKeyword('!ALWAYS write tests');
  assert.equal(t.keyword, '!ALWAYS', '!ALWAYS passes through as-is');
}

// --- Static alias: ON-INVOKE stays mapped to WHEN ---

{
  // ON-INVOKE is a bare keyword (no rest required by lexer for bare form)
  // But the desugar should map it to WHEN
  const tokens = desugar(lex('ON-INVOKE'));
  const kwTokens = tokens.filter(t => t.kind === 'keyword');
  // ON-INVOKE may not appear as keyword alone (KEYWORD_BARE_RE handles it),
  // so test via KEYWORD_WITH_REST_RE path
  const t2 = firstKeyword('ON-INVOKE this agent is invoked');
  assert.equal(t2.keyword, 'WHEN', 'ON-INVOKE desugars to WHEN');
  assert.equal(t2.rest, 'this agent is called', 'ON-INVOKE rest overridden to static value');
}

// --- Non-keyword tokens are unaffected ---

{
  const tokens = lexDesugar('# Comment\n\nsome plain text');
  assert.ok(tokens.some(t => t.kind === 'comment'), 'comment token preserved');
  assert.ok(tokens.some(t => t.kind === 'unknown'), 'unknown token preserved');
  assert.ok(!tokens.some(t => t.kind === 'keyword'), 'no keyword tokens in this source');
}

console.log('forceLevelDesugar tests passed.');
