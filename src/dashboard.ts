// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The dashboard's compiled half: what each block of an agent weighs, written
 * into its document's meta. After a command's answer the apx shows the agent
 * the blocks it is likeliest to forget (src/apx/dashboard.ts) — the rules (a
 * block of rule lines) and the triggers (a WHEN, a node of the block that holds
 * it). weight = (risk + 1) × cost: the cost is the strongest rule line's
 * (force-levels.json), or `noRuleCost`; the risk one point per yes — it holds a
 * prohibition, its agent carries more rule lines than `manyRules`, it applies
 * only at one precise moment (every trigger). The weight is the agent's: kept
 * in the document's meta, never on a block another agent may hold too.
 */
import { NO_RULE_COST, isRuleKeyword, ruleCost } from './forceLevelConfig.js';
import { strategyOf } from './apdoc/blocks.js';
import { NODE } from './apx/service.js';
import { lineHeadOf, triggerKeys } from './apdoc/nodes.js';
import { buildIndex, type AffinityIndex, type Entry } from './affinity/index.js';
import type { ApDocument } from './apdoc/document.js';
import type { ApBlock } from './apdoc/block.js';
import type { ApNode, ApWhenNode } from './apdoc/types.js';
import { DASHBOARD_KIND, type DashboardConfig, type DashboardKind } from './config.js';

/** One block, or one trigger, the dashboard may remind the agent of. */
export interface ApReminder {
  /** Its key: a rule's block id; a trigger's own (apdoc/nodes.ts triggerKeys). */
  key: string;
  kind: DashboardKind;
  /** The id of the block that reads it: the rule itself, or the block a trigger is written in. */
  block: string;
  /** A trigger's condition — absent on a rule. */
  when?: string;
  /** (risk + 1) × cost. */
  weight: number;
}

/**
 * What the dashboard knows of one agent, compiled: the config it runs on, every
 * reminder with its weight, and the affinity index over their words — one key
 * per reminder, in the same order — so a call only matches the envelope.
 */
export interface ApDashboard {
  settings: DashboardConfig;
  reminders: ApReminder[];
  index: AffinityIndex;
}

/** What a rule line costs and whether it forbids — null for a line that is no rule: a shape (AS), a memory (MEM), no force at all. */
function ruleOf(node: ApNode): { cost: number; prohibition: boolean } | null {
  if (node.type !== NODE.directive || node.force === null || !isRuleKeyword(node.keyword)) return null;
  // Null only for a level its family does not declare.
  const cost = ruleCost(node.keyword, node.force);
  return cost === null ? null : { cost, prohibition: node.force < 0 };
}

/** The fields a reminder's words stand in, each weighing as the config's `fields` say. */
type WordFields = Record<keyof DashboardConfig['fields'], string[]>;

/** A block's own words, by field: its name and tags, its ABOUT, the text of each of its lines. */
function blockWords(block: ApBlock, nodes: readonly ApNode[]): WordFields {
  return { name: [block.name, ...block.tags], about: block.about ? [block.about] : [], lines: nodes.flatMap(node => lineHeadOf(node)?.text ?? []) };
}

/**
 * A reminder while its block is walked: the rule lines it holds decide its
 * weight; its words are what lights it, each weighing by the field it stands
 * in — a rule's name and tags, its ABOUT, its lines; a trigger's condition, as
 * its name.
 */
class Candidate {
  private strongest = 0;
  private prohibition = false;

  constructor(private readonly reminder: Omit<ApReminder, 'weight'>, private readonly words: WordFields) {}

  /** Take in one of its lines: a rule's words, its rule lines' strength. */
  hold(node: ApNode): void {
    const head = lineHeadOf(node);
    if (head && this.reminder.kind === DASHBOARD_KIND.rules) this.words.lines.push(head.text);
    const rule = ruleOf(node);
    if (!rule) return;
    this.strongest = Math.max(this.strongest, rule.cost);
    this.prohibition ||= rule.prohibition;
  }

  /** Its entry in the affinity index: each of its words in its field, at that field's weight. */
  entry(weighs: DashboardConfig['fields']): Entry {
    const fields = (Object.entries(this.words) as [keyof WordFields, string[]][]).flatMap(([field, texts]) => texts.map(text => ({ text, weight: weighs[field] })));
    return { key: this.reminder.key, texts: [], fields };
  }

  /** Whether it holds a rule line — a block without one is no rule. */
  get holdsRules(): boolean {
    return this.strongest > 0;
  }

