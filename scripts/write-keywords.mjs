// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Writes dist/keywords.json — every word of the language with its role
 * (src/keywordCatalog.ts), for the tools that show `.ap` sources to a
 * developer. Run by `npm run build`, after tsc.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { keywordCatalog } = await import(resolve(root, 'dist/src/keywordCatalog.js'));
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
writeFileSync(resolve(root, 'dist/keywords.json'), `${JSON.stringify({ version, keywords: keywordCatalog() }, null, 2)}\n`);
