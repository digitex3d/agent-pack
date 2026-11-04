// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterPlugin, AgentBundle, Emitter } from '../types.js';
import { descriptionOf } from '../skill-frontmatter.js';
import type { BudgetModels } from '../budget.js';
import { makeClaudeSkillEmitter } from '../claude-code/emitters/claude-skill.js';

/**
 * OpenAI Codex adapter — the same two sides as claude-code (D66).
 *
 * Out, the agents in Codex's native form (learn.chatgpt.com/docs, Subagents
 * and Build skills):
 *   .codex/agents/<name>.toml      — one custom agent per file: `name`, `description`, `developer_instructions`
 *   .agents/skills/<name>/SKILL.md — a skill: `name` and `description` frontmatter, as every harness with skills reads it
 * Codex reads AGENTS.md itself, where agent-pack writes the project context
 * and the orchestration: no project pointer.
 *
 * In, `invoke.ap`: how an agent on another harness hands Codex a task —
 * `codex exec` in the delegation's copy, the answer written with `-o`, its
 * form bound with `--output-schema` when the delegation has an AS, its model
 * with `-m` when the agent's `BUDGET` tier maps to one (the config's `models`;
 * none by default: codex's own). Codex picks a custom agent by the name its
 * prompt gives: the prompt opens with it.
 *
 * Not carried over from claude-code, Codex having no equivalent the docs
 * describe: a session id its commands can read (session variables and the
 * apx's registry fail closed), a hook input that tells a subagent from the
 * main session (the perimeter hook is claude-code's), a memory an agent file
 * switches on, a fork of the conversation.
 */
export interface CodexOptions {
  agentsDir?: string;   // default: '.codex/agents'
  skillsDir?: string;   // default: '.agents/skills'
  /** The model of each `BUDGET` tier, as `codex -m` takes it — none by default. */
  models?: BudgetModels;
}

/** A TOML string: a multi-line literal string, or — when the text holds `'''` — a basic one, escaped. */
export function tomlString(text: string): string {
  if (!text.includes("'''")) return `'''\n${text}'''`;
  return `"""\n${text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')}"""`;
}

/** One custom agent, as Codex reads it from `.codex/agents/<name>.toml`. */
export function agentToml(b: AgentBundle): string {
  return [
    `name = ${JSON.stringify(b.name)}`,
    `description = ${JSON.stringify(descriptionOf(b))}`,
    `developer_instructions = ${tomlString(b.body.endsWith('\n') ? b.body : `${b.body}\n`)}`,
    '',
  ].join('\n');
}

export default function codexAdapter(opts: CodexOptions = {}): AdapterPlugin {
  const agentsDir = opts.agentsDir ?? '.codex/agents';
  const agentEmitter: Emitter<AgentBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, agentsDir, `${b.name}.toml`),
    content: agentToml(b),
  }];
  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'codex',
    emitters: { agent: agentEmitter, skill: makeClaudeSkillEmitter(opts.skillsDir ?? '.agents/skills') },
    ...(opts.models ? { models: opts.models } : {}),
    invocation: {
      recipe: resolve(dirname(fileURLToPath(import.meta.url)), 'invoke.ap'),
      cli: 'codex',
      shape: '--output-schema {schema}',
      model: '-m {model}',
      // A copy of the project holds what git tracks; the generated definitions often are not.
      carry: [`${agentsDir}/{agent}.toml`, 'AGENTS.md'],
      intro: 'Have the custom agent `{agent}` carry out the task below, and answer with its result.',
    },
  };
}
