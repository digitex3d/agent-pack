// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The driver contract, as cases — what every driver must answer, the same
 * for the shipped one and for anyone's. The test suite runs it on files;
 * `agent-pack driver test <module>` runs it on a driver of the config,
 * so its author knows it holds before publishing it.
 *
 * Each case opens a fresh store in its own folder. Values are compared as
 * text: an engine may answer a number as a string.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApSlot } from '../apdoc/types.js';
import type { Collection, Doc, StoreDriver, StoreRef } from './types.js';

/** One case of the contract, and how it went. */
export interface ContractResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const slot = (name: string, type: ApSlot['type']): ApSlot => ({ name, optional: false, type, rules: [], chars: 0 });

const SLOTS: ApSlot[] = [
  slot('topic', { kind: 'text' }),
  slot('status', { kind: 'enum', values: ['open', 'done'] }),
  slot('n', { kind: 'number' }),
];

class Broken extends Error {}

/** How many records the limit case asks for. */
const LIMIT = 2;

/** An operation beyond the base ones, bound to its collection — a case fails when the driver declares it and lacks it. */
function need<T extends (...args: never[]) => unknown>(collection: Collection, fn: T | undefined, name: string): T {
  if (!fn) throw new Broken(`the driver declares the capability of ${name} and its collection has no ${name}`);
  return fn.bind(collection) as T;
}

function expect(cond: boolean, detail: string): void {
  if (!cond) throw new Broken(detail);
}

const same = (doc: Doc | null | undefined, fields: Doc): boolean =>
  !!doc && Object.entries(fields).every(([field, value]) => String(doc[field]) === String(value));

const ids = (docs: Doc[]): string => docs.map(doc => String(doc.topic ?? doc.id)).join(',');

type Case = (c: Collection) => Promise<void>;

/** Three records, a, b, c: open 3, open 10, done 7. */
async function seed(collection: Collection): Promise<void> {
  await collection.put({ topic: 'a', status: 'open', n: 3 });
  await collection.put({ topic: 'b', status: 'open', n: 10 });
  await collection.put({ topic: 'c', status: 'done', n: 7 });
}

const BASE: Record<string, Case> = {
  'put adds a record, with an id': async collection => {
    const result = await collection.put({ topic: 'a', status: 'open', n: 3 });
    expect(!result.updated && result.id !== '', `put answered ${JSON.stringify(result)}`);
    expect(same(await collection.get('a'), { id: result.id, topic: 'a', status: 'open', n: 3 }), 'get a does not answer what was put');
  },
  'put with a KEY already there updates that record': async collection => {
    const first = await collection.put({ topic: 'a', status: 'open', n: 3 });
    const again = await collection.put({ topic: 'a', status: 'done', n: 4 });
    expect(again.updated && again.id === first.id, `the second put answered ${JSON.stringify(again)}`);
    const all = await collection.find([]);
    expect(all.length === 1 && same(all[0], { status: 'done', n: 4 }), `find answers ${JSON.stringify(all)}`);
  },
  'get answers null for a key never put': async collection => {
    expect(await collection.get('nope') === null, 'get nope answered a record');
  },
  'find answers every record, in the order they were added': async collection => {
    await seed(collection);
    expect(ids(await collection.find([])) === 'a,b,c', `find answered ${ids(await collection.find([]))}`);
  },
  'find filters by =, !=, numbers and ~': async collection => {
    await seed(collection);
    const by = async (field: string, op: '=' | '!=' | '>' | '<=' | '~', value: string): Promise<string> => ids(await collection.find([{ field, op, value }]));
    expect(await by('status', '=', 'open') === 'a,b', 'status=open');
    expect(await by('status', '!=', 'open') === 'c', 'status!=open');
    expect(await by('n', '>', '5') === 'b,c', 'n>5 must compare as numbers (10 > 5)');
    expect(await by('n', '<=', '7') === 'a,c', 'n<=7');
    expect(await by('topic', '~', 'b') === 'b', 'topic~b');
    expect(ids(await collection.find([{ field: 'status', op: '=', value: 'open' }, { field: 'n', op: '>', value: '5' }])) === 'b', 'two filters hold together');
  },
  'find stops at limit': async collection => {
    await seed(collection);
    expect(ids(await collection.find([], LIMIT)) === 'a,b', `limit ${LIMIT}`);
  },
  'set changes some fields and keeps the others': async collection => {
    await seed(collection);
    expect(await collection.set('b', { status: 'done' }) === 'set', 'set b');
    expect(same(await collection.get('b'), { topic: 'b', status: 'done', n: 10 }), 'b after set');
    expect(await collection.set('nope', { status: 'done' }) === 'missing', 'set nope must answer missing');
  },
  'remove takes a record away': async collection => {
    await seed(collection);
    expect(await collection.remove('a'), 'remove a');
    expect(await collection.get('a') === null, 'a is still there');
    expect(!(await collection.remove('a')), 'removing a again must answer false');
    expect(ids(await collection.find([])) === 'b,c', 'the others stay');
  },
};

