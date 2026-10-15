// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import { AdapterPlugin, AgentBundle, SkillBundle, Emitter } from '../types.js';
import { descriptionOf } from '../skill-frontmatter.js';

export interface CursorOptions {
  rulesDir?: string;
  agentsAlwaysActive?: boolean;
}

// Cursor picks a rule by its description: the agent's own ABOUT, quoted so a
// colon in it cannot break the frontmatter.
const buildMdc = (description: string, alwaysApply: boolean, body: string): string =>
  ['---', `description: ${JSON.stringify(description)}`, `alwaysApply: ${alwaysApply}`, '---', body].join('\n');

export default function cursorAdapter(opts: CursorOptions = {}): AdapterPlugin {
  const rulesDir = opts.rulesDir ?? '.cursor/rules';
  const agentsAlwaysActive = opts.agentsAlwaysActive ?? false;

  const agentEmitter: Emitter<AgentBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, rulesDir, `${b.name}.mdc`),
    content: buildMdc(b.metadata.get('ABOUT')?.[0] ?? `${b.name} agent`, agentsAlwaysActive, b.body),
  }];

  // A skill is a rule Cursor applies on its own, when the description fits.
  const skillEmitter: Emitter<SkillBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, rulesDir, `${b.name}.mdc`),
    content: buildMdc(descriptionOf(b), false, b.body),
  }];

  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'cursor',
    emitters: { agent: agentEmitter, skill: skillEmitter },
  };
}
