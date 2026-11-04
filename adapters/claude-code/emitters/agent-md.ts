// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'node:path';
import type { Emitter, AgentBundle } from '../../types.js';
import { collectFrontmatter, serializeFrontmatter, type FrontmatterField } from '../../../src/primitives.js';
import { someNode } from '../../../src/apdoc/nodes.js';
import { DEFAULT_DELEGATE } from '../../../src/config.js';
import { budgetModel, type BudgetModels } from '../../budget.js';

const DEFAULT_TOOLS = '*';

/** A YAML empty list: Claude Code then spawns the agent with no tool at all. */
const NO_TOOLS = '[]';

export interface AgentMdOptions {
  agentsDir: string;
  /** Tools string for the YAML `tools:` field. Defaults to "*". */
  tools?: string;
  /** The model of each `BUDGET` tier — the adapter's: {@link CLAUDE_BUDGET_MODELS}, with the config's over them. */
  models: BudgetModels;
}

export function makeAgentMdEmitter(opts: AgentMdOptions): Emitter<AgentBundle> {
  const tools = opts.tools ?? DEFAULT_TOOLS;
  return (b, ctx) => [
    {
      path: resolve(ctx.projectRoot, opts.agentsDir, `${b.name}.md`),
      content: buildAgentFrontmatter(b, tools, opts.models) + b.body,
    },
  ];
}

/**
 * Agent frontmatter: name, description (from ABOUT), tools (none for the default delegate), model — see
 * {@link modelOf}. An agent told to remember (`MEM`) gets
 * `memory: project`: Claude Code then gives it a memory directory and loads
 * its MEMORY.md at every start. Shared with the claude-code-apx adapter.
 * All scalar values pass through `quoteIfNeeded` (claude-code agent convention
 * differs from skill convention which does not quote).
 */
export function buildAgentFrontmatter(b: AgentBundle, tools: string, models: BudgetModels): string {
  const description = collectFrontmatter(b.metadata, 'claude-code').find(f => f.key === 'description');
  const fields: FrontmatterField[] = [
    { key: 'name', value: b.name },
    { key: 'description', value: typeof description?.value === 'string' ? description.value : b.name },
    { key: 'tools', value: isQuick(b) ? NO_TOOLS : tools },
    { key: 'model', value: modelOf(b, models) },
    ...(remembers(b) ? [{ key: 'memory', value: 'project' }] : []),
  ].map(f => Array.isArray(f.value) || f.value === NO_TOOLS ? f : { ...f, value: quoteIfNeeded(f.value as string) });

  // The perimeter's hook is the project's, in its settings (emitters/guard-hook.ts): no agent carries one.
  return `${serializeFrontmatter(fields)}\n`;
}

/**
 * The delegate shipped with the package: it answers from the input it is handed
 * alone, so it runs on a fast model and gets no tool — it cannot read a file.
 */
function isQuick(b: AgentBundle): boolean {
  return b.name === DEFAULT_DELEGATE;
}

/** Claude Code's model for each `BUDGET` tier, unless the config maps them otherwise. */
export const CLAUDE_BUDGET_MODELS: BudgetModels = { cheap: 'haiku', moderate: 'sonnet', costly: 'opus' };

/**
 * The agent's model: its `BUDGET` tier's, when it declares one; else the
 * `delegate.models` config key's (in the document's meta); else, for the default
 * delegate shipped with the package, a fast model — Claude Code's haiku; else `inherit`.
 */
function modelOf(b: AgentBundle, models: BudgetModels): string {
  return budgetModel(models, b) ?? b.structure?.meta.model ?? (isQuick(b) ? 'haiku' : 'inherit');
}

/** Whether the agent is told to save anything to memory — any `MEM` level but `!MEM`. */
function remembers(b: AgentBundle): boolean {
  return b.structure?.all().some(block =>
    someNode(block.body, n => n.type === 'directive' && n.keyword === 'MEM' && (n.force ?? 0) >= 0)) ?? false;
}

function quoteIfNeeded(value: string): string {
  if (/^[a-z0-9_-]+$/i.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
