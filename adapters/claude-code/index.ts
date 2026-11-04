// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AdapterPlugin } from '../types.js';
import { makeAgentMdEmitter, CLAUDE_BUDGET_MODELS } from './emitters/agent-md.js';
import type { BudgetModels } from '../budget.js';
import { makeClaudeSkillEmitter } from './emitters/claude-skill.js';
import { compileWorkflow } from './workflow.js';
import { installGuardHook } from './emitters/guard-hook.js';

export interface ClaudeCodeOptions {
  agentsDir?: string;
  skillsDir?: string;
  /** Tools field rendered into each agent's YAML frontmatter. Defaults to "*". */
  tools?: string;
  /** The model of each `BUDGET` tier, over Claude Code's own (haiku, sonnet, opus) — the config's `models`. */
  models?: BudgetModels;
}

export default function claudeCodeAdapter(opts: ClaudeCodeOptions = {}): AdapterPlugin {
  const models = { ...CLAUDE_BUDGET_MODELS, ...opts.models };
  return {
    type: 'adapter',
    apiVersion: 2,
    name: 'claude-code',
    emitters: {
      agent: makeAgentMdEmitter({
        agentsDir: opts.agentsDir ?? '.claude/agents',
        tools: opts.tools,
        models,
      }),
      skill: makeClaudeSkillEmitter(opts.skillsDir ?? '.claude/skills'),
    },
    // Claude Code reads CLAUDE.md; `@AGENTS.md` imports the project context and
    // the orchestration agent-pack writes there.
    projectPointer: { file: 'CLAUDE.md', content: '@AGENTS.md' },
    models,
    // The perimeter is kept by one hook of the project, which runs inside subagents too (D65).
    projectSettings: (projectRoot, { guarded }) => installGuardHook(projectRoot, guarded),
    // Claude Code exports its session id to every command it runs: the apx keeps
    // session variables under it.
    sessionEnv: 'CLAUDE_CODE_SESSION_ID',
    // Every flow compiles to a Workflow tool script: Claude Code runs the steps.
    flowScript: { ext: 'js', compile: compileWorkflow },
    // How an agent on another harness hands one of these agents a task (D66): `claude -p --agent` in the delegation's copy.
    invocation: {
      recipe: resolve(dirname(fileURLToPath(import.meta.url)), 'invoke.ap'),
      cli: 'claude',
      // A copy of the project holds what git tracks; the generated definitions often are not.
      carry: [`${opts.agentsDir ?? '.claude/agents'}/{agent}.md`],
    },
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
      // A skill of the harness (`IMPORT … FROM @harness.skills`) is loaded with the Skill tool.
      SKILL: {
        harness: 'Load it when you need it with the Skill tool: `{name}`.',
      },
      // Work in the background is a background agent: Claude Code tells the session when one ends.
      DELEGATE: {
        background: ' — launch it as a background agent (the Agent tool, run_in_background: true) and go on: its WAIT takes it back',
      },
      // A fork is Claude Code's own: it inherits the conversation; working as another agent, it first reads who that agent is (D61).
      FORK: {
        self: '{text} — a native fork of yourself (the Agent tool, subagent_type: "fork"), with this whole conversation{shaped}{background}',
        agent: '{text} — a native fork (the Agent tool, subagent_type: "fork") that works as `{agent}`: tell it to read who `{agent}` is first, with {definition}, and to follow that agent\'s rules from there{shaped}{background}',
      },
      // The word that a background agent ended arrives between turns: a WAIT never blocks the session on a command (D60).
      WAIT: {
        run: ' — do not go on until the notification of each one has come (Claude Code sends one when a background agent ends): one that ended without delivering is `{apx} delegate ended <id>`; then `{apx} wait {ids} --now{max}`: each one\'s state, its limit counted from its start — one still running past it is yours to decide: wait for its notification, `{apx} delegate take <dlg-id>`, `{apx} delegate reassign <dlg-id> <agent>` or `{apx} delegate block <dlg-id> "<why>"`',
      },
    },
  };
}
