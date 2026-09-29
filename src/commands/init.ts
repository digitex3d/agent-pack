// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { EXAMPLES_DIR } from '../config.js';

const CONFIG_FILE = 'agent-pack.config.mjs';
const STATE_DIR = '.agent-pack';

/** Example agents offered at init, each copied to agents/standalone/<name>.ap on a yes. */
const EXAMPLES = [
  { name: 'agent-pack-developer', about: 'writes and edits your .ap files' },
  { name: 'web-researcher', about: 'researches a question on the web and answers with sources' },
];

const DEFAULT_CONFIG = `export default {
  // built-in adapters, by name: claude-code, claude-code-apx, cursor, junie
  adapters: ['claude-code'],
};
`;

/**
 * Set up agent-pack in the current directory: write a default config and the
 * state directory, then offer the example agents as a starting point.
 * Idempotent — existing files are never overwritten.
 */
export async function init(_args: string[]): Promise<void> {
  const cwd = process.cwd();

  const configPath = resolve(cwd, CONFIG_FILE);
  if (existsSync(configPath)) {
    console.log(`= ${CONFIG_FILE} (already exists)`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG, 'utf-8');
    console.log(`+ ${CONFIG_FILE}`);
  }

  const stateDir = resolve(cwd, STATE_DIR);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
    console.log(`+ ${STATE_DIR}/`);
  }

  for (const example of EXAMPLES) {
    const target = `agents/standalone/${example.name}.ap`;
    const targetPath = resolve(cwd, target);
    if (existsSync(targetPath)) continue;
    if (!await askYesNo(`Install the ${example.name} agent (${example.about})?`)) continue;
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(resolve(EXAMPLES_DIR, `${example.name}.ap`), targetPath);
    console.log(`+ ${target}`);
  }

  console.log('\nNext: write your agents under agents/, then run `agent-pack bundle all`.');
}

/** Ask a yes/no question on the terminal (default yes). Never asks when not interactive. */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
