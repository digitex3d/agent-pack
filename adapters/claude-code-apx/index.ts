// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The claude-code-apx ADAPTER — claude-code, with one difference: the agent
 * file carries no compiled prompt. Under the same frontmatter it names the
 * agent's apx (`.agent-pack/apx/<name>.apx`, written by `bundle all` for every
 * agent) and says to start there. The apx explains itself; the definition is
 * read on demand, verb by verb, instead of being loaded whole.
 *
 * Everything else — skills, the CLAUDE.md pointer to AGENTS.md, the CONTEXT
 * renderings — is the claude-code adapter's, taken as is.
 */
import { resolve } from 'path';
import { AdapterPlugin, AgentBundle, Emitter } from '../types.js';
import claudeCodeAdapter, { ClaudeCodeOptions } from '../claude-code/index.js';
import { buildAgentFrontmatter } from '../claude-code/emitters/agent-md.js';
import { apxPath, apxCommand } from '../../src/apx/paths.js';
import { ApxEngine } from '../../src/apx/engine.js';
import type { ApDocument } from '../../src/apdoc/document.js';

const DEFAULT_TOOLS = '*';

export default function claudeCodeApxAdapter(opts: ClaudeCodeOptions = {}): AdapterPlugin {
  const base = claudeCodeAdapter(opts);
  return {
    ...base,
    name: 'claude-code-apx',
    emitters: {
      ...base.emitters,
      agent: makeApxAgentEmitter(opts.agentsDir ?? '.claude/agents', opts.tools ?? DEFAULT_TOOLS),
    },
  };
}

function makeApxAgentEmitter(agentsDir: string, tools: string): Emitter<AgentBundle> {
  return (b, ctx) => [{
    path: resolve(ctx.projectRoot, agentsDir, `${b.name}.md`),
    content: buildAgentFrontmatter(b, tools) + usageBody(b.name, b.structure),
  }];
}

/**
 * The body: the agent's own definition — perimeter, team, identity, mandate,
 * request and answer shapes, its own rules — in the md projection's words, the
 * same text the claude-code adapter writes and `apx get <agent>` prints, with
 * every reference as the apx command that fetches it. Then one instruction: the
 * rest — policies, templates, procedures, stores, flows — is read from the apx.
 */
export function usageBody(name: string, doc?: ApDocument): string {
  return [
    ...(doc ? [definitionOf(name, doc).trimEnd(), ''] : [`# You are \`${name}\``, '']),
    `The rest of your definition lives in \`${apxPath(name)}\`. Run it once, at the start of your work, and follow what it prints — if it asks a quiz, answer honestly ('?' when unsure):`,
    '',
    '```bash',
    apxCommand(name, 'start'),
    '```',
    '',
  ].join('\n');
}

/** The agent's definition, as its apx prints it. */
function definitionOf(name: string, doc: ApDocument): string {
  return new ApxEngine(doc, { builtAt: '', agentPackVersion: '', hash: '' }, apxPath(name), () => {}).definition();
}
