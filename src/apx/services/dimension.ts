// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `dimension` service — a DIMENSION block's answers, kept by the apx per
 * file: read and write one, find across files, and keep the cache.
 * `<apx> dimension <op> <dim-id> …`; `dimension` alone lists the agent's.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DimensionBlock, TemplateBlock } from '../../apdoc/blocks.js';
import { refName } from '../../../adapters/md/phrases.js';
import { relativeWithin } from '../../services/fs.js';
import { matchesAnyGlob } from '../../services/glob.js';
import { DimensionCache, dimensionDefHash, dimensionTemplates, filesNamedIn, CACHE_FORMAT, NONE, type CacheEntry, type EntryState } from '../dimensions.js';
import { countOf, serviceCommand, type ApxHost, type ApxService } from '../service.js';

/** A dimension of this agent: its block, its AS template, its cache. */
interface Dimension {
  block: DimensionBlock;
  name: string;
  /** The command of one operation on it: `<apx> dimension <op> <dim-id>`. */
  cmd: (op: string) => string;
  template: TemplateBlock | null;
  cache: DimensionCache;
}

/** The refs option of `write`, as every usage prints it. */
const WRITE_REFS = '[refs=<path>;<path>]';
const writeUsage = (file = '<file>') => `${file} ${WRITE_REFS} -|none`;

