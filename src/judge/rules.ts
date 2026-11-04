// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge's rules: every TEMPLATE tagged `#judge` in the libraries — the
 * project's, the shared ones and the builtin one. The template's BODY layout
 * says which lines it applies to (its first word is the primitive: `DO {action}`
 * → every DO line; an opening ENUM slot `{keyword} {action}` → every line of
 * each of its values), its slot rules are the checks. A rule's force gives the
 * severity — MUST an error, SHOULD a warning (SHOULD-NOT too); any other force is a load error.
 */
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import { BUILTIN_LIBRARY_ROOT, librariesAliasMap } from '../config.js';
import { buildMetadataIndex } from '../libraryIndex.js';
import { exportedBlockBodies } from '../services/text.js';
import { ingestExportBlock } from '../ingest.js';
import { SourceRegistry } from '../sources.js';
import { TemplateBlock } from '../apdoc/blocks.js';
import { DocumentBuilder } from '../apdoc/builder.js';
import { readsOf, resolveReads } from '../vars.js';
import { isDirect, type JudgeCheck, type JudgeExample, type JudgeRule } from './types.js';
import { JUDGE_SCOPES, JUDGE_TAG } from '../services/tags.js';
import { getFamilyBases, parseForceLevel, toCanonicalKeyword } from '../forceLevelConfig.js';
import { lifecycleToWhen } from '../lifecycleConfig.js';
import { BASE_TRIGGER, isTriggerKind, splitControl } from '../lexer.js';
import { CHECK_KINDS } from '../check.js';
import { SLOT_NAME } from '../shapeCompiler.js';
import { ACTION_VERBS } from '../actionVerbs.js';
import { AGENT_METADATA_KEYWORDS, FORCE_LEVEL_PRIMITIVES } from '../primitives.js';
import { SEQUENCE_PRIMITIVES } from '../sequencePrimitives.js';
import { isVarKeyword } from '../vars.js';

/** The severity a check reports with — from its force; null when the judge does not support it. */
export function severityOf(check: JudgeCheck): 'error' | 'warning' | null {
  const { keyword, level } = check.force;
  if (level === null) return null;
  if (level < 0) return keyword === 'MUST' || keyword === 'ALWAYS' ? 'error' : keyword === 'SHOULD' ? 'warning' : null;
  return keyword === 'MUST' ? 'error' : keyword === 'SHOULD' ? 'warning' : null;
}

/** The EXAMPLE lines of a judge template written `<line> → <verdict>` — the reference examples. */
function examplesOf(template: TemplateBlock): JudgeExample[] {
  return (template.example ?? '').split('\n').flatMap(raw => {
    const m = raw.trim().match(/^(.+?)\s+→\s+(.+)$/);
    return m ? [{ line: m[1], verdict: m[2] }] : [];
  });
}

/**
 * What the judge reads for one line. A rule that asks directly (`NEVER …`) or
 * gives reference examples sends a JSON state: the line's role, the line with
 * its reads as plain names, those names as its inputs, and the examples. Any
 * other rule sends the line as it is.
 */
export function judgeState(rule: JudgeRule, text: string): string {
  if (!rule.checks.some(isDirect) && rule.examples.length === 0) return text;
  const inputs = [...new Set(readsOf(text).map(r => r.name))];
  return JSON.stringify({
    ...(rule.role ? { role: rule.role } : {}),
    line: resolveReads(text, r => r.name),
    inputs,
    ...(rule.examples.length ? { reference_examples: rule.examples } : {}),
  });
}

/**
 * The keywords a body line is stored under — `ApLine.primitive` (src/apdoc/document.ts):
 * the force-level families and the bullet keywords (a directive's keyword), the
 * control and sequence heads, and the heads with a node of their own (VAR, IN,
 * EACH — src/apdoc/nodes.ts). Never a block's metadata: AS is the shape of
 * its step or block, not a line.
 */
const LINE_KEYWORDS: ReadonlySet<string> = new Set([
  ...getFamilyBases(), ...FORCE_LEVEL_PRIMITIVES.map(p => p.keyword), ...ACTION_VERBS,
  ...CHECK_KINDS, ...SEQUENCE_PRIMITIVES.map(p => p.keyword), 'VAR', 'IN', 'EACH',
].filter(k => !(AGENT_METADATA_KEYWORDS as string[]).includes(k)));