  /** The reminder, weighed: `manyRules` whether its agent carries more rule lines than the config's `manyRules`. */
  weighed(manyRules: boolean): ApReminder {
    const momentary = this.reminder.kind === DASHBOARD_KIND.triggers;
    const risk = [this.prohibition, manyRules, momentary].filter(Boolean).length;
    return { ...this.reminder, weight: (risk + 1) * (this.strongest || NO_RULE_COST) };
  }
}

/** The WHEN a node belongs to — itself, or the innermost one containing it — or null. */
function triggerOf(node: ApNode, containers: readonly ApNode[]): ApWhenNode | null {
  if (node.type === NODE.when) return node;
  return [...containers].reverse().find((container): container is ApWhenNode => container.type === NODE.when) ?? null;
}

/**
 * The corpus that says how rare a word is: the words of every distinct block
 * of the documents — one id, one block, however many documents hold it.
 * `bundle all` gives every document it compiles; one compilation alone, its
 * own document.
 */
export function corpusOf(documents: readonly ApDocument[]): string[] {
  const texts = new Map<string, string>();
  for (const document of documents) {
    const nodes = document.nodes();
    for (const block of document.all()) {
      if (texts.has(block.id)) continue;
      texts.set(block.id, Object.values(blockWords(block, nodes.filter(entry => entry.block === block).map(entry => entry.node))).flat().join('\n'));
    }
  }
  return [...texts.values()];
}

/** A document with its dashboard weighed again over `corpus` — the words' rarity over a wider set of blocks — as its compiled JSON. */
export function withCorpus(document: ApDocument, corpus: string[]): string {
  const compiled = document.meta.dashboard;
  if (compiled) document.meta.dashboard = dashboardOf(document, compiled.settings, corpus);
  return document.asJson();
}

/**
 * The reminders of a document, weighed: each block of rule lines and each
 * WHEN, outside the kinds the flow already points the agent at (a procedure,
 * a skill, a template, a flow), and never the agent's own block — it is the
 * agent. A line under a WHEN is the trigger's, never its block's. A word's
 * rarity is counted over the corpus (src/affinity/build.ts), never split
 * among the reminders.
 */
export function dashboardOf(document: ApDocument, settings: DashboardConfig, corpus: string[] = corpusOf([document])): ApDashboard {
  const candidates = new Candidates();
  const nodes = document.nodes();
  const root = document.root();
  for (const { node, block, containers } of nodes) {
    const trigger = triggerOf(node, containers);
    if (strategyOf(block.kind)?.pointedAt || (!trigger && block === root)) continue;
    candidates.of(block, trigger).hold(node);
  }
  const ruleLines = nodes.filter(({ node }) => ruleOf(node) !== null).length;
  const kept = candidates.kept();
  return {
    settings,
    reminders: kept.map(candidate => candidate.weighed(ruleLines > settings.manyRules)),
    index: buildIndex(kept.map(candidate => candidate.entry(settings.fields)), {}, { corpus }),
  };
}

/** The candidates of a document, as its walk meets them: one per block, one per WHEN. */
class Candidates {
  private readonly rules = new Map<ApBlock, Candidate>();
  private readonly triggers = new Map<ApWhenNode, Candidate>();
  /** Each block's WHENs, by node, with their keys. */
  private readonly keys = new Map<ApWhenNode, string>();

  /** The candidate a line of `block` belongs to: the WHEN it is under, else its block. */
  of(block: ApBlock, trigger: ApWhenNode | null): Candidate {
    if (trigger) return this.triggerOf(block, trigger);
    const known = this.rules.get(block);
    if (known) return known;
    const created = new Candidate({ key: block.id, kind: DASHBOARD_KIND.rules, block: block.id }, blockWords(block, []));
    this.rules.set(block, created);
    return created;
  }

  /** Every block of rule lines, then every trigger. */
  kept(): Candidate[] {
    return [...[...this.rules.values()].filter(rule => rule.holdsRules), ...this.triggers.values()];
  }

  private triggerOf(block: ApBlock, trigger: ApWhenNode): Candidate {
    const known = this.triggers.get(trigger);
    if (known) return known;
    if (!this.keys.has(trigger)) for (const [key, node] of triggerKeys(block)) this.keys.set(node, key);
    const key = this.keys.get(trigger) ?? '';
    const created = new Candidate({ key, kind: DASHBOARD_KIND.triggers, block: block.id, when: trigger.condition }, { name: [trigger.condition], about: [], lines: [] });
    this.triggers.set(trigger, created);
    return created;
  }
}
