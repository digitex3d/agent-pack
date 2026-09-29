// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync, statSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Bundle } from '../../adapters/types.js';
import { Config } from '../config.js';
import { buildAgentBundle, BuildAgentOptions } from './agent.js';
import { buildPlaybookBundle } from '../compiler/index.js';
import { unitKindOf } from '../ingest.js';

export async function detectAndBuild(
  source: string,
  config: Config,
  opts: BuildAgentOptions = {},
): Promise<Bundle> {
  // Kind is read from the file, never the suffix: a playbook is a `.ap` whose
  // kind resolves to `playbook` (a PLAYBOOK block, or the `playbooks/`
  // kind-folder). Anything else builds as an agent.
  const path = resolve(source);
  if (existsSync(path) && statSync(path).isFile()) {
    const body = readFileSync(path, 'utf-8');
    if (unitKindOf(path, body) === 'playbook') {
      return buildPlaybookBundle(path, config);
    }
  }
  return buildAgentBundle(source, config, opts);
}
