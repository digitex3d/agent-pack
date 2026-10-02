// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { AgentBundle, AdapterPlugin } from '../../adapters/types.js';
import { Config } from '../config.js';
import { bundleAgentObjectFromConfig, resolveAgentDir, resolveAgentFile } from '../compiler/index.js';
import { varsFilesFor } from '../varsAp.js';
import type { JudgeRun } from '../judge/phase.js';

export interface BuildAgentOptions {
  adapter?: AdapterPlugin;
  /** The command's judge run, shared by every agent it compiles. */
  judge?: JudgeRun | null;
}

export async function buildAgentBundle(
  name: string,
  config: Config,
  opts: BuildAgentOptions = {},
): Promise<AgentBundle> {
  const { body, metadata, structure } = await bundleAgentObjectFromConfig(name, config, {
    bundleConfig: config.bundle,
    lintConfig: config.lint,
    adapter: opts.adapter,
    judge: opts.judge,
    // The implicit `name`, then the project's, the team's and the agent's vars.ap.
    vars: { name },
    varsFiles: varsFilesFor(resolveAgentFile(name, config), process.cwd()),
  });
  return Object.assign(new AgentBundle(), {
    name,
    body,
    sourcePath: resolveAgentDir(name, config),
    metadata,
    structure,
  });
}
