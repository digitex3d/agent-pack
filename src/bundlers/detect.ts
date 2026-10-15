// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { Bundle } from '../../adapters/types.js';
import { Config } from '../config.js';
import { buildAgentBundle, BuildAgentOptions } from './agent.js';
import { agentNameOf } from '../services/teamMetadata.js';

export async function detectAndBuild(
  source: string,
  config: Config,
  opts: BuildAgentOptions = {},
): Promise<Bundle> {
  // A path names the agent (or skill) its file declares; anything else is a name.
  const path = resolve(source);
  const name = existsSync(path) && statSync(path).isFile() ? agentNameOf(path) : source;
  return buildAgentBundle(name, config, opts);
}
