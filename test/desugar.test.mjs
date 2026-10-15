// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { desugar, STATIC_ALIASES, FORCE_LEVEL_ALIASES } from '../dist/src/desugar.js';
import { lex, lexRaw } from '../dist/src/lexer.js';

// --- Alias tables sanity ---

assert.ok(STATIC_ALIASES.length >= 1, 'STATIC_ALIASES has at least one entry');
assert.ok(
  STATIC_ALIASES.some(r => r.from === 'ON-INVOKE'),
  'STATIC_ALIASES contains ON-INVOKE',
);
assert.ok(
  FORCE_LEVEL_ALIASES.length >= 1,
  'FORCE_LEVEL_ALIASES has at least one entry derived from force-levels.json',
);

// --- desugar: bare ON-INVOKE → WHEN "this agent is called" ---

{
  const tokens = lexRaw('ON-INVOKE');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].kind, 'keyword');
  assert.equal(tokens[0].keyword, 'ON-INVOKE', 'lexRaw sees raw keyword');

  const out = desugar(tokens);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'keyword');
  assert.equal(out[0].keyword, 'WHEN', 'ON-INVOKE desugars to WHEN');
  assert.equal(out[0].rest, 'this agent is called', 'rest is canonical expansion');
  assert.equal(out[0].raw, 'ON-INVOKE', 'raw preserved from source');
  assert.equal(out[0].line, 1, 'line preserved');
  assert.equal(out[0].col, 1, 'col preserved');
  assert.equal(out[0].indent, 0, 'indent preserved');
}

// --- desugar: ON-INVOKE followed by DO block ---

{
  const source = 'ON-INVOKE\n  DO query context';
  const tokens = desugar(lexRaw(source));
  const kw = tokens.find(t => t.kind === 'keyword' && t.keyword === 'WHEN');
  assert.ok(kw, 'ON-INVOKE remapped to WHEN');
  assert.equal(kw.rest, 'this agent is called');
  const doToken = tokens.find(t => t.kind === 'keyword' && t.keyword === 'DO');
  assert.ok(doToken, 'DO token unchanged');
  assert.equal(doToken.rest, 'query context');
}

// --- desugar: non-alias keywords pass through unchanged ---

{
  const source = 'WHEN some trigger\nMUST do it\nALWAYS apply DRY';
  const rawTokens = lexRaw(source);
  const desugared = desugar(rawTokens);
  assert.deepEqual(desugared, rawTokens, 'non-alias keywords are returned by reference unchanged');
}

// --- desugar: heading, blank, comment pass through unchanged ---

{
  const source = '# Title\n\n<!-- comment -->';
  const rawTokens = lexRaw(source);
  const desugared = desugar(rawTokens);
  assert.deepEqual(desugared, rawTokens, 'non-keyword tokens pass through by reference');
}

// --- desugar: raw/line/col of remapped token point to ON-INVOKE source line ---

{
  const source = '# intro\n\nON-INVOKE\n  DO something';
  const tokens = desugar(lexRaw(source));
  const whenToken = tokens.find(t => t.kind === 'keyword' && t.keyword === 'WHEN');
  assert.ok(whenToken, 'WHEN token present');
  assert.equal(whenToken.raw, 'ON-INVOKE', 'raw is the original ON-INVOKE line');
  assert.equal(whenToken.line, 3, 'line points to ON-INVOKE source line');
  assert.equal(whenToken.col, 1, 'col points to ON-INVOKE column');
}

// --- desugar: empty array → empty output ---

{
  const out = desugar([]);
  assert.deepEqual(out, [], 'empty input → empty output');
}

// --- desugar: idempotence — output contains no ON-INVOKE tokens ---

{
  const source = 'ON-INVOKE\n  DO something';
  const once = desugar(lexRaw(source));
  // Feed the already-desugared tokens back through desugar.
  // WHEN does not have an alias so the second pass is a no-op.
  const twice = desugar(once);
  assert.deepEqual(once, twice, 'desugar is idempotent: second pass is a no-op');
  assert.ok(
    once.every(t => t.kind !== 'keyword' || t.keyword !== 'ON-INVOKE'),
    'output contains no ON-INVOKE tokens',
  );
}

