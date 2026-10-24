// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { AgentBundle, SkillBundle, AdapterPlugin } from '../../adapters/types.js';
import { Config } from '../config.js';
import { bundleAgentObjectFromConfig } from '../compiler/index.js';
import { dirname } from 'path';
import type { JudgeRun } from '../judge/phase.js';
import type { DomainDecider } from '../compiler/index.js';

export interface BuildAgentOptions {
  adapter?: AdapterPlugin;
  /** The command's judge run, shared by every agent it compiles. */
  judge?: JudgeRun | null;
  /** Who decides a file's domain the judge left grey — the developer on a terminal; absent: nobody, an error. */
  decide?: DomainDecider;
}

export async function buildAgentBundle(
  name: string,
  config: Config,
  opts: BuildAgentOptions = {},
): Promise<AgentBundle | SkillBundle> {
  const { body, metadata, structure, skill, agentFile } = await bundleAgentObjectFromConfig(name, config, {
    bundleConfig: config.bundle,
    lintConfig: config.lint,
    adapter: opts.adapter,
    judge: opts.judge,
    decide: opts.decide,
    // The implicit `name`; the constants the agent imports come on top.
    vars: { name },
  });
  return Object.assign(skill ? new SkillBundle() : new AgentBundle(), {
    name,
    body,
    sourcePath: dirname(agentFile),
    metadata,
    structure,
  });
}
