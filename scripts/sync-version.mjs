// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The version is written in one place: package.json. CITATION.cff cannot read
 * it, so this copies it there — run by `npm version` (the `version` hook,
 * after the bump and before the commit), and checked by test/version.test.mjs.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const citation = resolve(root, 'CITATION.cff');
const before = readFileSync(citation, 'utf-8');
const after = before.replace(/^version: ".*"$/m, `version: "${version}"`);
if (after === before && !before.includes(`version: "${version}"`)) {
  console.error('CITATION.cff has no `version: "…"` line to update');
  process.exit(1);
}
if (after !== before) writeFileSync(citation, after);
console.error(`CITATION.cff → ${version}`);
