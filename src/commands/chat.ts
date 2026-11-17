// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { realpathSync } from 'node:fs';
import { loadConfig, type Config } from '../config.js';
import { FORMULAS, fill } from '../formulas.js';
import { acpHarnessNames, acpHarnessOf } from '../../adapters/acp/index.js';
import { checkHarnessNames } from '../adapter-registry.js';
import { readChatFile, setupBoss, type ChatChoice } from './chatSetup.js';
import { runChat } from '../../adapters/acp/chat.js';
import { askHarness } from '../../adapters/acp/ask.js';
import { agentIndexOf } from '../compiler/index.js';

/**
 * CLI command: `agent-pack chat` — a terminal chat with the boss harness the
 * config names (`chat: { boss }`), over ACP (adapters/acp/chat.ts). The boss
 * is an ACP server of the config — an acp server, or a harness with its acp
 * option — or, when the config names none, the one picked at the chat's first
 * setup (chatSetup.ts).
 */
/**
 * How a shell runs this agent-pack: `node` and the script the chat was started
 * from, its real path — `agent-pack` itself may not be on the PATH.
 */
function agentPackCommand(): string {
  return `node ${realpathSync(process.argv[1])}`;
}

/**
 * The boss and the adapters a chat reaches: the config's `chat.boss` and its
 * adapters — else what the first setup kept (chatSetup.ts), its servers on the
 * config's adapters, the harness names checked as the config's are; when none
 * was kept, what `setup` picks. Null when neither. The chat and `ask` alike.
 */
export async function chatChoice(config: Config, root: string, setup?: () => Promise<ChatChoice | null>): Promise<ChatChoice | null> {
  if (config.chat?.boss) return { boss: config.chat.boss, adapters: config.adapters };
  const kept = readChatFile(root, config.adapters) ?? (setup ? await setup() : null);
  return kept && { boss: kept.boss, adapters: checkHarnessNames(kept.adapters) };
}

/** The chat's choice — on an interactive terminal, the first setup when none was kept. */
async function bossOf(config: Config, root: string): Promise<ChatChoice> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const chosen = await chatChoice(config, root, interactive ? () => setupBoss(root, { input: process.stdin, output: process.stdout }, config.adapters) : undefined);
  if (!chosen) throw new Error(FORMULAS.messages.chat.notSet);
  return chosen;
}

export async function chat(args: string[]): Promise<void> {
  const config = await loadConfig(args);
  const root = process.cwd();
  const { boss, adapters } = await bossOf(config, root);
  const found = acpHarnessOf(adapters, boss);
  if (!found) throw new Error(fill(FORMULAS.messages.chat.noServer, { boss }));
  const consult = { harnesses: acpHarnessNames(adapters).filter(name => name !== boss), agentPack: agentPackCommand() };
  const agents = [...new Set(agentIndexOf(config).map(agent => agent.name))].sort();
  const code = await runChat({
    root, boss, ...found, input: process.stdin, output: process.stdout, consult, agents,
    // The room's sends write their events to the chat's file; their refusals are there as verdicts — nothing to print.
    ask: (target, task, events, signal) => askHarness({ adapters, root, target, task, events, signal, report: () => { /* in the events */ } }),
  });
  process.exit(code);
}
