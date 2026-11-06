// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The driver contract, as cases — what every driver must answer, the same
 * for the shipped ones and for anyone's. The test suite runs it on files and
 * tabeli; `agent-pack driver test <module>` runs it on a driver of the config,
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
function need<T extends (...args: never[]) => unknown>(c: Collection, fn: T | undefined, name: string): T {
  if (!fn) throw new Broken(`the driver declares the capability of ${name} and its collection has no ${name}`);
  return fn.bind(c) as T;
}

function expect(cond: boolean, detail: string): void {
  if (!cond) throw new Broken(detail);
}

const same = (doc: Doc | null | undefined, fields: Doc): boolean =>
  !!doc && Object.entries(fields).every(([f, v]) => String(doc[f]) === String(v));

const ids = (docs: Doc[]): string => docs.map(d => String(d.topic ?? d.id)).join(',');

type Case = (c: Collection) => Promise<void>;

/** Three records, a, b, c: open 3, open 10, done 7. */
async function seed(c: Collection): Promise<void> {
  await c.put({ topic: 'a', status: 'open', n: 3 });
  await c.put({ topic: 'b', status: 'open', n: 10 });
  await c.put({ topic: 'c', status: 'done', n: 7 });
}

const BASE: Record<string, Case> = {
  'put adds a record, with an id': async c => {
    const r = await c.put({ topic: 'a', status: 'open', n: 3 });
    expect(!r.updated && r.id !== '', `put answered ${JSON.stringify(r)}`);
    expect(same(await c.get('a'), { id: r.id, topic: 'a', status: 'open', n: 3 }), 'get a does not answer what was put');
  },
  'put with a KEY already there updates that record': async c => {
    const first = await c.put({ topic: 'a', status: 'open', n: 3 });
    const again = await c.put({ topic: 'a', status: 'done', n: 4 });
    expect(again.updated && again.id === first.id, `the second put answered ${JSON.stringify(again)}`);
    const all = await c.find([]);
    expect(all.length === 1 && same(all[0], { status: 'done', n: 4 }), `find answers ${JSON.stringify(all)}`);
  },
  'get answers null for a key never put': async c => {
    expect(await c.get('nope') === null, 'get nope answered a record');
  },
  'find answers every record, in the order they were added': async c => {
    await seed(c);
    expect(ids(await c.find([])) === 'a,b,c', `find answered ${ids(await c.find([]))}`);
  },
  'find filters by =, !=, numbers and ~': async c => {
    await seed(c);
    const by = async (field: string, op: '=' | '!=' | '>' | '<=' | '~', value: string): Promise<string> => ids(await c.find([{ field, op, value }]));
    expect(await by('status', '=', 'open') === 'a,b', 'status=open');
    expect(await by('status', '!=', 'open') === 'c', 'status!=open');
    expect(await by('n', '>', '5') === 'b,c', 'n>5 must compare as numbers (10 > 5)');
    expect(await by('n', '<=', '7') === 'a,c', 'n<=7');
    expect(await by('topic', '~', 'b') === 'b', 'topic~b');
    expect(ids(await c.find([{ field: 'status', op: '=', value: 'open' }, { field: 'n', op: '>', value: '5' }])) === 'b', 'two filters hold together');
  },
  'find stops at limit': async c => {
    await seed(c);
    expect(ids(await c.find([], LIMIT)) === 'a,b', `limit ${LIMIT}`);
  },
  'set changes some fields and keeps the others': async c => {
    await seed(c);
    expect(await c.set('b', { status: 'done' }) === 'set', 'set b');
    expect(same(await c.get('b'), { topic: 'b', status: 'done', n: 10 }), 'b after set');
    expect(await c.set('nope', { status: 'done' }) === 'missing', 'set nope must answer missing');
  },
  'remove takes a record away': async c => {
    await seed(c);
    expect(await c.remove('a'), 'remove a');
    expect(await c.get('a') === null, 'a is still there');
    expect(!(await c.remove('a')), 'removing a again must answer false');
    expect(ids(await c.find([])) === 'b,c', 'the others stay');
  },
};

