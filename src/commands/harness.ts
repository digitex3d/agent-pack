// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { loadConfig } from '../config.js';
import { harnessesOf, type HarnessRow } from '../harnesses.js';
import { printUsage } from './usage.js';
import { JSON_FLAG } from '../apx/verbs.js';

/**
 * CLI command: `agent-pack harness list` — the harnesses a delegation can go
 * to (D66): installed (shipped, or an adapter object of the config), enabled
 * (the config's `adapters:`), delegable (enabled, with a launch recipe), and
 * whether the recipe's CLI is on the PATH — looked up, never run.
 */
const usage = (): void => printUsage('agent-pack harness list [--json]');

const yes = (value: boolean | null) => (value === null ? '—' : value ? 'yes' : 'no');

/** The rows as a table: one column per list, the CLI last. */
export function renderHarnessTable(rows: readonly HarnessRow[]): string {
  const cells = [
    ['harness', 'installed', 'enabled', 'delegable', 'via', 'cli on PATH'],
    ...rows.map(row => [row.name, 'yes', yes(row.enabled), yes(row.enabled && row.invocation !== null), row.transport ?? '—', row.invocation ? `${row.invocation.cli}: ${yes(row.onPath)}` : '—']),
  ];
  const widths = cells[0].map((_header, column) => Math.max(...cells.map(row => row[column].length)));
  return cells.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

export async function harness(args: string[]): Promise<void> {
  const config = await loadConfig(args);
  const sub = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--config');
  if (sub !== 'list') {
    usage();
    process.exit(1);
  }
  const rows = harnessesOf(config.adapters);
  if (args.includes(JSON_FLAG)) {
    console.log(JSON.stringify(rows.map(row => ({
      harness: row.name, installed: true, enabled: row.enabled, delegable: row.enabled && row.invocation !== null,
      via: row.transport, cli: row.invocation?.cli ?? null, onPath: row.onPath, ...(row.problem ? { problem: row.problem } : {}),
    })), null, 2));
    return;
  }
  console.log(renderHarnessTable(rows));
}
