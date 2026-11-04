// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The keyword catalog — every word of the language with its role, built from
 * the compiler's registries — and the dist/keywords.json the build writes from it.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const { keywordCatalog } = await import('../dist/src/keywordCatalog.js');
const { KEYWORDS } = await import('../dist/src/lexer.js');

const catalog = keywordCatalog();

// Every word the lexer knows is in the catalog.
for (const k of KEYWORDS) assert.ok(k in catalog, `${k} is in the catalog`);

// A block opener, a rule family and its alias, a descriptive field, everything else.
assert.equal(catalog.AGENT, 'block');
assert.equal(catalog.EXPORT, 'block');
assert.equal(catalog.MUST, 'rule');
assert.equal(catalog.NEVER, 'rule', 'an alias takes its family\'s role');
assert.equal(catalog.ABOUT, 'meta');
assert.equal(catalog.BUDGET, 'meta');
// AS and MEM are force families but no rule; WITH is lexed only to name its rewrite (it is the decorator @WITH).
assert.equal(catalog.AS, 'keyword');
assert.equal(catalog.WITH, 'keyword');
// Words spelled inside the lexer's patterns, and the COMPUTE sections.
for (const k of ['FROM', 'INTO', 'MAX', 'DISTILL', 'REQUIRE', 'RETURN', 'ENSURE', 'VAR', 'DO']) {
  assert.equal(catalog[k], 'keyword', `${k} is a keyword`);
}

// The build writes the same catalog, with the package version.
const written = JSON.parse(readFileSync(new URL('../dist/keywords.json', import.meta.url), 'utf-8'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
assert.equal(written.version, version);
assert.deepEqual(written.keywords, catalog);

console.log('keyword catalog tests passed.');