/** Cases on a store with no KEY: a record is reached by its id. */
const KEYLESS: Record<string, Case> = {
  'without a KEY, put always adds, and get and remove take the id': async c => {
    const first = await c.put({ topic: 'a', status: 'open', n: 3 });
    const second = await c.put({ topic: 'a', status: 'open', n: 3 });
    expect(!second.updated && first.id !== second.id, `two puts answered ${JSON.stringify([first, second])}`);
    expect(same(await c.get(first.id), { id: first.id, topic: 'a' }), 'get <id>');
    expect(await c.remove(first.id), 'remove <id>');
    expect(ids(await c.find([])) === 'a' && (await c.find([]))[0].id === second.id, 'the other record stays');
  },
};

const CAPABLE: Record<'take' | 'guard' | 'since', Record<string, Case>> = {
  guard: {
    'set … if refuses a stale belief': async c => {
      await seed(c);
      expect(await c.set('a', { status: 'done' }, [{ field: 'status', op: '=', value: 'done' }]) === 'stale', 'a guard that does not hold');
      expect(same(await c.get('a'), { status: 'open' }), 'a stale set must write nothing');
      expect(await c.set('a', { status: 'done' }, [{ field: 'status', op: '=', value: 'open' }]) === 'set', 'a guard that holds');
    },
  },
  take: {
    'take hands out each matching record once, then nothing': async c => {
      await seed(c);
      const open = [{ field: 'status', op: '=' as const, value: 'open' }];
      const take = need(c, c.take, 'take');
      const first = await take(open, { status: 'done' });
      const second = await take(open, { status: 'done' });
      expect(same(first, { topic: 'a', status: 'done' }) && same(second, { topic: 'b', status: 'done' }), `take answered ${ids([first, second].filter((d): d is Doc => !!d))}`);
      expect(await take(open, { status: 'done' }) === null, 'an empty queue must answer null');
    },
  },
  since: {
    'since answers what was added or changed after a mark, and only that': async c => {
      await seed(c);
      const m = await need(c, c.mark, 'mark')();
      await c.set('b', { n: 11 });
      await c.put({ topic: 'd', status: 'open', n: 1 });
      const changed = await need(c, c.since, 'since')(m);
      expect(!!changed && ids(changed).split(',').sort().join(',') === 'b,d', `since answered ${changed ? ids(changed) : 'null'}`);
    },
  },
};

/** The cases the driver must pass — the base ones, and those of each capability it declares — each with the KEY of its store. */
function casesOf(driver: StoreDriver): [string, Case, string | null][] {
  const keyed = (cases: Record<string, Case>): [string, Case, string | null][] => Object.entries(cases).map(([n, c]) => [n, c, 'topic']);
  const extra = driver.capabilities.flatMap(cap => keyed(CAPABLE[cap] ?? {}));
  return [...keyed(BASE), ...Object.entries(KEYLESS).map(([n, c]): [string, Case, null] => [n, c, null]), ...extra];
}

/** A fresh project store, in its own folder under the system's temporary one. */
function freshStore(driver: StoreDriver, root: string, n: number, key: string | null): StoreRef {
  const decl = { name: `contract${n}`, agent: 'driver-test', about: null, key, lasts: 'project' as const, slots: SLOTS };
  return { ...decl, root, path: join(root, driver.location(decl)), collection: `driver-test.contract${n}` };
}

/** Run the contract on a driver: one result per case, in order. */
export async function runDriverContract(driver: StoreDriver): Promise<ContractResult[]> {
  const root = mkdtempSync(join(tmpdir(), 'agent-pack-driver-'));
  const results: ContractResult[] = [];
  try {
    let n = 0;
    for (const [name, run, key] of casesOf(driver)) {
      try {
        await run(await driver.open(freshStore(driver, root, ++n, key)));
        results.push({ name, ok: true });
      } catch (e) {
        results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return results;
}
