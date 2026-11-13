// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Store-driver registry — what `DRIVER` in a STORE block resolves to.
 *
 * Two drivers ship and need no config: `files`, the default, and `tabeli`.
 * Any other is a module the project names in its config (`drivers:`), written
 * by anyone: its default export is a factory taking the entry's options and
 * answering a driver. The compiler installs it when the config loads; the
 * apx, which runs apart, imports the same module again from the path the
 * bundle recorded — so a driver's options travel as JSON, and a secret never
 * does: an option names the environment variable that holds it.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import filesDriver from './files/index.js';
import { tabeliDriver } from './tabeli/index.js';
import { DRIVER_API, type StoreDriver } from './types.js';

/** A driver of the config, as the apx records it: the module to import again and the options to call it with. */
export interface DriverEntry {
  name: string;
  module: string;
  options: Record<string, unknown>;
}

const BUILTIN = new Set(['files', 'tabeli']);
const installed = new Map<string, StoreDriver>([['files', filesDriver], ['tabeli', tabeliDriver()]]);

/** Resolve a `DRIVER` value. Null when none is installed by that name — callers report, never guess. */
export function storeDriverOf(name: string): StoreDriver | null {
  return installed.get(name.trim()) ?? null;
}

/** Every installed driver's name, for error messages that teach. */
export function storeDriverNames(): string[] {
  return [...installed.keys()].sort();
}

/** Put the tabeli driver back with the engine an apx records: it opens its tables with it. */
export function useTabeliEngine(engine: string | undefined): void {
  installed.set('tabeli', tabeliDriver(engine));
}

/** Why a value is no driver this agent-pack can run, or null when it is one. */
function driverIssue(driver: unknown, module: string): string | null {
  const candidate = driver as Partial<StoreDriver> | null;
  if (candidate?.type !== 'driver' || typeof candidate.name !== 'string' || typeof candidate.open !== 'function' || typeof candidate.location !== 'function') {
    return `${module}: its default export, called with the entry's options, must answer a driver ({ type: 'driver', name, api, capabilities, location, open })`;
  }
  if (candidate.api !== DRIVER_API) return `${module}: driver "${candidate.name}" is written for driver API ${String(candidate.api)}, this agent-pack runs API ${DRIVER_API}`;
  if (BUILTIN.has(candidate.name)) return `${module}: "${candidate.name}" is the name of a driver agent-pack ships — give the driver another name`;
  return null;
}

/** Import a driver module, call its factory with the options, and install the driver it answers. */
export async function installDriver(file: string, options: Record<string, unknown>): Promise<StoreDriver> {
  const mod = await import(pathToFileURL(file).href) as { default?: unknown };
  if (typeof mod.default !== 'function') throw new Error(`${file}: a driver module's default export is a factory, (options) => driver`);
  const driver: unknown = await (mod.default as (o: Record<string, unknown>) => unknown)(options);
  const issue = driverIssue(driver, file);
  if (issue) throw new Error(issue);
  installed.set((driver as StoreDriver).name, driver as StoreDriver);
  return driver as StoreDriver;
}

/**
 * The config's `drivers:` entries, installed: each one a module specifier,
 * or `{ module, …options }` — a package name or a path, resolved from the
 * project root. Answers what an apx needs to install them again.
 */
export async function loadDrivers(entries: readonly unknown[], projectRoot: string): Promise<DriverEntry[]> {
  const require = createRequire(join(projectRoot, 'package.json'));
  const loaded: DriverEntry[] = [];
  for (const entry of entries) {
    const { module, ...options } = typeof entry === 'string' ? { module: entry } : entry as { module?: unknown };
    if (typeof module !== 'string') throw new Error("a driver is a module name or path, or { module: '<name or path>', …options }");
    const file = require.resolve(module.startsWith('.') ? join(projectRoot, module) : module);
    const driver = await installDriver(file, options);
    loaded.push({ name: driver.name, module: file, options });
  }
  return loaded;
}
