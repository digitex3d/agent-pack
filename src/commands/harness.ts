// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { loadConfig } from '../config.js';
import { harnessesOf, type HarnessRow } from '../harnesses.js';
import { printUsage } from './usage.js';

/**
 * CLI command: `agent-pack harness list` — the harnesses a delegation can go
 * to (D66): installed (shipped, or an adapter object of the config), enabled
 * (the config's `adapters:`), delegable (enabled, with a launch recipe), how
 * the recipe reaches it (its own CLI, or `acp` — an acp server, or a harness
 * with the acp option), and whether the recipe's CLI is on the PATH — looked
 * up, never run.
 */
const usage = (): void => printUsage('agent-pack harness list [--json]');

const yes = (v: boolean | null) => (v === null ? '—' : v ? 'yes' : 'no');

/** The rows as a table: one column per list, the CLI last. */
export function renderHarnessTable(rows: readonly HarnessRow[]): string {
  const cells = [
    ['harness', 'installed', 'enabled', 'delegable', 'via', 'cli on PATH'],
    ...rows.map(row => [row.name, 'yes', yes(row.enabled), yes(row.enabled && row.invocation !== null), row.transport ?? '—', row.invocation ? `${row.invocation.cli}: ${yes(row.onPath)}` : '—']),
  ];
  const widths = cells[0].map((_, k) => Math.max(...cells.map(row => row[k].length)));
  return cells.map(row => row.map((c, k) => c.padEnd(widths[k])).join('  ').trimEnd()).join('\n');
}

export async function harness(args: string[]): Promise<void> {
  const config = await loadConfig(args);
  const sub = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--config');
  if (sub !== 'list') {
    usage();
    process.exit(1);
  }
  const rows = harnessesOf(config.adapters);
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows.map(r => ({
      harness: r.name, installed: true, enabled: r.enabled, delegable: r.enabled && r.invocation !== null,
      via: r.transport, cli: r.invocation?.cli ?? null, onPath: r.onPath, ...(r.problem ? { problem: r.problem } : {}),
    })), null, 2));
    return;
  }
  console.log(renderHarnessTable(rows));
}
