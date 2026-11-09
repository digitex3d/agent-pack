// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `dimension` service — a DIMENSION block's answers, kept by the apx per
 * file in the dimension's store: read and write one, search them, hand out
 * the next file to answer, and keep the cache.
 * `<apx> dimension <op> <dim-id> …`; `dimension` alone lists the agent's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DimensionBlock, TemplateBlock } from '../../apdoc/blocks.js';
import { formatIssues, slotSpecsOf, validateRecord } from '../../shapeSchema.js';
import { relativeWithin } from '../../services/fs.js';
import { matchesAnyGlob } from '../../services/glob.js';
import { storeDriverOf } from '../../storeDrivers/registry.js';
import {
  DimensionCache, StaleWrite, dimensionDefHash, dimensionParts, filesNamedIn, CACHE_FORMAT, NONE,
  type CacheEntry, type EntryState,
} from '../dimensions.js';
import { STORE_EXIT, fieldsText, installRecorded } from '../stores.js';
import { mark, next, q, since, writeUsage, type Dimension, type Op } from './dimensionQuery.js';
import { countOf, serviceCommand, type ApxHost, type ApxService } from '../service.js';

/** How many hex digits of a fingerprint a message shows. */
const HASH_SHOWN = 12;

/** The exit code of a write that lost to another agent's, as a store's stale `set`. */
const STALE = STORE_EXIT.stale;

/** The dimensions, each with its store, its files and its cache at the project root. */
async function dimensionsOf(host: ApxHost): Promise<Dimension[]> {
  await installRecorded(host);
  return (host.doc.byKind('dimension') as DimensionBlock[]).flatMap(block => {
    const parts = dimensionParts(host.doc, block);
    const driver = parts.store ? storeDriverOf(parts.store.storeDriver) : null;
    if (!parts.store || !driver) return [];
    const template = parts.store.shape ? host.doc.resolve(parts.store.shape.ref) as TemplateBlock | null : null;
    return [{
      block, name: block.name, store: parts.store, template,
      cmd: (op: string) => serviceCommand(host.cmd, 'dimension', op, block.id),
      cache: new DimensionCache(host.projectRoot, dimensionDefHash(block, parts), driver, parts.store),
    }];
  });
}

/** The file an operation names, from the project root — or null after telling what is wrong. */
function fileArg(host: ApxHost, dim: Dimension, op: string, arg: string | undefined, usage: string): string | null {
  const refuse = (message: string): null => { host.lastCode = host.fail(STORE_EXIT.usage, message); return null; };
  if (!arg) return refuse(`${dim.name} ${op} needs a file — ${dim.cmd(op)} ${usage}`);
  const file = relativeWithin(dim.cache.root, resolve(arg));
  if (!file) return refuse(`\`${arg}\` lies outside the project — name a file under its root, ${dim.cache.root}`);
  if (!matchesAnyGlob(file, dim.block.globs)) return refuse(`\`${file}\` is no file ${dim.name} covers — it covers: ${dim.block.globs.join(', ')}`);
  return file;
}

/**
 * `read <dim-id> <file> [json]` — the answer kept for a file: `hit` and the
 * answer while the file and every file it depends on are as they were; `miss`
 * with the reason otherwise, and never the old answer; `gone` when the file no
 * longer exists. A file moved without an edit takes its old entry along.
 */
const read: Op = async (host, dim, args) => {
  const file = fileArg(host, dim, 'read', args[0], '<file> [json]');
  if (!file) return host.lastCode;
  const { cache } = dim;
  const found = await entryFor(dim, file);
  if (found === null) return host.fail(STORE_EXIT.missing, `no file \`${file}\` in the project — nothing to read`);
  const { entry, state } = found;
  if (!entry || state?.state !== 'fresh') return miss(host, dim, file, state);
  cache.count('hits');
  if (args[1] === 'json') return host.print(JSON.stringify(entry.value));
  host.out(`hit ${dim.name} ${file} — by ${entry.by}, ${entry.at.slice(0, 10)}`);
  return host.print(valueText(dim, entry.value));
};

/** The entry kept for a file and its state — the one of a file moved here without an edit, adopted; null when neither file nor entry is there. */
async function entryFor(dim: Dimension, file: string): Promise<{ entry: CacheEntry | null; state: EntryState | null } | null> {
  const current = dim.cache.fingerprintOf(file);
  let entry = await dim.cache.read(file);
  if (!entry && current === null) return null;
  if (!entry && current !== null) entry = await dim.cache.adopt(file, current);
  return { entry, state: entry ? dim.cache.state(entry) : null };
}

