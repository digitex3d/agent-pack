// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The store API — the one way the apx reaches stored data: the stores an
 * agent declares (`STORE` blocks), the store a dimension keeps its answers
 * in, and the engine's own tables (session variables, checks, executions,
 * the registry of background work — src/apx/engineStores.ts). Nothing else
 * in the apx opens a driver (test/engineStores.test.mjs keeps it so).
 *
 * What does not depend on the engine is done here, once, for every driver:
 * resolving a store to its driver and its place on disk, checking a write
 * against the store's slots, parsing filters, refusing an operation the
 * driver lacks, and writing the answers in one format. A driver only
 * translates the operations.
 */
import { extname, join } from 'node:path';
import type { StoreBlock } from '../apdoc/blocks.js';
import type { ApSlot } from '../apdoc/types.js';
import { formatIssues, slotSpecsOf, validateRecord } from '../shapeSchema.js';
import { filtersOn } from '../storeDrivers/filters.js';
import { installDriver, storeDriverNames, storeDriverOf, useTabeliEngine, type DriverEntry } from '../storeDrivers/registry.js';
import type { Collection, Doc, DriverCapability, Filter, MaybePromise, StoreDecl, StoreDriver, StoreLifetime, StoreRef } from '../storeDrivers/types.js';
import { CACHE_DIR, STATE_DIR } from './paths.js';
import type { ApxContext } from './service.js';

/**
 * What a store declares, wherever it is declared: a `STORE` block is one
 * (src/apdoc/blocks.ts), and so is a table the engine declares in code.
 */
export interface StoreSpec {
  id: string;
  name: string;
  about: string | null;
  slots: ApSlot[];
  /** The slot named by `KEY`, or null: records are then reached by id. */
  storeKey: string | null;
  storeDriver: string;
  lasts: StoreLifetime;
}

/**
 * Where a store's data lives: under the driver's own rule for an agent's
 * store, in the dimensions' cache, or in a session's folder of the state
 * directory for the engine's tables.
 */
export type StorePlace =
  | { kind: 'agent' }
  | { kind: 'cache'; defhash: string }
  | { kind: 'session'; id: string };

/** A store resolved: its declaration, its driver, where its data lives. */
export interface OpenStore {
  spec: StoreSpec;
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
export function installRecorded(host: ApxContext): Promise<void> {
  driversReady ??= (async () => {
    useTabeliEngine(host.build.tabeli);
    for (const driver of (host.build.drivers ?? []) as DriverEntry[]) await installDriver(driver.module, driver.options);
  })();
  return driversReady;
}

/**
 * A store resolved from its declaration — the one place a driver is looked
 * up and a path is decided. Throws a StoreRefusal when the driver is not
 * installed.
 */
export function resolveStore(spec: StoreSpec, root: string, agent: string, place: StorePlace): OpenStore {
  const driver = storeDriverOf(spec.storeDriver);
  if (!driver) throw new StoreRefusal(STORE_EXIT.usage, `store ${spec.name}: no driver "${spec.storeDriver}" (installed: ${storeDriverNames().join(', ')}) — run agent-pack bundle all`);
  // The cache reaches a record by its own `_key` and outlives the session, whatever the STORE says.
  const decl: StoreDecl = place.kind === 'cache'
    ? { agent, name: spec.name, about: spec.about, key: '_key', lasts: 'project', slots: spec.slots }
    : { agent, name: spec.name, about: spec.about, key: spec.storeKey, lasts: spec.lasts, slots: spec.slots };
  const [location, collection] = placeOf(spec, agent, place, driver.location(decl));
  return { spec, driver, ref: { ...decl, root, path: join(root, location), collection } };
}

/** Where a store's file sits under the root, and the name of its collection — `own` is the driver's own rule for an agent's store. */
function placeOf(spec: StoreSpec, agent: string, place: StorePlace, own: string): [string, string] {
  const ext = extname(own) || '.store';
  switch (place.kind) {
    case 'agent': return [own, `${agent}.${spec.name}`];
    case 'cache': return [`${CACHE_DIR}/${place.defhash}${ext}`, `dimension_${place.defhash}`];
    case 'session': return [`${STATE_DIR}/${place.id}/${spec.name}${ext}`, `session.${place.id}.${spec.name}`];
  }
}

/** The agent's stores, each with its driver and its data's place. */
export async function storesOf(host: ApxContext): Promise<OpenStore[]> {
  await installRecorded(host);
  return (host.doc.agentStores() as StoreBlock[]).map(block => resolveStore(block, host.projectRoot, host.root.name, { kind: 'agent' }));
}

/** Refuse an operation the store's driver does not keep. */
export function requireCapability(store: OpenStore, capability: DriverCapability, op: string): void {
  if (!store.driver.capabilities.includes(capability)) {
    throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: the ${store.driver.name} driver has no ${op} — nothing was done`);
  }
}

/** An operation beyond the base ones, open — refused when the driver does not keep it, or declares it and lacks it. */
export async function optionalOp<K extends 'take' | 'mark' | 'since'>(store: OpenStore, op: K, capability: DriverCapability): Promise<NonNullable<Collection[K]>> {
  requireCapability(store, capability, op);
  const collection = await open(store);
  const fn = collection[op];
  if (!fn) throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: the ${store.driver.name} driver declares ${capability} and has no ${op}`);
  return fn.bind(collection) as NonNullable<Collection[K]>;
}

/** `field=value` arguments as a record, numbers read as numbers where the slot says so. */
export function fieldsOf(store: OpenStore, args: readonly string[]): Doc {
  const doc: Doc = {};
  for (const pair of args) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: \`${pair}\` is not a field=value pair — nothing was written`);
    const field = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const slot = store.spec.slots.find(sl => sl.name === field);
    doc[field] = slot?.type.kind === 'number' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
  return doc;
}

/** A write checked against the store's slots: a whole record for `put`, some fields for `set`. */
export function checkWrite(store: OpenStore, doc: Doc, whole: boolean): void {
  const issues = validateRecord(doc, slotSpecsOf(store.spec.slots, !whole));
  if (issues.length > 0) throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: ${formatIssues(issues).replace(/\n/g, '; ')} — nothing was written`);
}

/** `<field><op><value>` arguments as filters, every field one of the store's (or `id`). */
export function filtersOf(store: OpenStore, args: readonly string[]): Filter[] {
  const filters = filtersOn(args, store.spec.slots.map(slot => slot.name), 'id');
  if (typeof filters === 'string') throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: ${filters}`);
  return filters;
}

/** The store's records, open — at once when the driver answers at once, as the engine's own tables need. */
export function open(store: OpenStore): MaybePromise<Collection> {
  return store.driver.open(store.ref);
}

/** A value as one shell word: bare when it is one, else in single quotes. */
function word(value: string | number): string {
  const text = String(value);
  return /^[^\s'"\\]+$/.test(text) ? text : `'${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'")}'`;
}

/** Fields as one line: `<field>=<value> …`, a value with spaces or quotes in single quotes. */
export function fieldsText(fields: Record<string, unknown>): string {
  return Object.entries(fields).map(([field, value]) => `${field}=${word(value as string | number)}`).join(' ');
}

/** A record as one line: `id=<id>` first, then its fields. */
export function recordLine(doc: Doc): string {
  const { id, ...fields } = doc;
  return [`id=${id}`, fieldsText(fields)].filter(Boolean).join(' ');
}

/** How many records, in the words every answer ends with. */
export const countLine = (count: number): string => `# ${count} record${count === 1 ? '' : 's'}`;
