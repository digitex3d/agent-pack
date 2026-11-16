// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `store` service — a STORE block's records, through the store API
 * (src/apx/stores.ts). `<apx> store <op> <sto-id> …`: the verbs are the same
 * whatever driver keeps the store; a write is checked against the store's
 * slots before it reaches the driver.
 */
import {
  STORE_EXIT, StoreRefusal, checkWrite, countLine, fieldsOf, filtersOf, open, optionalOp, recordLine, requireCapability, storesOf, type OpenStore,
} from '../stores.js';
import type { ApxHost, ApxService } from '../service.js';
import { errorMessage } from '../../errors.js';

const OPERATIONS = [
  { op: 'put', args: '<sto-id> <field>=<value> …', about: 'add a record — with the KEY already present, update it instead' },
  { op: 'get', args: '<sto-id> <key>', about: 'one record, by its KEY (or its id when the store has no KEY)' },
  { op: 'find', args: '<sto-id> [<field><op><value> …] [limit=<n>] [count] [json]', about: 'the records every filter holds for, or how many' },
  { op: 'set', args: '<sto-id> <key> <field>=<value> … [if <field><op><value> …]', about: 'set fields of a record — `if` refuses a stale belief' },
  { op: 'remove', args: '<sto-id> <key>', about: 'remove a record' },
  { op: 'take', args: '<sto-id> [<field><op><value> …] set <field>=<value> …', about: 'take the next record atomically — two agents never get the same one' },
  { op: 'mark', args: '<sto-id>', about: 'a mark of now, for since' },
  { op: 'since', args: '<sto-id> <mark>', about: 'the records added or changed after a mark' },
];

type Op = (host: ApxHost, store: OpenStore, args: string[]) => Promise<number>;

/** Split `args` at the first `word`: what comes before, what comes after (null when absent). */
function splitAt(args: string[], word: string): [string[], string[] | null] {
  const at = args.indexOf(word);
  return at < 0 ? [args, null] : [args.slice(0, at), args.slice(at + 1)];
}

/** The one key an operation names, or a refusal saying how to write it. */
function keyArg(store: OpenStore, args: string[], op: string): string {
  if (!args[0]) throw new StoreRefusal(STORE_EXIT.usage, `${op} takes the record's ${store.spec.storeKey ?? 'id'}: store ${op} ${store.spec.id} <${store.spec.storeKey ?? 'id'}>`);
  return args[0];
}

const put: Op = async (host, store, args) => {
  const doc = fieldsOf(store, args);
  checkWrite(store, doc, true);
  const r = await (await open(store)).put(doc);
  const key = store.spec.storeKey;
  if (r.updated && key) host.out(`# ${key}=${String(doc[key])} exists as id=${r.id} — updated, not duplicated`);
  host.out(recordLine({ id: r.id, ...doc }));
  return 0;
};

const get: Op = async (host, store, args) => {
  const key = keyArg(store, args, 'get');
  const doc = await (await open(store)).get(key);
  if (!doc) return host.fail(STORE_EXIT.missing, `${store.spec.name}: no record ${key}`);
  host.out(args.includes('json') ? JSON.stringify(doc) : recordLine(doc));
  return 0;
};

const find: Op = async (host, store, args) => {
  const flags = new Set<string>(args.filter(a => a === 'count' || a === 'json'));
  const limitArg = args.find(a => a.startsWith('limit='));
  const limit = limitArg ? Number(limitArg.slice('limit='.length)) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new StoreRefusal(STORE_EXIT.usage, `${store.spec.name}: limit takes a whole number above 0`);
  const filters = filtersOf(store, args.filter(a => !flags.has(a) && a !== limitArg));
  const docs = await (await open(store)).find(filters, limit);
  if (flags.has('count')) host.out(countLine(docs.length));
  else if (flags.has('json')) host.out(JSON.stringify(docs));
  else {
    for (const d of docs) host.out(recordLine(d));
    host.out(countLine(docs.length));
  }
  return 0;
};

