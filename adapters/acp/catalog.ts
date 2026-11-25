// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The project's blocks as the chat's launcher offers them, read from the apx
 * files themselves — each unit's `ls --json` (the main's, each team's), or
 * every apx when the project has no unit — read again when a file changed.
 * Each entry knows how to be reached: `node <apx> [<holder>] <verb> <id>`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APX_DIR } from '../../src/apx/paths.js';
import type { Listing, ListingEntry } from '../../src/apx/listing.js';
import { JSON_FLAG } from '../../src/apx/verbs.js';

/** A listed block, with the apx it was read from (from the project root) and the unit that holds it. */
export interface CatalogEntry extends ListingEntry {
  apx: string;
  unit: string | null;
}

const APX_EXT = '.apx';

export class Catalog {
  private stamp = '';
  private listed: CatalogEntry[] = [];

  constructor(private readonly root: string) {}

  /** The entries, read again when an apx file changed since the last read. */
  entries(): CatalogEntry[] {
    const files = this.files();
    const stamp = files.map(f => `${f}:${statSync(join(this.root, f)).mtimeMs}`).join('|');
    if (stamp !== this.stamp) { this.listed = this.read(files); this.stamp = stamp; }
    return this.listed;
  }

  /** The command that runs `verb` on an entry, as a shell runs it from the project root. */
  command(entry: CatalogEntry, verb: string): string {
    return ['node', entry.apx, ...(entry.holder ? [entry.holder] : []), verb, entry.id].join(' ');
  }

  /** What `get` prints of an entry: its text. */
  text(entry: CatalogEntry): string {
    const args = [entry.apx, ...(entry.holder ? [entry.holder] : []), 'get', entry.id];
    return execFileSync(process.execPath, args, { cwd: this.root, encoding: 'utf-8' });
  }

  private files(): string[] {
    const dir = join(this.root, APX_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith(APX_EXT)).sort().map(f => `${APX_DIR}/${f}`);
  }

  /** The units' listings — every apx's when there is no unit — each block once. */
  private read(files: string[]): CatalogEntry[] {
    const listings = files.flatMap(apx => {
      // An apx that cannot list itself (an old build) is left out: the rest is still offered.
      try { return [{ apx, listing: JSON.parse(execFileSync(process.execPath, [apx, 'ls', JSON_FLAG], { cwd: this.root, encoding: 'utf-8' })) as Listing }]; } catch { return []; }
    });
    const units = listings.filter(l => l.listing.unit !== null);
    const seen = new Set<string>();
    return (units.length ? units : listings).flatMap(({ apx, listing }) => listing.entries.flatMap(entry => {
      if (seen.has(entry.id)) return [];
      seen.add(entry.id);
      return [{ ...entry, apx, unit: listing.unit?.name ?? null }];
    }));
  }
}
