// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The version is written in one place, package.json: the code reads it from
 * there (packageVersion), and CITATION.cff carries a copy that `npm version`
 * writes (scripts/sync-version.mjs) — this fails when the copy drifts.
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const { packageVersion } = await import('../dist/src/config.js');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

assert.equal(packageVersion(), version, 'the code reads the version from package.json');
const cited = /^version: "(.*)"$/m.exec(readFileSync(new URL('../CITATION.cff', import.meta.url), 'utf-8'))?.[1];
assert.equal(cited, version, 'CITATION.cff carries the version of package.json — run `node scripts/sync-version.mjs`');

console.log('version tests passed.');