const set: Op = async (host, store, args) => {
  const key = keyArg(store, args, 'set');
  const [fieldArgs, guardArgs] = splitAt(args.slice(1), 'if');
  if (guardArgs) requireCapability(store, 'guard', 'set … if');
  const fields = fieldsOf(store, fieldArgs);
  checkWrite(store, fields, false);
  const r = await (await open(store)).set(key, fields, guardArgs ? filtersOf(store, guardArgs) : []);
  if (r === 'missing') return host.fail(STORE_EXIT.missing, `${store.spec.name}: no record ${key} — nothing was written`);
  if (r === 'stale') return host.fail(STORE_EXIT.stale, `${store.spec.name}: the condition no longer holds for ${key} — your view of it is stale: get it again`);
  host.out(`# ${key} set`);
  return 0;
};

const remove: Op = async (host, store, args) => {
  const key = keyArg(store, args, 'remove');
  if (!await (await open(store)).remove(key)) return host.fail(STORE_EXIT.missing, `${store.spec.name}: no record ${key}`);
  host.out(`# ${key} removed`);
  return 0;
};

const take: Op = async (host, store, args) => {
  const [filterArgs, setArgs] = splitAt(args, 'set');
  if (!setArgs || setArgs.length === 0) throw new StoreRefusal(STORE_EXIT.usage, `take marks what it takes: store take ${store.spec.id} <filters> set <field>=<value> …`);
  const fields = fieldsOf(store, setArgs);
  checkWrite(store, fields, false);
  const doc = await (await optionalOp(store, 'take', 'take'))(filtersOf(store, filterArgs), fields);
  if (!doc) return host.fail(STORE_EXIT.missing, `${store.spec.name}: no record matches — the queue is empty`);
  host.out(recordLine(doc));
  return 0;
};

const mark: Op = async (host, store) => {
  const m = await (await optionalOp(store, 'mark', 'since'))();
  host.out(`# mark=${m}`);
  host.out(`# later: store since ${store.spec.id} ${m}   -> only what changed since now`);
  return 0;
};

const since: Op = async (host, store, args) => {
  if (!args[0]) throw new StoreRefusal(STORE_EXIT.usage, `since takes a mark: store since ${store.spec.id} <mark> (from store mark)`);
  const docs = await (await optionalOp(store, 'since', 'since'))(args[0]);
  if (!docs) return host.fail(STORE_EXIT.usage, `${store.spec.name}: \`${args[0]}\` is no mark of this store — take one with store mark ${store.spec.id}`);
  for (const d of docs) host.out(recordLine(d));
  host.out(`${countLine(docs.length)} added or changed since the mark`);
  return 0;
};

const OPS: Record<string, Op> = { put, get, find, set, remove, take, mark, since };

/** `store` alone: the agent's stores, each with its driver and where its data lives. */
function list(host: ApxHost, stores: OpenStore[]): number {
  if (stores.length === 0) host.out('# this agent has no stores');
  for (const s of stores) host.out(`${s.spec.id}  ${s.spec.name}  ${s.driver.name}  ${s.driver.location(s.ref)}`);
  return 0;
}

/** The store an operation names by its id — or a refusal listing the agent's stores. */
function storeArg(host: ApxHost, stores: OpenStore[], id: string | undefined): OpenStore {
  const store = id ? stores.find(s => s.spec.id === id) : undefined;
  if (store) return store;
  const known = stores.map(s => `${s.spec.id} (${s.spec.name})`).join(', ') || 'none';
  throw new StoreRefusal(STORE_EXIT.usage, `${id ? `no store \`${id}\` in this agent` : 'store takes an id (sto-…)'} — its stores: ${known}; e.g. ${host.cmd} store find <sto-id>`);
}

/** One call of the service, its refusals thrown. */
async function serveOp(host: ApxHost, op: string | undefined, args: string[]): Promise<number> {
  const stores = await storesOf(host);
  if (!op) return list(host, stores);
  const run = OPS[op];
  if (!run) throw new StoreRefusal(STORE_EXIT.usage, `unknown store operation '${op}' — the operations: ${Object.keys(OPS).join(', ')}`);
  const [id, ...rest] = args;
  return await run(host, storeArg(host, stores, id), rest);
}

export const storeService: ApxService = {
  kind: 'store',
  about: 'read or write a store, through the store API',
  operations: OPERATIONS,
  async serve(host, op, args) {
    try {
      return await serveOp(host, op, args);
    } catch (e) {
      if (e instanceof StoreRefusal) return host.fail(e.code, e.message);
      return host.fail(STORE_EXIT.usage, errorMessage(e));
    }
  },
};
