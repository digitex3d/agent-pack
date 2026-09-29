// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Recursively collect files under `dir` up to `maxDepth` levels deep,
 * returned as a sorted list of absolute paths. Missing directories yield [].
 */
export function collectFiles(dir: string, maxDepth: number, currentDepth = 1): string[] {
  if (currentDepth > maxDepth || !existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory() && currentDepth < maxDepth) {
      files = files.concat(collectFiles(fullPath, maxDepth, currentDepth + 1));
    }
  }

  return files.sort();
}
