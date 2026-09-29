// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync } from 'fs';
import { resolve } from 'path';
import { Config } from './config.js';
import { bundleStandaloneToString } from './compiler/index.js';
import { ensureMdBlock } from './services/mdBlock.js';
import { AdapterPlugin } from '../adapters/types.js';

/** The project-level instructions file every harness reads: the open AGENTS.md standard. */
export const AGENTS_MD = 'AGENTS.md';

/** The project's always-on context, compiled into AGENTS.md. */
export const PROJECT_SOURCE = 'PROJECT.ap';

/**
 * Compile `PROJECT.ap` into the `project` managed block of AGENTS.md — the
 * rest of the file is left as the user wrote it. Returns false (no-op) when
 * the project has no PROJECT.ap. Throws on compilation errors.
 */
export async function emitProjectContext(projectRoot: string, config: Config): Promise<boolean> {
  const sourcePath = resolve(projectRoot, PROJECT_SOURCE);
  if (!existsSync(sourcePath)) return false;
  const compiled = await bundleStandaloneToString(sourcePath, config);
  ensureMdBlock({ filePath: resolve(projectRoot, AGENTS_MD), key: 'project', content: compiled });
  return true;
}

/**
 * Point each harness that reads its own instructions file at AGENTS.md, via a
 * managed block holding the adapter's pointer (Claude Code: `@AGENTS.md` in
 * CLAUDE.md). Returns the files touched.
 */
export function ensureProjectPointers(projectRoot: string, adapters: AdapterPlugin[]): string[] {
  const touched: string[] = [];
  for (const adapter of adapters) {
    const pointer = adapter.projectPointer;
    if (!pointer) continue;
    const filePath = resolve(projectRoot, pointer.file);
    const { action } = ensureMdBlock({ filePath, key: 'agents-md', content: pointer.content });
    if (action !== 'unchanged') touched.push(pointer.file);
  }
  return touched;
}
