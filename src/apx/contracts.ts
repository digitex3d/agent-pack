// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The instances of a team's contracts (D44) — what the apx keeps of the work a
 * lead hands out under `STRATEGY contracts`: one table per session, shared by
 * every agent of it (beside the session's variables), each instance a record
 * whose state the code moves, never the text — a transition is a tabeli
 * compare-and-swap, so two agents never move the same instance twice.
 *
 * The zones: pairs of comments, `agent-pack <ctr-id>` opening and
 * `agent-pack end <ctr-id>` closing, found by their text in any comment syntax
 * — where the lead tells an instance "write here". An instance may have none
 * (new code: its limit is its assignee's domains) or several, in several files.
 * Each instance works in a copy of its own (src/workspace): what it wrote is
 * the copy's diff, so its delivery keeps exactly what its contract's WITHIN
 * admits, and names the rest.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { RecordTable } from './recordTable.js';
import { projectFiles } from '../services/fs.js';
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
  /** Where its zones are, in the base: `file:open-close;file:open-close`; '' when it has none, or until dispatched. */
  zone: string;
  state: ContractState;
  reason: string;
  /** ISO time of the dispatch; '' until then. */
  dispatched_at: string;
  /** The globs the assignee wrote at dispatch, comma separated — a domain limit, kept if the lead takes it over. */
  writes: string;
  /** What its delivery left out, `; ` separated; '' when nothing. */
  left_out: string;
  /** Why it left that out — the assignee's word; '' when nothing was. */
  why: string;
  /** The agent that wrote it. */
  author: string;
}

const FIELDS: (keyof ContractRecord)[] = ['ctr', 'contract', 'spec', 'assignee', 'depends', 'parent', 'zone', 'state', 'reason', 'dispatched_at', 'writes', 'left_out', 'why', 'author'];

/** The id prefix of an instance. */
export const CONTRACT_ID_RE = /^ctr-[0-9a-f]{8}$/;

/** The table of a session's instances, and the session folder it lives in. */
export class ContractTable extends RecordTable<ContractRecord> {
  /** Open (create on first use) the table of `sessionId` under `projectRoot` — or the reason it cannot be. */
  static open(projectRoot: string, sessionId: string, engine: string | undefined): ContractTable | string {
    const at = RecordTable.place(projectRoot, sessionId, engine, 'contracts.tbl', 'contracts');
    return typeof at === 'string' ? at : new ContractTable(at.path, at.dir, FIELDS, 'ctr');
  }
}

export interface Skeleton {
  globs: string[];
  /** file (from the project root) → fingerprint at dispatch. */
  files: Record<string, string>;
}

/** The project's files the globs admit — where the lead's marks are looked for. */
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
 * Find the zones of `ids` across `files` (from the project root): each opening
 * mark and the closing one after it, in any number of files. An id with no
 * mark has no zone — none is required here. What is wrong is told per id: a
 * closing mark with no opening one before it, two openings in a row, an
 * opening never closed.
 */
export function scanZones(projectRoot: string, files: string[], ids: string[]): { zones: Map<string, Zone[]>; problems: Map<string, string> } {
  const zones = new Map<string, Zone[]>();
  const problems = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(join(projectRoot, file), 'utf-8');
    for (const ctr of ids) {
      if (!text.includes(ctr) || problems.has(ctr)) continue;
      const { opens, closes } = markLines(text, ctr);
      const marks = [...opens.map(line => ({ line, open: true })), ...closes.map(line => ({ line, open: false }))].sort((a, b) => a.line - b.line);
      let open: number | null = null;
      for (const m of marks) {
        if (m.open && open !== null) { problems.set(ctr, `${file}: two opening marks, lines ${open} and ${m.line} — close the first one`); break; }
        if (!m.open && open === null) { problems.set(ctr, `${file}: the closing mark (line ${m.line}) comes with no opening one before it`); break; }
        if (m.open) open = m.line;
        else { zones.set(ctr, [...(zones.get(ctr) ?? []), { file, open: open!, close: m.line }]); open = null; }
      }
      if (open !== null && !problems.has(ctr)) problems.set(ctr, `${file}: the opening mark (line ${open}) is never closed`);
    }
  }
  return { zones, problems };
}

/** Zones as the table writes them, and back. */
export function zonesText(zones: Zone[]): string {
  return zones.map(z => `${z.file}:${z.open}-${z.close}`).join(';');
}

export function parseZones(text: string): Zone[] {
  return text.split(';').map(part => /^(.+):(\d+)-(\d+)$/.exec(part)).filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ file: m[1], open: Number(m[2]), close: Number(m[3]) }));
}