/** Cases on a store with no KEY: a record is reached by its id. */
const KEYLESS: Record<string, Case> = {
  'without a KEY, put always adds, and get and remove take the id': async collection => {
    const first = await collection.put({ topic: 'a', status: 'open', n: 3 });
    const second = await collection.put({ topic: 'a', status: 'open', n: 3 });
    expect(!second.updated && first.id !== second.id, `two puts answered ${JSON.stringify([first, second])}`);
    expect(same(await collection.get(first.id), { id: first.id, topic: 'a' }), 'get <id>');
    expect(await collection.remove(first.id), 'remove <id>');
    expect(ids(await collection.find([])) === 'a' && (await collection.find([]))[0].id === second.id, 'the other record stays');
  },
};

const CAPABLE: Record<'take' | 'guard' | 'since', Record<string, Case>> = {
  guard: {
    'set … if refuses a stale belief': async collection => {
      await seed(collection);
      expect(await collection.set('a', { status: 'done' }, [{ field: 'status', op: '=', value: 'done' }]) === 'stale', 'a guard that does not hold');
      expect(same(await collection.get('a'), { status: 'open' }), 'a stale set must write nothing');
      expect(await collection.set('a', { status: 'done' }, [{ field: 'status', op: '=', value: 'open' }]) === 'set', 'a guard that holds');
    },
  },
  take: {
    'take hands out each matching record once, then nothing': async collection => {
      await seed(collection);
      const open = [{ field: 'status', op: '=' as const, value: 'open' }];
      const take = need(collection, collection.take, 'take');
      const first = await take(open, { status: 'done' });
      const second = await take(open, { status: 'done' });
      expect(same(first, { topic: 'a', status: 'done' }) && same(second, { topic: 'b', status: 'done' }), `take answered ${ids([first, second].filter((doc): doc is Doc => !!doc))}`);
      expect(await take(open, { status: 'done' }) === null, 'an empty queue must answer null');
    },
  },
  since: {
    'since answers what was added or changed after a mark, and only that': async collection => {
      await seed(collection);
      const mark = await need(collection, collection.mark, 'mark')();
      await collection.set('b', { n: 11 });
      await collection.put({ topic: 'd', status: 'open', n: 1 });
      const changed = await need(collection, collection.since, 'since')(mark);
      expect(!!changed && ids(changed).split(',').sort().join(',') === 'b,d', `since answered ${changed ? ids(changed) : 'null'}`);
    },
  },
};

/** The cases the driver must pass — the base ones, and those of each capability it declares — each with the KEY of its store. */
function casesOf(driver: StoreDriver): [string, Case, string | null][] {
  const keyed = (cases: Record<string, Case>): [string, Case, string | null][] => Object.entries(cases).map(([caseName, testCase]) => [caseName, testCase, 'topic']);
  const extra = driver.capabilities.flatMap(cap => keyed(CAPABLE[cap] ?? {}));
  return [...keyed(BASE), ...Object.entries(KEYLESS).map(([caseName, testCase]): [string, Case, null] => [caseName, testCase, null]), ...extra];
}

/** A fresh project store, in its own folder under the system's temporary one. */
function freshStore(driver: StoreDriver, root: string, index: number, key: string | null): StoreRef {
  const decl = { name: `contract${index}`, agent: 'driver-test', about: null, key, lasts: 'project' as const, slots: SLOTS };
  return { ...decl, root, path: join(root, driver.location(decl)), collection: `driver-test.contract${index}` };
}

/** Run the contract on a driver: one result per case, in order. */
export async function runDriverContract(driver: StoreDriver): Promise<ContractResult[]> {
  const root = mkdtempSync(join(tmpdir(), 'agent-pack-driver-'));
  const results: ContractResult[] = [];
  try {
    let caseIndex = 0;
    for (const [name, run, key] of casesOf(driver)) {
      try {
        await run(await driver.open(freshStore(driver, root, ++caseIndex, key)));
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}
