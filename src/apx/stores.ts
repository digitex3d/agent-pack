// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The store API — the one way the apx reaches stored data. The `store`
 * service talks to it; nothing else in the apx opens a driver.
 *
 * What does not depend on the engine is done here, once, for every driver:
 * finding the store and its driver, checking a write against the store's
 * slots, parsing filters, refusing an operation the driver lacks, and writing
 * the answers in one format. A driver only translates the operations.
 */
import { join } from 'node:path';
import type { StoreBlock } from '../apdoc/blocks.js';
import { formatIssues, slotSpecsOf, validateRecord } from '../shapeSchema.js';
import { parseFilter } from '../storeDrivers/filters.js';
import { installDriver, storeDriverNames, storeDriverOf, useTabeliEngine, type DriverEntry } from '../storeDrivers/registry.js';
import type { Collection, Doc, DriverCapability, Filter, StoreDriver, StoreRef } from '../storeDrivers/types.js';
import type { ApxHost } from './service.js';

/** A store of the agent, resolved: its block, its driver, where its data lives. */
export interface OpenStore {
  block: StoreBlock;
  driver: StoreDriver;
  ref: StoreRef;
}

/** The exit codes of the store service: nothing found, wrong usage, a stale belief. */
export const STORE_EXIT = { missing: 1, usage: 2, stale: 4 };

/** Why a store operation did not go through — the exit code and the message the agent reads. */
export class StoreRefusal extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

let driversReady: Promise<void> | null = null;

/** Install, once per run, the drivers the apx's bundle recorded: the tabeli engine, then the config's own drivers. */
function installRecorded(host: ApxHost): Promise<void> {
  driversReady ??= (async () => {
    useTabeliEngine(host.build.tabeli);
    for (const d of (host.build.drivers ?? []) as DriverEntry[]) await installDriver(d.module, d.options);
  })();
  return driversReady;
}

/** The agent's stores, each with its driver and its data's place. */
export async function storesOf(host: ApxHost): Promise<OpenStore[]> {
  await installRecorded(host);
  return (host.doc.byKind('store') as StoreBlock[]).map(block => {
    const driver = storeDriverOf(block.storeDriver);
    if (!driver) throw new StoreRefusal(STORE_EXIT.usage, `store ${block.name}: no driver "${block.storeDriver}" (installed: ${storeDriverNames().join(', ')}) — run agent-pack bundle all`);
    const decl = block.decl(host.root.name);
    const location = driver.location(decl);
    return { block, driver, ref: { ...decl, root: host.projectRoot, path: join(host.projectRoot, location), collection: `${decl.agent}.${decl.name}` } };
  });
}

/** Refuse an operation the store's driver does not keep. */
export function requireCapability(store: OpenStore, capability: DriverCapability, op: string): void {
  if (!store.driver.capabilities.includes(capability)) {
    throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: the ${store.driver.name} driver has no ${op} — nothing was done`);
  }
}

/** An operation beyond the base ones, open — refused when the driver does not keep it, or declares it and lacks it. */
export async function optionalOp<K extends 'take' | 'mark' | 'since'>(store: OpenStore, op: K, capability: DriverCapability): Promise<NonNullable<Collection[K]>> {
  requireCapability(store, capability, op);
  const c = await open(store);
  const fn = c[op];
  if (!fn) throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: the ${store.driver.name} driver declares ${capability} and has no ${op}`);
  return fn.bind(c) as NonNullable<Collection[K]>;
}

/** `field=value` arguments as a record, numbers read as numbers where the slot says so. */
export function fieldsOf(store: OpenStore, args: readonly string[]): Doc {
  const doc: Doc = {};
  for (const pair of args) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: \`${pair}\` is not a field=value pair — nothing was written`);
    const field = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const slot = store.block.slots.find(sl => sl.name === field);
    doc[field] = slot?.type.kind === 'number' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
  return doc;
}

/** A write checked against the store's slots: a whole record for `put`, some fields for `set`. */
export function checkWrite(store: OpenStore, doc: Doc, whole: boolean): void {
  const issues = validateRecord(doc, slotSpecsOf(store.block.slots, !whole));
  if (issues.length > 0) throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: ${formatIssues(issues).replace(/\n/g, '; ')} — nothing was written`);
}

/** `<field><op><value>` arguments as filters, every field one of the store's (or `id`). */
export function filtersOf(store: OpenStore, args: readonly string[]): Filter[] {
  return args.map(arg => {
    const f = parseFilter(arg);
    if (!f) throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: \`${arg}\` is no filter — write <field><op><value>, op one of = != > < >= <= ~`);
    if (f.field !== 'id' && !store.block.slots.some(s => s.name === f.field)) {
      throw new StoreRefusal(STORE_EXIT.usage, `${store.block.name}: \`${f.field}\` is none of its fields (${store.block.slots.map(s => s.name).join(', ')})`);
    }
    return f;
  });
}

/** The store's records, open. */
export async function open(store: OpenStore): Promise<Collection> {
  return await store.driver.open(store.ref);
}

/** A value as one shell word: bare when it is one, else in single quotes. */
function word(value: string | number): string {
  const s = String(value);
  return /^[^\s'"\\]+$/.test(s) ? s : `'${s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'")}'`;
}

/** A record as one line: `id=<id>` first, then its fields. */
export function recordLine(doc: Doc): string {
  const { id, ...fields } = doc;
  return [`id=${id}`, ...Object.entries(fields).map(([f, v]) => `${f}=${word(v)}`)].join(' ');
}

/** How many records, in the words every answer ends with. */
export const countLine = (n: number): string => `# ${n} record${n === 1 ? '' : 's'}`;
