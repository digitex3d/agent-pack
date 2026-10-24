// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The instances of a team's contracts (D44) — what the apx keeps of the work a
 * lead hands out under `STRATEGY contracts`: one table per session, shared by
 * every agent of it (beside the session's variables), each instance a record
 * whose state the code moves, never the text — a transition is a tabeli
 * compare-and-swap, so two agents never move the same instance twice.
 *
 * The zones: a pair of comments in a file, `agent-pack <ctr-id>` opening and
 * `agent-pack end <ctr-id>` closing, found by their text in any comment syntax.
 * The skeleton: every file of the perimeter with its fingerprint when the lead
 * dispatched — what tells, at delivery, that a member wrote outside its zone. A
 * delivered instance moves the reference of its own file to what it delivered
 * (kept on its record, set by the same compare-and-swap), so the next delivery
 * does not count a finished zone as a change; and the file of a zone another
 * member is still working on is that member's, not counted either — whoever
 * writes in it, the apx cannot tell.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from './paths.js';
import { openTable, queryTable, runTable, tabeliVersionError } from './tabeli.js';
import { fingerprint } from './dimensions.js';
import { projectFiles, writeFileAtomic } from '../services/fs.js';
import { matchesAnyGlob } from '../services/glob.js';

/** The states an instance passes through: assigned the moment it is written, delivered by its assignee, merged by the lead — or blocked by its assignee. */
export const CONTRACT_STATES = ['assigned', 'delivered', 'merged', 'blocked'] as const;
export type ContractState = typeof CONTRACT_STATES[number];

/** One instance, as the table holds it. Every field is text: tabeli is flat. */
export interface ContractRecord {
  /** `ctr-<8 hex>`. */
  ctr: string;
  /** The CONTRACT block's id (`con-…`). */
  contract: string;
  /** The spec, JSON — an instance of the block's AS template. */
  spec: string;
  /** The agent that carries it out. */
  assignee: string;
  /** The instances merged before this one — ids, comma separated; '' when none. */
  depends: string;
  /** The instance the lead started from; '' for the one it was handed. */
  parent: string;
  /** Where the zone is: `file:open-close;file:open-close`; '' until dispatched. */
  zone: string;
  state: ContractState;
  reason: string;
  /** ISO time of the dispatch; '' until then. */
  dispatched_at: string;
  /** The fingerprint of the zone's file when it was delivered — the reference for that file from then on; '' until then. */
  delivered_hash: string;
  /** The agent that wrote it. */
  author: string;
}

const FIELDS: (keyof ContractRecord)[] = ['ctr', 'contract', 'spec', 'assignee', 'depends', 'parent', 'zone', 'state', 'reason', 'dispatched_at', 'delivered_hash', 'author'];

/** The id prefix of an instance. */
export const CONTRACT_ID_RE = /^ctr-[0-9a-f]{8}$/;

/** The table of a session's instances, and the session folder it lives in. */
export class ContractTable {
  private constructor(readonly path: string, readonly dir: string) {}

  /** Open (create on first use) the table of `sessionId` under `projectRoot` — or the reason it cannot be. */
  static open(projectRoot: string, sessionId: string, engine: string | undefined): ContractTable | string {
    const dir = join(projectRoot, STATE_DIR, sessionId);
    const path = join(dir, 'contracts.tbl');
    const error = openTable(path, engine) ?? tabeliVersionError(path, ['help'], `upgrade it: ${engine ?? 'tabeli'} upgrade ${path}`);
    return error ? `contracts: ${error}` : new ContractTable(path, dir);
  }

  /** Every instance, in the order written. */
  all(): ContractRecord[] {
    return queryTable(this.path, []).map(asRecord);
  }

  get(ctr: string): ContractRecord | null {
    const [r] = queryTable(this.path, [`ctr=${ctr}`]);
    return r ? asRecord(r) : null;
  }

  /** Add an instance. Throws on a failure. */
  add(record: ContractRecord): void {
    this.ok(runTable(this.path, ['a', ...FIELDS.map(f => `${f}=${record[f]}`)]));
  }

  /** Set fields on an instance, unconditionally (the lead's own records before dispatch). */
  set(ctr: string, fields: Partial<ContractRecord>): void {
    const [r] = queryTable(this.path, [`ctr=${ctr}`]);
    if (!r) throw new Error(`no instance ${ctr}`);
    this.ok(runTable(this.path, ['s', String(r.id), ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)]));
  }

  /**
   * Move an instance from one state to another, setting `fields` with it — a
   * compare-and-swap: false when its state had changed meanwhile (tabeli's
   * exit 4), so the caller rereads instead of overwriting.
   */
  transition(ctr: string, from: ContractState, to: ContractState, fields: Partial<ContractRecord> = {}): boolean {
    const [r] = queryTable(this.path, [`ctr=${ctr}`]);
    if (!r) throw new Error(`no instance ${ctr}`);
    const run = runTable(this.path, ['s', String(r.id), `state=${to}`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`), 'if', `state=${from}`]);
    if (run.status === 4) return false;
    this.ok(run);
    return true;
  }

  private ok(run: ReturnType<typeof runTable>): void {
    if (run.status !== 0) throw new Error(`${run.error?.message ?? `${run.stderr}${run.stdout}`}`.trim());
  }

  // ---------------------------------------------------------------- skeleton

  private skeletonPath(): string {
    return join(this.dir, 'skeleton.json');
  }

  /** The perimeter as it was at dispatch: its globs and every file with its fingerprint — null before any dispatch. */
  skeleton(): Skeleton | null {
    if (!existsSync(this.skeletonPath())) return null;
    try { return JSON.parse(readFileSync(this.skeletonPath(), 'utf-8')) as Skeleton; } catch { return null; }
  }

  /** Take the perimeter's picture: every file the globs admit, fingerprinted. */
  writeSkeleton(projectRoot: string, globs: string[]): Skeleton {
    const files = Object.fromEntries(perimeterFiles(projectRoot, globs).map(f => [f, fingerprint(readFileSync(join(projectRoot, f), 'utf-8'))]));
    const skeleton = { globs, files };
    writeFileAtomic(this.skeletonPath(), JSON.stringify(skeleton, null, 1) + '\n');
    return skeleton;
  }
}

export interface Skeleton {
  globs: string[];
  /** file (from the project root) → fingerprint at dispatch. */
  files: Record<string, string>;
}

/** The fingerprint each file of the perimeter is expected to have now: the dispatch's, or what a delivered zone left. */
export function expectedFingerprints(skeleton: Skeleton, records: ContractRecord[]): Record<string, string> {
  const out = { ...skeleton.files };
  for (const r of records) {
    const zone = r.delivered_hash ? parseZone(r.zone) : null;
    if (zone && (r.state === 'delivered' || r.state === 'merged')) out[zone.file] = r.delivered_hash;
  }
  return out;
}

function asRecord(r: Record<string, string>): ContractRecord {
  const out = {} as Record<string, string>;
  for (const f of FIELDS) out[f] = r[f] ?? '';
  return out as unknown as ContractRecord;
}

/** The files of the perimeter: the project's files the globs admit (the DOMAINS dimension's FOR). */
export function perimeterFiles(projectRoot: string, globs: string[]): string[] {
  return projectFiles(projectRoot, rel => matchesAnyGlob(rel, globs));
}

// -------------------------------------------------------------------- zones

/** One zone: a file and the lines of its opening and closing comments. */
export interface Zone {
  file: string;
  open: number;
  close: number;
}

/** The text of a zone's opening and closing marks, as the lead writes them inside a comment. */
export function zoneMarks(ctr: string): { open: string; close: string } {
  return { open: `agent-pack ${ctr}`, close: `agent-pack end ${ctr}` };
}

/** The lines of `text` (1-based) holding an opening or closing mark of `ctr`. */
function markLines(text: string, ctr: string): { opens: number[]; closes: number[] } {
  const { open, close } = zoneMarks(ctr);
  const opens: number[] = [];
  const closes: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(close)) closes.push(i + 1);
    else if (line.includes(open)) opens.push(i + 1);
  });
  return { opens, closes };
}

/**
 * Find the zones of `ids` across `files` (from the project root). Each id has
 * one zone: an opening mark and, after it in the same file, a closing one.
 * What is wrong is told per id: no marks, two zones, a closing mark missing or
 * before the opening one.
 */
export function scanZones(projectRoot: string, files: string[], ids: string[]): { zones: Map<string, Zone>; problems: Map<string, string> } {
  const zones = new Map<string, Zone>();
  const problems = new Map<string, string>();
  const found = new Map<string, { file: string; opens: number[]; closes: number[] }[]>();
  for (const file of files) {
    const text = readFileSync(join(projectRoot, file), 'utf-8');
    for (const ctr of ids) {
      if (!text.includes(ctr)) continue;
      const marks = markLines(text, ctr);
      if (marks.opens.length + marks.closes.length > 0) found.set(ctr, [...(found.get(ctr) ?? []), { file, ...marks }]);
    }
  }
  for (const ctr of ids) {
    const hits = found.get(ctr) ?? [];
    const { open, close } = zoneMarks(ctr);
    if (hits.length === 0) { problems.set(ctr, `no zone: write \`${open}\` where the work starts and \`${close}\` where it ends, in one file, inside comments`); continue; }
    if (hits.length > 1) { problems.set(ctr, `marks in ${hits.length} files (${hits.map(h => h.file).join(', ')}) — a zone is one file`); continue; }
    const [h] = hits;
    if (h.opens.length !== 1 || h.closes.length !== 1) { problems.set(ctr, `${h.file}: ${h.opens.length} opening and ${h.closes.length} closing marks — one of each`); continue; }
    if (h.closes[0] <= h.opens[0]) { problems.set(ctr, `${h.file}: the closing mark (line ${h.closes[0]}) comes before the opening one (line ${h.opens[0]})`); continue; }
    zones.set(ctr, { file: h.file, open: h.opens[0], close: h.closes[0] });
  }
  return { zones, problems };
}

/** Whether `text` still holds any mark of `ctr`. */
export function hasMarks(text: string, ctr: string): boolean {
  const { opens, closes } = markLines(text, ctr);
  return opens.length + closes.length > 0;
}

/** A zone as the table writes it, and back. */
export function zoneText(zone: Zone): string {
  return `${zone.file}:${zone.open}-${zone.close}`;
}

export function parseZone(text: string): Zone | null {
  const m = /^(.+):(\d+)-(\d+)$/.exec(text);
  return m ? { file: m[1], open: Number(m[2]), close: Number(m[3]) } : null;
}
