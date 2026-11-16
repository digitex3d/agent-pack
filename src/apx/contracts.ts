// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The zones of the contracts a MARK binds (D16, D55): pairs of comments,
 * `agent-pack <ctr-id>` opening and `agent-pack end <ctr-id>` closing, found by
 * their text in any comment syntax — where whoever runs the flow tells a
 * contract "write here". A contract has one zone or several, in several files.
 * Each contract works in a copy of its own (src/workspace): what it wrote is
 * the copy's diff, so its delivery keeps its zones, the files it created and
 * its MARK's WITHIN domain, and names the rest. The marks stay in the code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectFiles } from '../services/fs.js';
import { matchesAnyGlob } from '../services/glob.js';

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
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(close)) closes.push(index + 1);
    else if (line.includes(open)) opens.push(index + 1);
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
      const marks = [...opens.map(line => ({ line, open: true })), ...closes.map(line => ({ line, open: false }))].sort((left, right) => left.line - right.line);
      let open: number | null = null;
      for (const mark of marks) {
        if (mark.open && open !== null) { problems.set(ctr, `${file}: two opening marks, lines ${open} and ${mark.line} — close the first one`); break; }
        if (!mark.open && open === null) { problems.set(ctr, `${file}: the closing mark (line ${mark.line}) comes with no opening one before it`); break; }
        if (mark.open) open = mark.line;
        else { zones.set(ctr, [...(zones.get(ctr) ?? []), { file, open: open!, close: mark.line }]); open = null; }
      }
      if (open !== null && !problems.has(ctr)) problems.set(ctr, `${file}: the opening mark (line ${open}) is never closed`);
    }
  }
  return { zones, problems };
}

/** Zones as the table writes them, and back. */
export function zonesText(zones: Zone[]): string {
  return zones.map(zone => `${zone.file}:${zone.open}-${zone.close}`).join(';');
}

export function parseZones(text: string): Zone[] {
  return text.split(';').map(part => /^(.+):(\d+)-(\d+)$/.exec(part)).filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ file: match[1], open: Number(match[2]), close: Number(match[3]) }));
}
