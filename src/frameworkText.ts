// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readFileSync, existsSync } from 'fs';
import { stripAbout } from './services/text.js';

const cache = new Map<string, string>();

const H1_RE = /^#\s+.+$/m;

/**
 * Strip ABOUT and H1, trim — for a `.ap` shipped at an absolute path. This
 * is how a plugin contributes prose it owns: an adapter's `invoke.ap`, a store
 * type's creation recipe. Missing file = empty string, so
 * a plugin that ships none simply contributes nothing.
 */
export function loadRecipe(path: string): string {
  if (cache.has(path)) return cache.get(path)!;
  if (!existsSync(path)) {
    cache.set(path, '');
    return '';
  }
  const content = stripAbout(readFileSync(path, 'utf-8'))
    .replace(H1_RE, '').replace(/^\n+/, '').trim();
  cache.set(path, content);
  return content;
}