/** A read with no fresh answer: why, and how to keep one. */
function miss(host: ApxHost, dim: Dimension, file: string, state: EntryState | null): number {
  dim.cache.count('misses');
  if (state?.state === 'gone') { host.out(`gone ${dim.name} ${file} — ${state.reason}`); return 1; }
  host.out(`miss ${dim.name} ${file} — ${state ? state.reason : 'never written'}`);
  host.out(`# once you have worked the answer out, keep it: ${dim.cmd('write')} ${writeUsage(file)}`);
  return 1;
}

/** One instance as text: through its template's layout when the store has one, else its fields on a line. */
function instanceText(dim: Dimension, v: Record<string, unknown>): string {
  return dim.template?.slots ? dim.template.instanceText(v) : fieldsText(v);
}

/** A kept value as text: each instance, or `none`. */
function valueText(dim: Dimension, value: CacheEntry['value']): string {
  if (!Array.isArray(value)) return NONE;
  const texts = value.map(v => instanceText(dim, v));
  return texts.join(texts.some(t => t.includes('\n')) ? '\n\n' : '\n');
}

/**
 * A value for a dimension, from its text: `none`, or a JSON list of at least
 * one record with the fields of its store — each checked the way a store write is.
 */
function valueOf(dim: Dimension, text: string): { value: CacheEntry['value'] } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === NONE || trimmed === JSON.stringify(NONE)) return { value: NONE };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { error: 'the value is no JSON — write a JSON list of records, or none' }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { error: `the value is no list of records of \`${dim.store.name}\` — a list of one record at least, or none` };
  const specs = slotSpecsOf(dim.store.slots);
  for (const [n, item] of parsed.entries()) {
    const issues = validateRecord(item, specs);
    if (issues.length > 0) return { error: `record ${n + 1} is no record of \`${dim.store.name}\`: ${formatIssues(issues).replace(/\n/g, '; ')}` };
  }
  return { value: parsed as Record<string, unknown>[] };
}

/** The refs of a write, each file's fingerprint now — or the message of one that is no file of the project. */
function refsOf(dim: Dimension, file: string, arg: string | undefined): Record<string, string> | string {
  const refs: Record<string, string> = {};
  for (const raw of (arg?.slice('refs='.length) ?? '').split(';').map(r => r.trim()).filter(Boolean)) {
    const ref = relativeWithin(dim.cache.root, resolve(raw));
    const print = ref === null ? null : dim.cache.fingerprintOf(ref);
    if (ref === null || print === null) return `refs: \`${raw}\` is no file of the project — name files that exist, separated by ; — nothing was written`;
    if (ref !== file) refs[ref] = print;
  }
  return refs;
}

/**
 * `write <dim-id> <file> [refs=<path>;…] -|none` — keep an answer for a file:
 * a file the dimension covers and that exists, refs that exist, a value its
 * store accepts. An answer still fresh is never overwritten — another agent
 * gave it meanwhile (exit 4). Refused: nothing is written.
 */
/** The arguments of a write: its file, its refs option, where its value comes from — or the exit code of what is wrong with them. */
function writeArgs(host: ApxHost, dim: Dimension, args: string[]): { file: string; refsArg: string | undefined; from: string } | number {
  const usage = writeUsage();
  const file = fileArg(host, dim, 'write', args[0], usage);
  if (!file) return host.lastCode;
  const refsArg = args.slice(1).filter(a => a.startsWith('refs='));
  const from = args.slice(1).filter(a => !a.startsWith('refs='));
  if (refsArg.length > 1 || from.length !== 1 || (from[0] !== '-' && from[0] !== NONE)) {
    return host.fail(STORE_EXIT.usage, `${dim.name} write takes the value on stdin with -, or none — ${dim.cmd('write')} ${usage}`);
  }
  return { file, refsArg: refsArg[0], from: from[0] };
}

const write: Op = async (host, dim, args) => {
  const parsed = writeArgs(host, dim, args);
  if (typeof parsed === 'number') return parsed;
  const { file, refsArg, from } = parsed;
  const { cache } = dim;
  const hash = cache.fingerprintOf(file);
  if (hash === null) return host.fail(STORE_EXIT.missing, `no file \`${file}\` in the project — an answer is for a file that exists; nothing was written`);
  const refs = refsOf(dim, file, refsArg);
  if (typeof refs === 'string') return host.fail(STORE_EXIT.missing, refs);
  const existing = await cache.read(file);
  if (existing && cache.state(existing).state === 'fresh') {
    return host.fail(STALE, `${dim.name} ${file} is already fresh — read it: ${dim.cmd('read')} ${file}; nothing was written`);
  }
  const value = from === NONE ? { value: NONE } as const : valueOf(dim, readFileSync(0, 'utf-8'));
  if ('error' in value) return host.fail(STORE_EXIT.usage, `${value.error} — nothing was written`);
  return await keep(host, dim, { format: CACHE_FORMAT, dimension: dim.name, file, hash, refs, value: value.value, by: host.root.name, at: new Date().toISOString() });
};

