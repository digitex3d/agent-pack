# Store drivers

A [`STORE`](/reference/language#store) says what an agent keeps: its fields, what identifies a record, how long it lasts. A **driver** says how it is kept: a JSON file, a tabeli table, a database. The agent never sees it — it reads and writes the store with the [same commands](./apx.md#stores) whatever driver keeps it, and the apx's store API turns them into the driver's operations.

Two drivers ship and need no config:

| Driver | Keeps a store in | Needs |
|---|---|---|
| `files` — the default | one JSON file per store, written under a lock | nothing |
| `tabeli` | a tabeli table (`.tbl`) | the engine agent-pack builds: `make` and a C compiler |

A store names its driver with `DRIVER <name>`; without the line it is kept by `files`.

## Adding a driver

Any other driver is a module the project names in its config, by package name or path:

```js
// agent-pack.config.mjs
export default {
  drivers: [
    'agent-pack-driver-sqlite',
    { module: './drivers/notion.mjs', token: 'NOTION_TOKEN', databases: { 'pm.backlog': '1f2e…' } },
  ],
};
```

A string is the module; an object is the module and the options its factory is called with. The driver is installed before any store compiles, under the name it answers — `DRIVER sqlite` then resolves to it — and `bundle all` records the module and its options in every `.apx`, which imports it again when a store needs it. A driver may not take the name of a shipped one.

The options travel into the `.apx` as JSON, so they never hold a secret: an option **names the environment variable** that holds one (`token: 'NOTION_TOKEN'`), and the driver reads it when it opens a store.

## Writing a driver

A driver module's default export is a factory: it takes the entry's options and answers the driver.

```js
export default function myDriver(options = {}) {
  return {
    type: 'driver',
    name: 'my-driver',          // what DRIVER <name> writes
    api: 1,                     // the contract version it was written for
    capabilities: ['take'],     // what it adds to the base operations: take, guard, since
    location(store) { … },      // where the store's data lives, from the project root
    rejectsStore(store) { … },  // optional: why it cannot keep this store at all, or null
    rejects(slot) { … },        // optional: why it cannot keep this slot, or null
    open(store) { … },          // the store's records, open: a collection
  };
}
```

`location`, `rejectsStore` and `rejects` run at compile time: a store the driver cannot keep fails the build, not the first write. `open` runs in the apx, with the store as the store API resolved it — its `name`, `agent`, `key`, `lasts` and `slots`, the project `root`, the absolute `path` of its `location`, and a `collection` name unique to it in the project.

The collection answers a handful of operations, each one synchronously or with a promise. `key` is the value of the store's `KEY` slot, or a record's `id` when the store has none; every record a driver answers carries its `id`, as text.

| Operation | Answers |
|---|---|
| `put(doc)` | `{ id, updated }` — adds the record; with the `KEY` already present, replaces that record's fields instead |
| `get(key)` | the record, or `null` |
| `find(filters, limit?)` | the records every filter holds for, in the order they were added; at most `limit` |
| `set(key, fields, guard?)` | `'set'`, `'missing'` when there is no such record, `'stale'` when a `guard` filter does not hold — then nothing is written |
| `remove(key)` | `true`, or `false` when there was none |
| `take(filters, fields)` — capability `take` | the first record the filters hold for, `fields` set on it in the same step; two callers never get the same one; `null` when none |
| `mark()`, `since(mark)` — capability `since` | a mark of now; then the records added or changed after it, or `null` when the mark is none of this store's |

A `guard` passed to `set` is the capability `guard`. A [dimension](/reference/language#dimension) keeps its answers with its store's driver, and asks for both `take` and `guard`: a driver without them may keep agents' stores, never a dimension's. A filter arrives parsed: `{ field, op, value }`, `op` one of `=`, `!=`, `>`, `<`, `>=`, `<=`, `~` ("contains"); values compare as numbers when both sides are numbers, as text otherwise.

What does not depend on the engine is the store API's, and a driver never repeats it: a write reaches the driver already checked against the store's slots, filters already parsed, field names already held to letters, digits and `_`; an operation the driver does not declare is refused before it is called. A driver only translates.

### An example: sqlite

A driver for sqlite, through Node's own `node:sqlite` module — one database file for the project, one table per store, each record a JSON document:

```js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OPS = { '=': '=', '!=': '!=', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

/** The filters as a WHERE clause over the JSON document: field names travel as parameters, never in the SQL. */
function where(filters) {
  if (filters.length === 0) return { sql: '', params: [] };
  const parts = [], params = [];
  for (const { field, op, value } of filters) {
    const num = value.trim() !== '' && !Number.isNaN(Number(value));
    if (op === '~') { parts.push('instr(json_extract(doc, ?), ?) > 0'); params.push(`$.${field}`, value); }
    else { parts.push(`json_extract(doc, ?) ${OPS[op]} ?`); params.push(`$.${field}`, num ? Number(value) : value); }
  }
  return { sql: `WHERE ${parts.join(' AND ')}`, params };
}

export default function sqlite({ file = '.agent-pack/stores.sqlite' } = {}) {
  return {
    type: 'driver',
    name: 'sqlite',
    api: 1,
    capabilities: ['take', 'guard', 'since'],
    location: () => file,
    rejects: slot => (slot.type.kind === 'shape' || slot.type.kind === 'list' ? `slot "${slot.name}": sqlite keeps records flat` : null),

    open(store) {
      mkdirSync(dirname(store.path), { recursive: true });
      const db = new DatabaseSync(store.path);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      const t = `"${store.collection.replace(/[^A-Za-z0-9_]/g, '_')}"`;
      db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY, k TEXT UNIQUE, seq INTEGER NOT NULL, doc TEXT NOT NULL)`);

      const seq = () => db.prepare(`SELECT coalesce(max(seq), 0) + 1 AS s FROM ${t}`).get().s;
      const out = r => (r ? { ...JSON.parse(r.doc), id: String(r.id) } : null);
      const at = key => (store.key ? ['k = ?', String(key)] : ['id = ?', Number(key)]);
      const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

      return {
        put: doc => atomic(() => {
          const k = store.key ? String(doc[store.key]) : null;
          const old = k === null ? undefined : db.prepare(`SELECT id FROM ${t} WHERE k = ?`).get(k);
          if (old) { db.prepare(`UPDATE ${t} SET seq = ?, doc = ? WHERE id = ?`).run(seq(), JSON.stringify(doc), old.id); return { id: String(old.id), updated: true }; }
          const r = db.prepare(`INSERT INTO ${t} (k, seq, doc) VALUES (?, ?, ?)`).run(k, seq(), JSON.stringify(doc));
          return { id: String(r.lastInsertRowid), updated: false };
        }),
        get: key => { const [w, v] = at(key); return out(db.prepare(`SELECT id, doc FROM ${t} WHERE ${w}`).get(v)); },
        find: (filters, limit) => {
          const w = where(filters);
          return db.prepare(`SELECT id, doc FROM ${t} ${w.sql} ORDER BY id${limit ? ` LIMIT ${Number(limit)}` : ''}`).all(...w.params).map(out);
        },
        set: (key, fields, guard = []) => atomic(() => {
          const [w, v] = at(key);
          const r = db.prepare(`SELECT id, doc FROM ${t} WHERE ${w}`).get(v);
          if (!r) return 'missing';
          const g = where(guard);
          if (guard.length && !db.prepare(`SELECT 1 FROM ${t} ${g.sql} AND id = ?`).get(...g.params, r.id)) return 'stale';
          db.prepare(`UPDATE ${t} SET seq = ?, doc = ? WHERE id = ?`).run(seq(), JSON.stringify({ ...JSON.parse(r.doc), ...fields }), r.id);
          return 'set';
        }),
        remove: key => { const [w, v] = at(key); return db.prepare(`DELETE FROM ${t} WHERE ${w}`).run(v).changes > 0; },
        take: (filters, fields) => atomic(() => {
          const w = where(filters);
          const r = db.prepare(`SELECT id, doc FROM ${t} ${w.sql} ORDER BY id LIMIT 1`).get(...w.params);
          if (!r) return null;
          const doc = { ...JSON.parse(r.doc), ...fields };
          db.prepare(`UPDATE ${t} SET seq = ?, doc = ? WHERE id = ?`).run(seq(), JSON.stringify(doc), r.id);
          return { ...doc, id: String(r.id) };
        }),
        mark: () => String(db.prepare(`SELECT coalesce(max(seq), 0) AS s FROM ${t}`).get().s),
        since: mark => (/^\d+$/.test(mark) ? db.prepare(`SELECT id, doc FROM ${t} WHERE seq > ? ORDER BY seq`).all(Number(mark)).map(out) : null),
      };
    },
  };
}
```

## Testing a driver

The contract every driver must keep is a set of cases agent-pack runs on its own drivers. Run it on yours before publishing it:

```bash
agent-pack driver test ./drivers/sqlite.mjs
agent-pack driver test agent-pack-driver-notion --options '{"token": "NOTION_TOKEN", "databases": {…}}'
```

Each case opens a fresh store and checks one operation — the base ones, then those of each capability the driver declares. The command prints one line per case and exits `1` when one fails. `agent-pack driver test files` and `agent-pack driver test tabeli` run it on the shipped drivers.
