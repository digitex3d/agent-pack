// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { Bundle, SkillBundle } from './types.js';
import { serializeFrontmatter } from '../src/primitives.js';

/** The description a harness picks a skill by: its ABOUT, else its name. */
export function descriptionOf(b: Bundle): string {
  return b.metadata.get('ABOUT')?.[0] ?? b.name;
}

/** A skill's `SKILL.md` frontmatter — every harness that has skills reads the same two fields. */
export function buildSkillFrontmatter(b: SkillBundle): string {
  return serializeFrontmatter([
    { key: 'name', value: b.name },
    { key: 'description', value: descriptionOf(b) },
  ]);
}