/** Keep a checked answer — the files it names among its refs — unless another agent answered the file meanwhile. */
async function keep(host: ApxHost, dim: Dimension, entry: CacheEntry): Promise<number> {
  const { cache } = dim;
  // The files the answer names are files it depends on.
  for (const named of filesNamedIn(cache.root, entry.value)) if (named !== entry.file && !(named in entry.refs)) entry.refs[named] = cache.fingerprintOf(named) ?? '';
  try {
    await cache.write(entry);
  } catch (e) {
    if (e instanceof StaleWrite) return host.fail(STALE, `${dim.name} ${entry.file}: another agent answered it meanwhile — read it: ${dim.cmd('read')} ${entry.file}`);
    throw e;
  }
  host.out(`# stored ${dim.name} ${entry.file} — ${cache.location}`);
  host.out(`# hash ${entry.hash.slice(0, HASH_SHOWN)}  refs: ${Object.keys(entry.refs).join(', ') || '(none)'}`);
  return 0;
}

/** Each entry kept (those matching `glob`) with its state — and the counts. */
async function entriesOf(dim: Dimension, glob?: string): Promise<{ entries: { entry: CacheEntry; state: EntryState }[]; summary: string }> {
  const entries = (await dim.cache.entries(glob)).map(entry => ({ entry, state: dim.cache.state(entry) }));
  const n = (state: string) => entries.filter(e => e.state.state === state).length;
  const { hits, misses } = dim.cache.stats();
  const rate = hits + misses > 0 ? `${Math.round((100 * hits) / (hits + misses))}%` : 'n/a';
  return {
    entries,
    summary: `${countOf(entries.length, 'entry', 'entries')}: ${n('fresh')} fresh, ${n('stale')} stale, ${n('gone')} gone — ${hits} hits, ${misses} misses, hit rate ${rate}`,
  };
}

/**
 * `find <dim-id> <text>` — every instance kept for any file whose text holds
 * `text` (case aside), each with its file. Only fresh entries answer.
 */
const find: Op = async (host, dim, args) => {
  if (args.length === 0) return host.fail(STORE_EXIT.usage, `${dim.name} find needs text — ${dim.cmd('find')} <text>`);
  const needle = args.join(' ').toLowerCase();
  let n = 0;
  for (const { entry, state } of (await entriesOf(dim)).entries) {
    if (state.state !== 'fresh' || !Array.isArray(entry.value)) continue;
    for (const v of entry.value) {
      const text = instanceText(dim, v);
      if (!text.toLowerCase().includes(needle)) continue;
      n++;
      host.out(`${entry.file}  ${text.replace(/\n/g, ' ')}`);
    }
  }
  host.out(`# ${countOf(n, 'instance', 'instances')} of ${dim.name} hold "${args.join(' ')}" — fresh entries only`);
  return n > 0 ? 0 : 1;
};

/** `ls <dim-id> [glob]` — the entries kept, with their state and why, then the counts. */
const ls: Op = async (host, dim, args) => {
  const { entries, summary } = await entriesOf(dim, args[0]);
  for (const { entry, state } of entries) {
    host.out(`${state.state.padEnd(5)}  ${entry.file}${state.reason ? `  — ${state.reason}` : ''}  (by ${entry.by}, ${entry.at.slice(0, 10)})`);
  }
  host.out(`# ${dim.name}  ${dim.cache.location}  ${summary}`);
  return 0;
};

/** `why <dim-id> <file>` — the state of a file's entry, file by file: the fingerprint kept and the current one. */
const why: Op = async (host, dim, args) => {
  const file = fileArg(host, dim, 'why', args[0], '<file>');
  if (!file) return host.lastCode;
  const entry = await dim.cache.read(file);
  if (!entry) {
    host.out(`never written ${dim.name} ${file} — no entry in ${dim.cache.location}`);
    return 0;
  }
  const state = dim.cache.state(entry);
  host.out(`${state.state} ${dim.name} ${file}${state.reason ? ` — ${state.reason}` : ''}  (by ${entry.by}, ${entry.at})`);
  for (const c of state.checks) {
    const now = c.current === null ? 'gone' : c.current === c.stored ? 'same' : 'changed';
    host.out(`  ${c.role.padEnd(4)}  ${c.path}  kept ${c.stored.slice(0, HASH_SHOWN)}  now ${c.current ? c.current.slice(0, HASH_SHOWN) : '(none)'}  ${now}`);
  }
  return 0;
};

