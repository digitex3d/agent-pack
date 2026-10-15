// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import { AdapterPlugin, AgentBundle, SkillBundle, Emitter } from '../types.js';
import { buildSkillFrontmatter } from '../skill-frontmatter.js';

/**
 * JetBrains Junie adapter.
 *
 * Native layout (per Junie docs, https://junie.jetbrains.com/docs/):
 *   .junie/AGENTS.md            — single, project-wide guidelines file consumed by Junie
 *   .junie/skills/<name>/SKILL.md  — per-skill folders with YAML frontmatter (name, description)
 *
 * Conventions:
 * - AgentBundle    → .junie/AGENTS.md (the file Junie reads as standing context).
 *                    If multiple agents are bundled, the LAST one wins (Junie has no
 *                    multi-agent concept). Use one project-level agent for Junie, or
 *                    aggregate them upstream.
 * - SkillBundle    → .junie/skills/<name>/SKILL.md (each skill in its own folder,
 *                    matching Junie's "one domain per skill" principle).
 */
export interface JunieOptions {
  agentsFile?: string;      // default: '.junie/AGENTS.md'
  skillsDir?: string;       // default: '.junie/skills'
}

export default function junieAdapter(opts: JunieOptions = {}): AdapterPlugin {
  const agentsFile = opts.agentsFile ?? '.junie/AGENTS.md';
  const skillsDir = opts.skillsDir ?? '.junie/skills';

  const agentEmitter: Emitter<AgentBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, agentsFile),
    content: b.body,
  }];

  const skillEmitter: Emitter<SkillBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, skillsDir, b.name, 'SKILL.md'),
    content: buildSkillFrontmatter(b) + b.body,
  }];

  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'junie',
    emitters: { agent: agentEmitter, skill: skillEmitter },
  };
}
