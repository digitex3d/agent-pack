// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'node:path';
import { runDriverContract } from '../storeDrivers/contract.js';
import { loadDrivers, storeDriverOf } from '../storeDrivers/registry.js';
import type { StoreDriver } from '../storeDrivers/types.js';
import { printUsage } from './usage.js';

/**
 * CLI command: `agent-pack driver test <driver>` — runs the driver contract
 * (src/storeDrivers/contract.ts) on a store driver: the shipped one by name
 * (files), or a module — a package name or a path — called with the
 * options of `--options '<json>'`. Exits 1 when a case fails.
 */
const usage = (): void => printUsage("agent-pack driver test <files | module or path> [--options '<json>']");

/** The driver under test: a shipped one by name, else the module, installed with its options. */
async function driverUnderTest(target: string, options: Record<string, unknown>): Promise<StoreDriver> {
  const shipped = storeDriverOf(target);
  if (shipped && Object.keys(options).length === 0) return shipped;
  const [entry] = await loadDrivers([{ module: target.startsWith('.') ? resolve(target) : target, ...options }], process.cwd());
  const loaded = storeDriverOf(entry.name);
  if (!loaded) throw new Error(`${target}: installed, then not found by its name ${entry.name}`);
  return loaded;
}

export async function driver(args: string[]): Promise<void> {
  const [sub, target] = args;
  if (sub !== 'test' || !target) {
    usage();
    process.exit(1);
  }
  const at = args.indexOf('--options');
  const tested = await driverUnderTest(target, at >= 0 ? JSON.parse(args[at + 1] ?? '{}') as Record<string, unknown> : {});
  const results = await runDriverContract(tested);
  for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  const failed = results.filter(result => !result.ok).length;
  console.log(`\n${tested.name}: ${results.length - failed} of ${results.length} cases hold (capabilities: ${tested.capabilities.join(', ') || 'none'})`);
  process.exit(failed > 0 ? 1 : 0);
}