/** `clear <dim-id> [glob] [--by <agent>]` — delete entries: all, those matching a glob, those an agent wrote. */
const clear: Op = async (host, dim, args) => {
  let glob: string | undefined;
  let by: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--by' && args[i + 1]) by = args[++i];
    else if (args[i] !== '--by' && glob === undefined) glob = args[i];
    else return host.fail(STORE_EXIT.usage, `${dim.name} clear takes a glob and --by <agent>, both optional — ${dim.cmd('clear')} 'src/**' --by <agent>`);
  }
  const cleared = (await dim.cache.entries(glob)).filter(e => !by || e.by === by);
  for (const e of cleared) await dim.cache.remove(e.file);
  host.out(`# cleared ${countOf(cleared.length, 'entry', 'entries')} of ${dim.name}${glob ? ` matching ${glob}` : ''}${by ? ` written by ${by}` : ''}`);
  return 0;
};

/** `gc <dim-id>` — delete the entries of files that no longer exist. */
const gc: Op = async (host, dim) => {
  const orphans = await dim.cache.orphans();
  for (const e of orphans) {
    await dim.cache.remove(e.file);
    host.out(`removed ${e.file}`);
  }
  host.out(`# ${countOf(orphans.length, 'entry', 'entries')} of deleted files removed from ${dim.name}`);
  return 0;
};

const OPS: Record<string, Op> = { read, write, find, q, next, mark, since, ls, why, clear, gc };

/** `dimension` alone, or `ls` with no id: the agent's dimensions, each with what it covers and its counts. */
async function list(host: ApxHost, dimensions: Dimension[]): Promise<number> {
  if (dimensions.length === 0) host.out('# this agent has no dimensions');
  for (const d of dimensions) {
    host.out(`${d.block.id}  ${d.name}  ${d.cache.defhash}  — files: ${d.block.globs.join(', ')} — ${(await entriesOf(d)).summary}  — read: ${d.cmd('read')} <file>`);
  }
  return 0;
}

export const dimensionService: ApxService = {
  kind: 'dimension',
  about: "a dimension's answers about the code, kept by the apx per file in its store — and its cache",
  operations: [
    { op: 'read', args: '<dim-id> <file> [json]', about: 'the answer kept for a file: hit (the answer), or miss (why there is none)' },
    { op: 'write', args: `<dim-id> ${writeUsage()}`, about: 'keep your answer for a file — a JSON list of records of its store on stdin, or none' },
    { op: 'find', args: '<dim-id> <text>', about: 'every instance kept, across its files, whose text holds <text> — fresh entries only' },
    { op: 'q', args: '<dim-id> [<field><op><value> …] [json]', about: 'the instances every filter holds for, each with its file — fresh answers only' },
    { op: 'next', args: '<dim-id>', about: 'the next file it covers with no fresh answer, taken for you — no other agent gets it meanwhile' },
    { op: 'mark', args: '<dim-id>', about: 'a mark of now, for since' },
    { op: 'since', args: '<dim-id> <mark>', about: 'the files answered after a mark' },
    { op: 'ls', args: '[<dim-id> [glob]]', about: "the dimensions of this agent — or one's entries and their state, then the counts" },
    { op: 'why', args: '<dim-id> <file>', about: 'the state of one entry, file by file: the fingerprint kept and the current one' },
    { op: 'clear', args: '<dim-id> [glob] [--by <agent>]', about: 'delete entries: all, those matching a glob, those an agent wrote' },
    { op: 'gc', args: '<dim-id>', about: 'delete the entries of files that no longer exist' },
  ],
  async serve(host, op, args) {
    const dimensions = await dimensionsOf(host);
    const [id, ...rest] = args;
    if (!op || (op === 'ls' && !id)) return await list(host, dimensions);
    const dim = id ? dimensions.find(d => d.block.id === id) : undefined;
    if (!dim) {
      const known = dimensions.map(d => `${d.block.id} (${d.name})`).join(', ') || 'none';
      return host.fail(STORE_EXIT.usage, `${id ? `no dimension \`${id}\` in this agent` : `dimension ${op} takes an id (dim-…)`} — its dimensions: ${known}; list them: ${host.cmd} dimension`);
    }
    const run = OPS[op];
    if (!run) return host.fail(STORE_EXIT.usage, `'${op}' is no operation of a dimension — ${host.cmd} dimension ${Object.keys(OPS).join('|')} <dim-id> …`);
    return await run(host, dim, rest);
  },
};
