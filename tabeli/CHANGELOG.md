# Changelog

## v2 (unreleased)

Lossless values and JSON output. Data format 2 (header version 2).

- Values are stored losslessly: `\` is escaped as `\\`, a real newline as
  `\n`, a CR as `\r` (v1 escaped only newlines and dropped CRs, so a literal
  `\n` in a value and a real newline were stored identically).
- New `json` extra: `g <id> json` prints the record as one JSON object;
  `q <filters> json` prints a JSON array (same `limit`/`ts` rules as text
  output, truncation notice on stderr), `q ... count json` prints
  `{"count":N}`. Values come back decoded (the exact original bytes), `id` is
  a number, every other field a string. `cursor`/`diff` stay text-only.
- Filters and `if` conditions compare against the decoded value, so
  `v=$'a\nb'` matches a real newline and `v='a\nb'` a literal backslash-n.
- The human `key='value'` view is unchanged for ordinary values; values with
  `\`, newlines or CRs show the escaped form (`'C:\\path'`).
- `by=` is canonicalized like any value; `json` is now a reserved word.
- Compatibility: a v2 engine reads v1 data (a v1 `\n` stays a newline, any
  other backslash stays literal, unknown escapes never fail) and writes it back
  as v2 on the next write. A v1 engine refuses v2 data (format check).
- New `upgrade` command: `<v2 seed or table> upgrade ./old.tbl` moves an
  existing v1 table onto this engine in place — records, ids (deleted ones
  stay unreusable), timestamps, `no-ts`, file mode and cursors carry over.
  Atomic (temp + rename under the table's lock), idempotent (already v2: a
  no-op, exit 0), refuses non-tables untouched. A v1 file cannot upgrade
  itself: its engine predates the command.
- Table writes now keep the table's file mode instead of forcing 0755.
- 136-assertion test suite, including byte-identical JSON round-trips,
  crafted v1 tables and upgrades of genuine v1 tables.

## v1 (unreleased)

First working engine.

- Self-contained table file: ELF engine + 64-byte header + plain-text records,
  header located via the engine's own ELF size at runtime.
- Verbs: `a` `q` `g` `s` `d` `i`, plus `init [no-ts]`.
- Filters `=` `!=` `>` `<` `>=` `<=` `~`, `limit=N` (default cap 100),
  `count`, `ts`.
- Engine-owned ISO-8601 UTC timestamps (`created_at`/`updated_at`,
  `created_by`/`updated_by` via `by=`); per-table opt-out with `no-ts`.
- Multi-agent primitives: `next <filters> set <fields>` (atomic take),
  `s <id> ... if <cond>` (compare-and-swap), `cursor` / `diff <cursor>`
  (delta sync: new / modified / deleted).
- Rigorous write locking (`flock` on sibling lockfile, bounded retry),
  atomic temp+`rename` writes, crc32 integrity, 64 MB cap, shell-safe
  single-quote output encoding, teaching errors throughout.
- 64-assertion test suite (`make test`), including 10-writer concurrency and
  corruption detection.
