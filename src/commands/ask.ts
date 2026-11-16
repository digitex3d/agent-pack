// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { realpathSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { askHarness } from '../../adapters/acp/ask.js';
import { printUsage } from './usage.js';

/**
 * CLI command: `agent-pack ask <harness>[:<agent>] "<task>"` — one task, run on a
 * harness of the config reached over ACP — as that agent of the project, when named — (an acp server, or a harness with its
 * acp option), through the ACP client: the folder the command runs in is its
 * session's cwd and its perimeter. The answer is printed on stdout; a refusal
 * is said on stderr. Inside a chat (`AGENT_PACK_CHAT_EVENTS` set) its events
 * go to the chat's log, under the harness's name, as any delegation's.
 */
export async function ask(args: string[]): Promise<void> {
  const [target, task] = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--config');
  if (!target || !task) {
    printUsage('agent-pack ask <harness>[:<agent>] "<task>"');
    process.exit(1);
  }
  const config = await loadConfig(args);
  const answer = await askHarness({
    adapters: config.adapters, root: realpathSync(process.cwd()), target, task,
    report: line => process.stderr.write(`acp ${target}: ${line}\n`),
  });
  process.stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
}
