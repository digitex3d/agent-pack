// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import { Emitter, SkillBundle } from '../../types.js';
import { buildSkillFrontmatter } from '../../skill-frontmatter.js';

/** A skill's `SKILL.md`: the frontmatter, then `body` — the compiled definition by default. */
export function makeClaudeSkillEmitter(skillsDir: string, body: (b: SkillBundle) => string = b => b.body): Emitter<SkillBundle> {
  return (b, ctx) => [{
    path: resolve(ctx.projectRoot, skillsDir, b.name, 'SKILL.md'),
    content: buildSkillFrontmatter(b) + body(b),
  }];
}
