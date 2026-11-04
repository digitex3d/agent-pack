// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AdapterPlugin, AgentBundle, Emitter } from '../types.js';
import { descriptionOf } from '../skill-frontmatter.js';
import { makeClaudeSkillEmitter } from '../claude-code/emitters/claude-skill.js';

/**
 * opencode adapter — the same two sides as claude-code and codex (D66).
 *
 * Out, the agents in opencode's native form (opencode.ai/docs, Agents and Skills):
 *   .opencode/agents/<name>.md     — one agent per file, named by the file: `description` frontmatter, the instructions as body
 *   .agents/skills/<name>/SKILL.md — a skill: `name` and `description` frontmatter, as every harness with skills reads it
 * No `mode` is written: opencode's default, `all`, lets `opencode run --agent`
 * launch the agent and a primary agent call it as a subagent. opencode reads
 * AGENTS.md itself, where agent-pack writes the project context and the
 * orchestration: no project pointer.
 *
 * In, `invoke.ap`: how an agent on another harness hands opencode a task —
 * `opencode run --agent` in the delegation's copy, the prompt on stdin, the
 * answer filtered out of its JSON events into the answer file, with the
 * permissions opencode refused on its own (no `--auto`) for the launching
 * harness to decide on.
 *
 * Not carried over: a flag binding the answer's form (opencode has none — the
 * form is asked for in the prompt), a sandbox (opencode has none — a request
 * outside the copy is refused), and what codex also lacks: a session id, a
 * hook input telling a subagent from the main session, a fork.
 */
export interface OpencodeOptions {
  agentsDir?: string;   // default: '.opencode/agents'
  skillsDir?: string;   // default: '.agents/skills'
}

/** One agent, as opencode reads it from `.opencode/agents/<name>.md` — the description quoted, so a colon cannot break the frontmatter. */
export function agentMarkdown(b: AgentBundle): string {
  return ['---', `description: ${JSON.stringify(descriptionOf(b))}`, '---', b.body.endsWith('\n') ? b.body : `${b.body}\n`].join('\n');
}

export default function opencodeAdapter(opts: OpencodeOptions = {}): AdapterPlugin {
  const agentsDir = opts.agentsDir ?? '.opencode/agents';
  const agentEmitter: Emitter<AgentBundle> = (b, ctx) => [{
    path: resolve(ctx.projectRoot, agentsDir, `${b.name}.md`),
    content: agentMarkdown(b),
  }];
  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'opencode',
    emitters: { agent: agentEmitter, skill: makeClaudeSkillEmitter(opts.skillsDir ?? '.agents/skills') },
    invocation: {
      recipe: resolve(dirname(fileURLToPath(import.meta.url)), 'invoke.ap'),
      cli: 'opencode',
      // A copy of the project holds what git tracks; the generated definitions often are not.
      carry: [`${agentsDir}/{agent}.md`, 'AGENTS.md'],
    },
  };
}
