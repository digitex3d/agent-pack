#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico

import { init } from './src/commands/init.js';
import { bundle } from './src/commands/bundle.js';
import { agents } from './src/commands/agents.js';
import { harness } from './src/commands/harness.js';
import { driver } from './src/commands/driver.js';
import { CREDIT } from './src/credits.js';
import { banner, isPreRelease } from './reporters/pretty/logo.js';
import { packageInfo, packageVersion } from './src/config.js';

const [command, ...rest] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = { init, bundle, agents, harness, driver };

if (command === '--version') {
  const version = packageVersion();
  console.log(`agent-pack ${version}${isPreRelease(version) ? ' (pre-release)' : ''}\n${CREDIT}`);
  process.exit(0);
}

if (!command || command === '--help') {
  // On a terminal the banner opens the help; a pipe or NO_COLOR reads it as text.
  const header = process.stdout.isTTY && !('NO_COLOR' in process.env)
    ? `\n${banner(packageInfo(), { links: true, columns: process.stdout.columns }).join('\n')}`
    : `agent-pack — ${packageInfo().description}\n${CREDIT}`;
  console.log(`${header}

Commands:
  init                           Write a default agent-pack.config.mjs and the .agent-pack/ dir
  bundle <name|path>             Compile a bundle (agent or skill); use --adapter to
                                 materialize for a target harness
  bundle all                     Compile every discovered agent for the configured adapters
  agents list                    List discoverable agents grouped by domain (project, global,
                                 library); filter with --domain, machine output with --json
  harness list                   The harnesses a delegation can go to (BY <harness>:<agent>): installed,
                                 enabled in the config, delegable, CLI on the PATH; --json
  driver test <driver>           Run the store-driver contract on a driver: files, tabeli, or a
                                 module or path, with --options '<json>'; exits 1 when a case fails

Options:
  --config <path>   Path to config file (default: ./agent-pack.config.mjs)
  --adapter <name>  Materialize for a target harness (bundle / bundle all)
  --out <dir>       Output directory override (bundle / bundle all)
  --watch           Rebuild on .ap changes (bundle all only)
  --apx-compress    Store the apx data gzipped; --no-apx-compress stores it as JSON (bundle / bundle all)
  --no-judge        Skip the judge phase (bundle / bundle all)
  --judge-strict    A line the judge cannot check yet is an error, not a warning (bundle / bundle all)
  --plain           One line per message, no colour — the default when the output is no terminal (bundle / bundle all)
  --verbose         List every file written (bundle / bundle all)
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
