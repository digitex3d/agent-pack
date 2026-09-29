// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import { Emitter, PlaybookBundle } from '../../types.js';
import { buildSkillFrontmatter } from '../skill-frontmatter.js';

export function makeClaudeSkillEmitter(skillsDir: string): Emitter<PlaybookBundle> {
  return (b, ctx) => [{
    path: resolve(ctx.projectRoot, skillsDir, b.name, 'SKILL.md'),
    content: buildSkillFrontmatter(b) + b.body,
  }];
}
