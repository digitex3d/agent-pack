// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge's rules: every TEMPLATE tagged `#judge` in the libraries — the
 * project's, the shared ones and the builtin one. The template's BODY layout
 * says which lines it applies to (its first word is the primitive: `DO {action}`
 * → every DO line), its slot rules are the checks. A rule's force gives the
 * severity — MUST an error, SHOULD a warning; any other force is a load error.
 */
import { resolve } from 'path';
import type { Config } from '../config.js';
import { BUILTIN_LIBRARY_ROOT, librariesAliasMap } from '../config.js';
import { buildMetadataIndex } from '../libraryIndex.js';
import { exportedBlockBodies } from '../services/text.js';
import { ingestExportBlock } from '../ingest.js';
import { SourceRegistry } from '../sources.js';
import { TemplateBlock } from '../apdoc/blocks.js';
import { DocumentBuilder } from '../apdoc/builder.js';
import type { JudgeCheck, JudgeRule } from './types.js';

/** The tag that makes a template a judge rule. */
export const JUDGE_TAG = '#judge';

/** The severity a check reports with — from its force; null when the judge does not support it. */
export function severityOf(check: JudgeCheck): 'error' | 'warning' | null {
  const { keyword, level } = check.force;
  if (level === null || level < 0) return null;
  return keyword === 'MUST' ? 'error' : keyword === 'SHOULD' ? 'warning' : null;
}

/** A `#judge` template as a rule — its primitive from the layout, its checks from the slot rules. */
export function ruleOf(template: TemplateBlock): JudgeRule {
  const primitive = /^\s*([A-Z][A-Z-]*)\b/.exec(template.layout ?? '')?.[1];
  if (!primitive) {
    throw new Error(`judge rule \`${template.name}\`: its BODY layout must start with the keyword of the lines it judges (e.g. \`DO {action}\`)`);
  }
  const checks = template.asChecks();
  if (checks.length === 0) throw new Error(`judge rule \`${template.name}\`: no slot rule to check`);
  for (const check of checks) {
    if (!severityOf(check)) {
      const what = (check.force.level ?? 0) < 0 ? 'a negative rule' : `\`${check.force.keyword}\``;
      throw new Error(`judge rule \`${template.name}\`: ${what} is not supported — a #judge rule is MUST or SHOULD (${check.id})`);
    }
  }
  return { id: template.address, primitive, template, checks };
}

/**
 * Every `#judge` rule of the libraries, through the library index — the
 * builtin library joined to the roots it scans (the index covers the project
 * and shared libraries only).
 */
export function loadJudgeRules(config: Pick<Config, 'libraryRoot' | 'sharedLibraries' | 'userRoot'>): JudgeRule[] {
  const scanned = {
    ...config,
    sharedLibraries: [...(config.sharedLibraries ?? []), { alias: 'builtin', path: BUILTIN_LIBRARY_ROOT }],
  } as Config;
  const roots = [resolve(scanned.libraryRoot), ...scanned.sharedLibraries!.map(l => resolve(l.path))];
  const libraries = librariesAliasMap(scanned);
  const index = buildMetadataIndex(scanned);
  const sources = new SourceRegistry();
  const cx = new DocumentBuilder();
  return (index.byTag[JUDGE_TAG] ?? [])
    .map(key => index.exports[key])
    .filter(entry => entry?.kind === 'template')
    .map(entry => {
      const file = entry.source.replace(/:\d+$/, '');
      const block = exportedBlockBodies(sources.read(file)).find(b => b.key === 'TEMPLATE' && b.name === entry.name);
      if (!block) throw new Error(`judge rule \`${entry.name}\`: not found in ${file}`);
      const unit = ingestExportBlock(block, file, roots, libraries);
      const template = TemplateBlock.fromBody({
        name: unit.name, namespace: entry.namespace, about: unit.about,
        tags: unit.tags.map(t => t.replace(/^#/, '')), applies: null, when: 'always',
      }, unit.body, cx);
      return ruleOf(template);
    });
}
