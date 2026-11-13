// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `dimension` service's search and fill operations — `q` (the answers by
 * their fields), `next` (the next file to answer, taken), `mark` and `since`
 * (the files answered after a mark) — and what they share with the rest of
 * the service (src/apx/services/dimension.ts).
 */
import type { DimensionBlock, StoreBlock, TemplateBlock } from '../../apdoc/blocks.js';
import { projectFiles } from '../../services/fs.js';
import { filtersOn } from '../../storeDrivers/filters.js';
import type { DimensionCache } from '../dimensions.js';
import { matchesAnyGlob } from '../../services/glob.js';
import { STORE_EXIT, fieldsText } from '../stores.js';
import { countOf, type ApxHost } from '../service.js';

/** A dimension of this agent: its block, its store, the files it covers, its cache. */
export interface Dimension {
  block: DimensionBlock;
  name: string;
  /** The command of one operation on it: `<apx> dimension <op> <dim-id>`. */
  cmd: (op: string) => string;
  store: StoreBlock;
  /** The template the store takes its fields from, when it has one: an instance prints through its layout. */
  template: TemplateBlock | null;
  cache: DimensionCache;
}

/** The refs option of `write`, as every usage prints it. */
const WRITE_REFS = '[refs=<path>;<path>]';
export const writeUsage = (file = '<file>') => `${file} ${WRITE_REFS} -|none`;

export type Op = (host: ApxHost, dim: Dimension, args: string[]) => number | Promise<number>;


/** `q <dim-id> [<field><op><value> …] [json]` — the instances every filter holds for, each with its file; fresh answers only. */
export const q: Op = async (host, dim, args) => {
  const json = args.includes('json');
  const filters = filtersOn(args.filter(arg => arg !== 'json'), dim.store.slots.map(slot => slot.name), '_file');
  if (typeof filters === 'string') return host.fail(STORE_EXIT.usage, `${dim.name}: ${filters}`);
  const { rows, stale } = await dim.cache.query(filters);
  if (json) host.out(JSON.stringify(rows));
  else for (const row of rows) host.out(`${row.file}  ${fieldsText(row.fields)}`);
  host.out(`# ${countOf(rows.length, 'instance', 'instances')} of ${dim.name} — fresh answers only`);
  if (stale.length > 0) host.out(`# ${countOf(stale.length, 'file', 'files')} left out, no fresh answer: ${stale.join(', ')} — ${dim.cmd('next')} to answer them`);
  return 0;
};

/** `next <dim-id>` — the next file it covers with no fresh answer, taken for this agent: no other agent gets it meanwhile. */
export const next: Op = async (host, dim) => {
  const files = projectFiles(dim.cache.root, file => matchesAnyGlob(file, dim.block.globs));
  const claimed = await dim.cache.claimNext(files, host.root.name);
  if (!claimed) {
    host.out(`# every file of ${dim.name} has a fresh answer, or another agent is on it`);
    return 1;
  }
  host.out(`${claimed.file} — ${claimed.reason}: describe each ${dim.block.each || 'instance'}, then write`);
  host.out(`# ${dim.cmd('write')} ${writeUsage(claimed.file)}`);
  return 0;
};

/** `mark <dim-id>` — a mark of now; `since <dim-id> <mark>` — the files answered after it. */
export const mark: Op = async (host, dim) => {
  const stamp = await dim.cache.mark();
  host.out(`# mark=${stamp}`);
  host.out(`# later: ${dim.cmd('since')} ${stamp}   -> only the files answered since now`);
  return 0;
};

export const since: Op = async (host, dim, args) => {
  if (!args[0]) return host.fail(STORE_EXIT.usage, `since takes a mark: ${dim.cmd('since')} <mark> (from ${dim.cmd('mark')})`);
  const files = await dim.cache.changedSince(args[0]);
  if (!files) return host.fail(STORE_EXIT.usage, `\`${args[0]}\` is no mark of ${dim.name} — take one with ${dim.cmd('mark')}`);
  for (const file of files) host.out(file);
  host.out(`# ${countOf(files.length, 'file', 'files')} of ${dim.name} answered since the mark`);
  return 0;
};

