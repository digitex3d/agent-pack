// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `store` service — a STORE block's records, through the table behind it
 * (its TYPE's plugin: tabeli). `<apx> store <op> <sto-id> …` forwards the
 * operation to the table, after checking a write against the store's slots;
 * `a` with the KEY already present updates that record instead of duplicating it.
 */
import { basename, join } from 'node:path';
import type { StoreBlock } from '../../apdoc/blocks.js';
import { projectStoreDir } from '../paths.js';
import { openTable, runTable, upsertBy } from '../tabeli.js';
import { validateRecord, slotSpecsOf, formatIssues } from '../../shapeSchema.js';
import type { ApxHost, ApxService } from '../service.js';

interface Store {
  block: StoreBlock;
  name: string;
  key: string | null;
  location: string;
  path: string;
}

/** The operations of a tabeli table the service names; any other is forwarded as well. */
const OPERATIONS = [
  { op: 'a', args: '<sto-id> <field>=<value> …', about: 'add a record — with the KEY already present, update it instead' },
  { op: 'q', args: '<sto-id> [<field>=<value> …] [count]', about: 'query records, or count them' },
  { op: 's', args: '<sto-id> <id> <field>=<value> … [if <field>=<value>]', about: 'set fields of a record — `if` refuses a stale belief' },
  { op: 'next', args: '<sto-id> <field>=<value> set <field>=<value>', about: 'take the next record atomically — two agents never get the same one' },
  { op: 'manual', args: '<sto-id>', about: "the table's own manual" },
];

export const storeService: ApxService = {
  kind: 'store',
  about: 'read or write a store, through its table',
  operations: OPERATIONS,
  serve(host, op, args) {
    const stores = storesOf(host);
    if (!op) {
      if (stores.length === 0) host.out('# this agent has no stores');
      for (const s of stores) host.out(`${s.block.id}  ${s.name}  ${s.location}`);
      return 0;
    }
    const [id, ...rest] = args;
    const store = id ? stores.find(s => s.block.id === id) : undefined;
    if (!store) {
      const known = stores.map(s => `${s.block.id} (${s.name})`).join(', ') || 'none';
      return host.fail(2, `${id ? `no store \`${id}\` in this agent` : 'store takes an id (sto-…)'} — its stores: ${known}; e.g. ${host.cmd} store q <sto-id>`);
    }
    return serveStore(host, store, op === 'manual' ? [] : [op, ...rest]);
  },
};

/** The stores, each with its table file — the location is from the project root. */
function storesOf(host: ApxHost): Store[] {
  const projections = host.doc.mdSource?.stores ?? {};
  return (host.doc.byKind('store') as StoreBlock[]).map(block => {
    const location = projections[block.address]?.location ?? `${projectStoreDir(host.root.name)}/${block.name}.tbl`;
    return { block, name: block.name, key: block.storeKey, location, path: join(host.projectRoot, location) };
  });
}

/** Forward `[op …]` to the store's tabeli table, creating it on first use. */
function serveStore(host: ApxHost, store: Store, args: string[]): number {
  const refused = writeIssues(store, args);
  if (refused) return host.fail(2, `${store.name}: ${refused} — nothing was written`);
  const unopened = openTable(store.path, host.build.tabeli);
  if (unopened) return host.fail(2, unopened);
  const i = args[0] === 'a' && store.key ? args.findIndex((kv, j) => j > 0 && kv.startsWith(`${store.key}=`)) : -1;
  let run;
  if (i > 0) {
    let upsert;
    try {
      upsert = upsertBy(store.path, store.key!, args[i].slice(store.key!.length + 1), [...args.slice(1, i), ...args.slice(i + 1)]);
    } catch (e) {
      return host.fail(2, `${store.name}: ${e instanceof Error ? e.message : e} — nothing was written`);
    }
    if (upsert.updated !== null) host.out(`# ${args[i]} exists as id=${upsert.updated} — updated, not duplicated`);
    run = upsert.run;
  } else {
    run = runTable(store.path, args);
  }
  // errors and manuals name the .tbl — say it in this executable's own words
  const table = basename(store.path);
  const mine = `${host.cmd} store <op> ${store.block.id}`;
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`.split(`./${table}`).join(mine).split(table).join(mine).trimEnd();
  if (text) host.out(text);
  return run.status ?? 2;
}

/**
 * A write checked against the store's schema before it reaches the table: `a`
 * adds a whole record (every required slot, the KEY included), `s <id>` sets
 * some fields; either way no unknown field and no value outside its slot type.
 */
function writeFields(args: string[]): { add: boolean; pairs: string[] } | null {
  if (args[0] === 'a') return { add: true, pairs: args.slice(1) };
  if (args[0] === 's') {
    const end = args.indexOf('if');
    return { add: false, pairs: args.slice(2, end === -1 ? undefined : end) };
  }
  return null;
}

/** What is wrong with a write against the store's slots — or null when it fits. */
function writeIssues(store: Store, args: string[]): string | null {
  const write = writeFields(args);
  if (!write) return null;
  const record: Record<string, unknown> = {};
  for (const pair of write.pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return `\`${pair}\` is not a field=value pair`;
    const field = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const slot = store.block.slots.find(sl => sl.name === field);
    record[field] = slot?.type.kind === 'number' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
  }
  const issues = validateRecord(record, slotSpecsOf(store.block.slots, !write.add));
  return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
}
