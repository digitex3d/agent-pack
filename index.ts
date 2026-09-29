#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico

import { init } from './src/commands/init.js';
import { bundle } from './src/commands/bundle.js';
import { agents } from './src/commands/agents.js';
import { readFileSync } from 'fs';
import { CREDIT } from './src/credits.js';

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = { init, bundle, agents };

if (command === '--version') {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
  console.log(`agent-pack ${version}\n${CREDIT}`);
  process.exit(0);
}

if (!command || command === '--help') {
  console.log(`agent-pack — a programming language to orchestrate agents across every harness
${CREDIT}

Commands:
  init                           Write a default agent-pack.config.mjs and the .agent-pack/ dir
  bundle <name|path>             Compile a bundle (agent or *.playbook.ap); use --adapter to
                                 materialize for a target harness
  bundle all                     Compile every discovered agent for the configured adapters
  agents list                    List discoverable agents grouped by domain (project, global,
                                 library); filter with --domain, machine output with --json

Options:
  --config <path>   Path to config file (default: ./agent-pack.config.mjs)
  --adapter <name>  Materialize for a target harness (bundle / bundle all)
  --out <dir>       Output directory override (bundle / bundle all)
  --watch           Rebuild on .ap changes (bundle all only)
  --apx-compress    Store the apx data gzipped; --no-apx-compress stores it as JSON (bundle / bundle all)
  --help            Show this help
  --version         Show the version

Install and set up: https://github.com/digitex3d/agent-pack/blob/main/docs/guide/getting-started.md#install`);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}. Run "agent-pack --help" for usage.`);
  process.exit(1);
}

await commands[command](rest);