// --- ON-INVOKE with unexpected rest: rest is overwritten with canonical value ---

{
  const source = 'ON-INVOKE something unexpected';
  const tokens = desugar(lexRaw(source));
  const kw = tokens.find(t => t.kind === 'keyword');
  assert.ok(kw);
  assert.equal(kw.keyword, 'WHEN', 'keyword remapped');
  assert.equal(kw.rest, 'this agent is called', 'canonical rest wins over any source rest');
}

// --- lex() (public API) automatically desugars ON-INVOKE ---

{
  const tokens = lex('ON-INVOKE\n  DO something');
  const kw = tokens.find(t => t.kind === 'keyword' && t.keyword === 'WHEN');
  assert.ok(kw, 'lex() automatically desugars ON-INVOKE to WHEN');
  assert.equal(kw.rest, 'this agent is called');
}

// --- round-trip: lex with ON-INVOKE does not break forceLevel-style consumers ---
// Verify that WHEN tokens emitted from ON-INVOKE have the correct shape for
// downstream consumers that iterate over keyword tokens.

{
  const tokens = lex('ON-INVOKE\nDO run init\nDO run checks');
  const kwTokens = tokens.filter(t => t.kind === 'keyword');
  assert.equal(kwTokens[0].keyword, 'WHEN');
  assert.equal(kwTokens[0].rest, 'this agent is called');
  assert.equal(kwTokens[1].keyword, 'DO');
  assert.equal(kwTokens[1].rest, 'run init');
  assert.equal(kwTokens[2].keyword, 'DO');
  assert.equal(kwTokens[2].rest, 'run checks');
}

// --- WHEN! <condition>: is sugar for WHEN <condition>: with IF! <condition>: beneath ---
// The body moves one level deeper — its own level — so the rewrite is byte-identical
// to the hand-written pair; both heads keep the source line. WHEN!! and !WHEN are left
// for the vocabulary check.

{
  const sugar = ['    WHEN! {{request}} submits one idea:', '        RUN shape-idea', '        IF it rains:', '            DO  stay', '', '    WHEN plain:', '        DO  y'];
  const plain = ['    WHEN {{request}} submits one idea:', '        IF! {{request}} submits one idea:', '            RUN shape-idea', '            IF it rains:', '                DO  stay', '', '    WHEN plain:', '        DO  y'];
  const shape = t => [t.kind, t.indent, t.keyword ?? '', t.rest ?? '', t.level ?? 0];
  assert.deepEqual(lex(sugar.join('\n')).map(shape), lex(plain.join('\n')).map(shape), 'WHEN! lexes as WHEN + IF!');
  const [when, cond] = lex(sugar.join('\n')).filter(t => t.kind === 'keyword');
  assert.equal(when.line, 1); assert.equal(cond.line, 1, 'both heads point at the source line');
  assert.equal(when.raw, '    WHEN {{request}} submits one idea:'); assert.equal(cond.raw, '        IF! {{request}} submits one idea:', 'raw is the rewritten line');
  const once = lex(sugar.join('\n')).map(t => t.raw ?? '').join('\n');
  assert.equal(lex(once).map(t => t.raw ?? '').join('\n'), once, 'the rewrite is idempotent: the pipeline re-lexes a body rebuilt from raw');
  const sealed = lex('WHEN!! {{r}} is clean:\n    DO x').filter(t => t.kind === 'keyword');
  assert.equal(sealed[0].keyword, 'WHEN'); assert.equal(sealed[0].level, 2, 'WHEN!! is not rewritten');
  const negated = lex('!WHEN {{r}} is clean:\n    DO x').filter(t => t.kind === 'keyword');
  assert.equal(negated[0].level, -1, '!WHEN is not rewritten');
  assert.equal(lex('WHEN* x:').filter(t => t.kind === 'keyword').length, 0, 'WHEN takes no executor star');
}

console.log('desugar tests passed.');
