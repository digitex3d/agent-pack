// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { type Config, AGENTS_MD, PROJECT_SOURCE } from './config.js';
import { bundleMainTexts } from './compiler/index.js';
import { FORMULAS, fill } from './formulas.js';
import { apxCommand } from './apx/paths.js';
import { ensureMdBlock } from './services/mdBlock.js';
import type { AdapterPlugin } from '../adapters/types.js';
import { readMainFile, type MainFile } from './services/mainMetadata.js';

export { AGENTS_MD, PROJECT_SOURCE };

/** What a project still holding a `PROJECT.ap` is told: the file it becomes. */
function projectSourceRewrite(): string {
  return `${PROJECT_SOURCE} is gone — the project's root is its main: rename the file after the executable (\`orfeo.ap\` builds \`orfeo\`), `
    + 'put its ABOUT and its root WHEN lines in a `MAIN:` block, and list what it holds in it — `TEAMS <team>, …` and `MEMBER <standalone agent>, …`';
}

/**
 * AGENTS.md with a main holds only what boots it — the `project` managed
 * block: its name and ABOUT, the command that prints it, to run it again when
 * its text left the context, and the universal policies, which hold before
 * anything is run. The rest of the main — its rules and its orchestration —
 * is what its apx prints on `start`. The rest of the file is left as the user
 * wrote it. Returns the main, its file name and its compiled text, or null
 * (no-op) when the project has no main. `boot` is the command that prints the
 * main — its apx's `start` when null. Throws on compilation errors, and on a
 * `PROJECT.ap` still there.
 */
export async function emitProjectContext(projectRoot: string, config: Config, boot: string | null = null): Promise<{ main: MainFile; file: string; content: string } | null> {
  if (existsSync(resolve(projectRoot, PROJECT_SOURCE))) throw new Error(projectSourceRewrite());
  const main = readMainFile(projectRoot);
  if (!main) return null;
  const { text, universal } = await bundleMainTexts(main, config);
  ensureMdBlock({ filePath: resolve(projectRoot, AGENTS_MD), key: 'project', content: mainBoot(main, universal, boot ?? apxCommand(main.name, 'start')) });
  return { main, file: basename(main.path), content: text };
}

/** The `project` block of AGENTS.md with a main: what boots it, then its universal policies. */
function mainBoot(main: MainFile, universal: string, boot: string): string {
  const M = FORMULAS.blocks.main;
  return [
    fill(M.heading, { name: main.name, about: main.about ? fill(FORMULAS.document.about, { about: main.about }) : '' }),
    '',
    M.boot,
    '',
    '```bash',
    boot,
    '```',
    '',
    M.again,
    ...(universal ? ['', universal] : []),
  ].join('\n');
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
