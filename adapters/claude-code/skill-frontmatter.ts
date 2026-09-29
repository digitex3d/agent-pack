// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { PlaybookBundle } from '../types.js';
import { collectFrontmatter, serializeFrontmatter, FrontmatterField } from '../../src/primitives.js';

/**
 * Skill frontmatter: name + adapter-claimed primitive contributions
 * (ABOUT → description, WHEN → when-to-use). When no ABOUT was extracted,
 * fall back to the bundle name so the field is always populated.
 */
export function buildSkillFrontmatter(b: PlaybookBundle): string {
  const contributions = collectFrontmatter(b.metadata, 'claude-code');
  const fields: FrontmatterField[] = [{ key: 'name', value: b.name }];

  if (!contributions.some(f => f.key === 'description')) {
    fields.push({ key: 'description', value: b.name });
  }
  fields.push(...contributions);

  return serializeFrontmatter(fields);
}
