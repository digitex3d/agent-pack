// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { AdapterPlugin } from '../types.js';
import { makeAgentMdEmitter } from './emitters/agent-md.js';
import { makeClaudeSkillEmitter } from './emitters/claude-skill.js';
import { compileWorkflow } from './workflow.js';

export interface ClaudeCodeOptions {
  agentsDir?: string;
  skillsDir?: string;
  /** Tools field rendered into each agent's YAML frontmatter. Defaults to "*". */
  tools?: string;
}

export default function claudeCodeAdapter(opts: ClaudeCodeOptions = {}): AdapterPlugin {
  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'claude-code',
    emitters: {
      agent: makeAgentMdEmitter({
        agentsDir: opts.agentsDir ?? '.claude/agents',
        tools: opts.tools,
      }),
      playbook: makeClaudeSkillEmitter(opts.skillsDir ?? '.claude/skills'),
    },
    // Claude Code reads CLAUDE.md; `@AGENTS.md` imports the project context and
    // the orchestration agent-pack writes there.
    projectPointer: { file: 'CLAUDE.md', content: '@AGENTS.md' },
    // Every flow compiles to a Workflow tool script: Claude Code runs the steps.
    flowScript: { ext: 'js', compile: compileWorkflow },
    // CONTEXT modes compiled down to the concrete Claude Code delegation call.
    // `inherited` is the one mode that trades executor identity for native
    // context: a fork clones the caller, not the agent the step's By names.
    renderings: {
      // Claude Code's own memory: with `memory:` in the frontmatter (set for
      // every agent that uses MEM) the agent has a memory directory whose
      // MEMORY.md is loaded at every start.
      MEM: {
        '-1': 'Never save to your agent memory:',
        '0': 'You may save to your agent memory, to act on it directly next time:',
        '1': 'You should save to your agent memory, to act on it directly next time:',
        '2': 'You must always save to your agent memory, to act on it directly next time:',
      },
      // What `apx flow <id>` prints when the flow has its Workflow script. The
      // Workflow tool runs only on the user's own opt-in, so the steps stay the
      // way when it is missing — and for a flow whose steps talk with the user.
      FLOW: {
        run: 'run this flow with the Workflow tool: Workflow({ scriptPath: "{script}", args: { request: "<the request, verbatim>" } }) — the result is every step\'s answer, in order. Only when the user asked for this flow, or asked for a workflow or ultracode; otherwise, or when a step must talk with the user, carry out its steps yourself: {steps}',
      },
      CONTEXT: {
        isolated:  "launch the step's executor with the Agent tool, its prompt carrying only the step's own intent — no upstream context",
        summary:   "launch the step's executor with the Agent tool, its prompt carrying a synthesized digest of the upstream context, provenance preserved",
        full:      "launch the step's executor with the Agent tool, reproducing the full upstream context in the prompt",
        inherited: 'launch with the Agent tool as subagent_type: "fork" — the fork natively inherits the whole conversation context; it is a clone of the caller, not of the agent the step names',
      },
    },
  };
}