export const dimensionService: ApxService = {
  kind: 'dimension',
  about: "a dimension's answers about the code, kept by the apx per file — and its cache",
  operations: [
    { op: 'read', args: '<dim-id> <file> [json]', about: 'the answer kept for a file: hit (the answer), or miss (why there is none)' },
    { op: 'write', args: `<dim-id> ${writeUsage()}`, about: 'keep your answer for a file — a JSON list of its template on stdin, or none' },
    { op: 'find', args: '<dim-id> <text>', about: 'every instance kept, across its files, whose text holds <text> — fresh entries only' },
    { op: 'ls', args: '[<dim-id> [glob]]', about: "the dimensions of this agent — or one's entries and their state, then the counts" },
    { op: 'why', args: '<dim-id> <file>', about: "the state of one entry, file by file: the fingerprint kept and the current one" },
    { op: 'clear', args: '<dim-id> [glob] [--by <agent>]', about: 'delete entries: all, those matching a glob, those an agent wrote' },
    { op: 'gc', args: '<dim-id>', about: 'delete the entries of files that no longer exist' },
  ],
  serve(host, op, args) {
    const dimensions = dimensionsOf(host);
    const [id, ...rest] = args;
    if (!op || (op === 'ls' && !id)) {
      if (dimensions.length === 0) host.out('# this agent has no dimensions');
      for (const d of dimensions) host.out(`${d.block.id}  ${d.name}  ${d.cache.defhash}  — files: ${d.block.globs.join(', ')} — ${entriesOf(d).summary}  — read: ${d.cmd('read')} <file>`);
      return 0;
    }
    const dim = id ? dimensions.find(d => d.block.id === id) : undefined;
    if (!dim) {
      const known = dimensions.map(d => `${d.block.id} (${d.name})`).join(', ') || 'none';
      return host.fail(2, `${id ? `no dimension \`${id}\` in this agent` : `dimension ${op} takes an id (dim-…)`} — its dimensions: ${known}; list them: ${host.cmd} dimension`);
    }
    switch (op) {
      case 'read': return read(host, dim, rest);
      case 'write': return write(host, dim, rest);
      case 'ls': return ls(host, dim, rest);
      case 'find': return find(host, dim, rest);
      case 'why': return why(host, dim, rest);
      case 'clear': return clear(host, dim, rest);
      case 'gc': return gc(host, dim);
    }
    return host.fail(2, `'${op}' is no operation of a dimension — ${host.cmd} dimension read|write|find|ls|why|clear|gc <dim-id> …`);
  },
};

/** The dimensions, each with its AS template and its cache at the project root. */
function dimensionsOf(host: ApxHost): Dimension[] {
  return (host.doc.byKind('dimension') as DimensionBlock[]).map(block => {
    const templates = dimensionTemplates(host.doc, block);
    return {
      block, name: block.name,
      cmd: op => serviceCommand(host.cmd, 'dimension', op, block.id),
      template: templates.as as TemplateBlock | null,
      cache: new DimensionCache(host.projectRoot, dimensionDefHash(block, templates)),
    };
  });
}

/** The file an operation names, from the project root — or null after telling what is wrong. */
function fileArg(host: ApxHost, dim: Dimension, op: string, arg: string | undefined, usage: string): string | null {
  const refuse = (message: string): null => { host.lastCode = host.fail(2, message); return null; };
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
function read(host: ApxHost, dim: Dimension, args: string[]): number {
  const file = fileArg(host, dim, 'read', args[0], '<file> [json]');
  if (!file) return host.lastCode;
  const { cache } = dim;
  const current = cache.fingerprintOf(file);
  let entry = cache.read(file);
  if (!entry && current === null) return host.fail(1, `no file \`${file}\` in the project — nothing to read`);
  entry ??= cache.adopt(file, current!);
  const state = entry ? cache.state(entry) : null;
  if (!entry || state!.state !== 'fresh') {
    cache.count('misses');
    if (state?.state === 'gone') { host.out(`gone ${dim.name} ${file} — ${state.reason}`); return 1; }
    host.out(`miss ${dim.name} ${file} — ${state ? state.reason : 'never written'}`);
    host.out(`# once you have worked the answer out, keep it: ${dim.cmd('write')} ${writeUsage(file)}`);
    return 1;
  }
  cache.count('hits');
  if (args[1] === 'json') return host.print(JSON.stringify(entry.value));
  host.out(`hit ${dim.name} ${file} — by ${entry.by}, ${entry.at.slice(0, 10)}`);
  return host.print(valueText(dim, entry.value));
}

/** A kept value as text: each instance through its template's layout, or `none`. */
function valueText(dim: Dimension, value: CacheEntry['value']): string {
  if (!Array.isArray(value)) return NONE;
  const template = dim.template;
  if (!template?.slots) return JSON.stringify(value, null, 1);
  const texts = value.map(v => template.instanceText(v as Record<string, unknown>));
  return texts.join(texts.some(t => t.includes('\n')) ? '\n\n' : '\n');
}

/**
 * A value for a dimension, from its text: `none`, or a JSON list of at least
 * one instance of its template — checked the way a typed variable is.
 */
function valueOf(host: ApxHost, dim: Dimension, text: string): { value: CacheEntry['value'] } | { error: string } {
  const shape = dim.block.shape?.ref;
  const name = shape ? refName(shape) : '?';
  const trimmed = text.trim();
  if (trimmed === NONE || trimmed === JSON.stringify(NONE)) return { value: NONE };
  if (!shape || !host.doc.slotsOf(shape)) return { error: `\`${dim.name}\` is shaped as \`${name}\`, a template not compiled into this agent` };
  const issues = host.contractIssues(trimmed, shape, { name: dim.name, min: 1 });
  if (issues) return { error: `the value is not a list of \`${name}\`: ${issues}` };
  return { value: JSON.parse(trimmed) as unknown[] };
}

/**
 * `write <dim-id> <file> [refs=<path>;…] -|none` — keep an answer for a file:
 * a file the dimension covers and that exists, refs that exist, a value its
 * template accepts. An answer still fresh is never overwritten — another agent
 * gave it meanwhile (exit 4). Refused: nothing is written.
 */
function write(host: ApxHost, dim: Dimension, args: string[]): number {
  const usage = writeUsage();
  const file = fileArg(host, dim, 'write', args[0], usage);
  if (!file) return host.lastCode;
  const options = args.slice(1);
  const refsArg = options.filter(a => a.startsWith('refs='));
  const from = options.filter(a => !a.startsWith('refs='));
  if (refsArg.length > 1 || from.length !== 1 || (from[0] !== '-' && from[0] !== NONE)) {
    return host.fail(2, `${dim.name} write takes the value on stdin with -, or none — ${dim.cmd('write')} ${usage}`);
  }
  const { cache } = dim;
  const hash = cache.fingerprintOf(file);
  if (hash === null) return host.fail(1, `no file \`${file}\` in the project — an answer is for a file that exists; nothing was written`);
  const refs: Record<string, string> = {};
  for (const raw of (refsArg[0]?.slice('refs='.length) ?? '').split(';').map(r => r.trim()).filter(Boolean)) {
    const ref = relativeWithin(cache.root, resolve(raw));
    const print = ref === null ? null : cache.fingerprintOf(ref);
    if (ref === null || print === null) return host.fail(1, `refs: \`${raw}\` is no file of the project — name files that exist, separated by ; — nothing was written`);
    if (ref !== file) refs[ref] = print;
  }
  const existing = cache.read(file);
  if (existing && cache.state(existing).state === 'fresh') {
    return host.fail(4, `${dim.name} ${file} is already fresh — read it: ${dim.cmd('read')} ${file}; nothing was written`);
  }
  const read = from[0] === NONE ? { value: NONE } as const : valueOf(host, dim, readFileSync(0, 'utf-8'));
  if ('error' in read) return host.fail(2, `${read.error} — nothing was written`);
  // The files the answer names are files it depends on.
  for (const named of filesNamedIn(cache.root, read.value)) if (named !== file && !(named in refs)) refs[named] = cache.fingerprintOf(named)!;
  cache.write({ format: CACHE_FORMAT, dimension: dim.name, file, hash, refs, value: read.value, by: host.root.name, at: new Date().toISOString() });
  host.out(`# stored ${dim.name} ${file} — ${cache.entryLocation(file)}`);
  host.out(`# hash ${hash.slice(0, 12)}  refs: ${Object.keys(refs).join(', ') || '(none)'}`);
  return 0;
}

/** Each entry kept (those matching `glob`) with its state — and the counts. */
function entriesOf(dim: Dimension, glob?: string): { entries: { entry: CacheEntry; state: EntryState }[]; summary: string } {
  const entries = dim.cache.entries(glob).map(entry => ({ entry, state: dim.cache.state(entry) }));
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
function find(host: ApxHost, dim: Dimension, args: string[]): number {
  if (args.length === 0) return host.fail(2, `${dim.name} find needs text — ${dim.cmd('find')} <text>`);
  const needle = args.join(' ').toLowerCase();
  const template = dim.template?.slots ? dim.template : null;
  let n = 0;
  for (const { entry, state } of entriesOf(dim).entries) {
    if (state.state !== 'fresh' || !Array.isArray(entry.value)) continue;
    for (const v of entry.value) {
      const text = template ? template.instanceText(v as Record<string, unknown>) : JSON.stringify(v);
      if (!text.toLowerCase().includes(needle)) continue;
      n++;
      host.out(`${entry.file}  ${text.replace(/\n/g, ' ')}`);
    }
  }
  host.out(`# ${countOf(n, 'instance', 'instances')} of ${dim.name} hold "${args.join(' ')}" — fresh entries only`);
  return n > 0 ? 0 : 1;
}

/** `ls <dim-id> [glob]` — the entries kept, with their state and why, then the counts. */
function ls(host: ApxHost, dim: Dimension, args: string[]): number {
  const { entries, summary } = entriesOf(dim, args[0]);
  for (const { entry, state } of entries) {
    host.out(`${state.state.padEnd(5)}  ${entry.file}${state.reason ? `  — ${state.reason}` : ''}  (by ${entry.by}, ${entry.at.slice(0, 10)})`);
  }
  host.out(`# ${dim.name}  ${dim.cache.location}/  ${summary}`);
  return 0;
}

/** `why <dim-id> <file>` — the state of a file's entry, file by file: the fingerprint kept and the current one. */
function why(host: ApxHost, dim: Dimension, args: string[]): number {
  const file = fileArg(host, dim, 'why', args[0], '<file>');
  if (!file) return host.lastCode;
  const entry = dim.cache.read(file);
  if (!entry) {
    host.out(`never written ${dim.name} ${file} — no entry at ${dim.cache.entryLocation(file)}`);
    return 0;
  }
  const state = dim.cache.state(entry);
  host.out(`${state.state} ${dim.name} ${file}${state.reason ? ` — ${state.reason}` : ''}  (by ${entry.by}, ${entry.at})`);
  for (const c of state.checks) {
    const now = c.current === null ? 'gone' : c.current === c.stored ? 'same' : 'changed';
    host.out(`  ${c.role.padEnd(4)}  ${c.path}  kept ${c.stored.slice(0, 12)}  now ${c.current ? c.current.slice(0, 12) : '(none)'}  ${now}`);
  }
  return 0;
}

/** `clear <dim-id> [glob] [--by <agent>]` — delete entries: all, those matching a glob, those an agent wrote. */
function clear(host: ApxHost, dim: Dimension, args: string[]): number {
  let glob: string | undefined;
  let by: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--by' && args[i + 1]) by = args[++i];
    else if (args[i] !== '--by' && glob === undefined) glob = args[i];
    else return host.fail(2, `${dim.name} clear takes a glob and --by <agent>, both optional — ${dim.cmd('clear')} 'src/**' --by <agent>`);
  }
  const cleared = dim.cache.entries(glob).filter(e => !by || e.by === by);
  for (const e of cleared) dim.cache.remove(e.file);
  host.out(`# cleared ${countOf(cleared.length, 'entry', 'entries')} of ${dim.name}${glob ? ` matching ${glob}` : ''}${by ? ` written by ${by}` : ''}`);
  return 0;
}

/** `gc <dim-id>` — delete the entries of files that no longer exist. */
function gc(host: ApxHost, dim: Dimension): number {
  const orphans = dim.cache.orphans();
  for (const e of orphans) {
    dim.cache.remove(e.file);
    host.out(`removed ${e.file}`);
  }
  host.out(`# ${countOf(orphans.length, 'entry', 'entries')} of deleted files removed from ${dim.name}`);
  return 0;
}
