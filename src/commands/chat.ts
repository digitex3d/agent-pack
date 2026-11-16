// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { realpathSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { FORMULAS, fill } from '../formulas.js';
import { acpHarnessNames, acpHarnessOf } from '../../adapters/acp/index.js';
import { runChat } from '../../adapters/acp/chat.js';
import { askHarness } from '../../adapters/acp/ask.js';
import { agentIndexOf } from '../compiler/index.js';

/**
 * CLI command: `agent-pack chat` — a terminal chat with the boss harness the
 * config names (`chat: { boss }`), over ACP (adapters/acp/chat.ts). The boss
 * must be an ACP server of the config — an acp server, or a harness with its
 * acp option: there is no default.
 */
/**
 * How a shell runs this agent-pack: `node` and the script the chat was started
 * from, its real path — `agent-pack` itself may not be on the PATH.
 */
function agentPackCommand(): string {
  return `node ${realpathSync(process.argv[1])}`;
}

export async function chat(args: string[]): Promise<void> {
  const config = await loadConfig(args);
  const boss = config.chat?.boss;
  if (!boss) throw new Error(FORMULAS.messages.chat.notSet);
  const found = acpHarnessOf(config.adapters, boss);
  if (!found) {
    throw new Error(fill(FORMULAS.messages.chat.noServer, { boss }));
  }
  const consult = { harnesses: acpHarnessNames(config.adapters).filter(name => name !== boss), agentPack: agentPackCommand() };
  const root = process.cwd();
  const agents = [...new Set(agentIndexOf(config).map(agent => agent.name))].sort();
  const code = await runChat({
    root, boss, ...found, input: process.stdin, output: process.stdout, consult, agents,
    // The room's sends write their events to the chat's file; their refusals are there as verdicts — nothing to print.
    ask: (target, task, events, signal) => askHarness({ adapters: config.adapters, root, target, task, events, signal, report: () => { /* in the events */ } }),
  });
  process.exit(code);
}