/**
 * The keyword a line written with `word` is stored under: a lifecycle alias
 * (`ON-INVOKE`) is a WHEN line, a checked or executed head (`IF!`, `UNTIL*`) its control keyword, a scoped declaration (`SESSION VAR`) a VAR line, any form of a
 * force-level family (`NEVER`, `MUST-NOT`, `!MUST`, `SHOULD!`) the family's base.
 */
function storedKeyword(word: string): string {
  if (lifecycleToWhen(word) !== null) return 'WHEN';
  const control = splitControl(word);
  if (control) return isTriggerKind(control.keyword) ? BASE_TRIGGER : control.keyword;
  if (isVarKeyword(word)) return 'VAR';
  return parseForceLevel(toCanonicalKeyword(word))?.family ?? word;
}

/** A keyword a rule's BODY names — the word itself; one no line is stored under is a load error. */
function checkedPrimitive(template: TemplateBlock, word: string, opening: string): string {
  const stored = storedKeyword(word);
  const rule = `judge rule \`${template.name}\``;
  if (!LINE_KEYWORDS.has(stored)) {
    throw new Error(`${rule}: its BODY starts with ${opening}, which never starts a body line — it is a block's metadata or no line keyword, so the rule would judge nothing; start the BODY with the keyword of the lines it judges (e.g. \`DO {action}\`), or lay out \`{line}\` in a rule tagged #executed, #program or #agent`);
  }
  if (stored !== word) {
    throw new Error(`${rule}: its BODY starts with ${opening}, but lines written \`${word}\` are stored under \`${stored}\` — write \`${stored}\` (the rule then judges every ${stored} line, whatever its force or level)`);
  }
  return word;
}

/**
 * The primitives a rule's BODY layout names: its first word (`DO {action}`), or
 * the values of the ENUM slot it opens with (`{keyword} {action}`, keyword:
 * `ENUM[DO, MUST]`) — that slot only names the lines, so a rule on it is a load
 * error. Empty when it opens with any other slot (`{line}`).
 */
function primitivesOf(template: TemplateBlock): { primitives: string[]; keywordSlot?: string } {
  const layout = template.layout ?? '';
  const opening = new RegExp(`^\\s*\\{(${SLOT_NAME})\\}`).exec(layout)?.[1];
  if (opening) {
    const slot = template.slots?.find(s => s.name === opening);
    if (slot?.type.kind !== 'enum') return { primitives: [] };
    if (slot.rules.length > 0) {
      throw new Error(`judge rule \`${template.name}\`: its slot \`${opening}\` names the lines the rule judges, so it takes no rule of its own — write the rule on the slot of the line's text`);
    }
    return { primitives: slot.type.values.map(v => checkedPrimitive(template, v, `\`{${opening}}\`, whose value \`${v}\``)), keywordSlot: opening };
  }
  const word = /^\s*(!*[A-Z][A-Z0-9-]*[!*]*)(?=[\s:{]|$)/.exec(layout)?.[1];
  return { primitives: word ? [checkedPrimitive(template, word, `\`${word}\``)] : [] };
}

/** A `#judge` template as a rule — its primitives from the layout, its checks from the slot rules. */
export function ruleOf(template: TemplateBlock): JudgeRule {
  const { primitives, keywordSlot } = primitivesOf(template);
  const scope = JUDGE_SCOPES.find(s => template.tags.includes(s));
  if (primitives.length === 0 && !scope) {
    throw new Error(`judge rule \`${template.name}\`: its BODY layout must start with the keyword of the lines it judges (e.g. \`DO {action}\`), or an ENUM slot of those keywords, or the rule be tagged #executed, #program or #agent`);
  }
  const checks = template.asChecks();
  if (checks.length === 0) throw new Error(`judge rule \`${template.name}\`: no slot rule to check`);
  for (const check of checks) {
    if (!severityOf(check)) {
      const what = (check.force.level ?? 0) < 0 ? `a negative \`${check.force.keyword}\` rule` : `\`${check.force.keyword}\``;
      throw new Error(`judge rule \`${template.name}\`: ${what} is not supported — a #judge rule is MUST, SHOULD, NEVER, MUST-NOT or SHOULD-NOT (${check.id})`);
    }
  }
  const role = template.slots?.find(s => s.name !== keywordSlot)?.description;
  return { id: template.address, primitives, ...(scope ? { scope } : {}), template, checks, ...(role ? { role } : {}), examples: examplesOf(template) };
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
        tags: unit.tags.map(t => t.replace(/^#/, '')), when: 'always',
      }, unit.body, cx);
      return ruleOf(template);
    });
}
