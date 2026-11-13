// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The project's main: the `.ap` file at the project root that holds a `MAIN:`
 * block. The block has no name — the file's is the executable's, `orfeo.ap`
 * builds `orfeo.apx` — and holds the project's ABOUT, its VERSION, the teams
 * (`TEAMS`) and standalone agents (`MEMBER`) it holds, and its routing. The
 * file around it holds its imports and definitions, as a team's does.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { SourceRegistry } from '../sources.js';
import { EXPORT_MODIFIER, MAIN_KEY } from '../blockTypes.js';
import type { Block } from '../parseBlocks.js';
import { splitList } from '../lists.js';
import { blockUnit } from './teamMetadata.js';
import { unitNameFromPath } from '../ingest.js';

/** A name a MAIN line lists, with the line that lists it. */
interface Listed { name: string; line: number }

/** The main's file, read and parsed once. */
export interface MainFile {
  path: string;
  source: string;
  block: Block;
  /** The file's name — the executable's. */
  name: string;
  about: string;
  /** The indent of the block's lines. */
  childIndent: number;
  /** '' when the block has no VERSION. */
  version: string;
  teams: Listed[];
  members: Listed[];
  /** The file as the pipeline reads it: the block's routing at the top, its head lines blanked, numbers kept. */
  unit: string;
}

/** The lines a MAIN block holds besides its ABOUT and its routing — blanked in its unit. */
const MAIN_HEAD_LINES: ReadonlySet<string> = new Set(['VERSION', 'TEAMS', 'MEMBER']);

/** A MAIN block — `EXPORT MAIN:` too, parsed as an EXPORT named MAIN: found, so its check can refuse it. */
const isMain = (block: Block): boolean => block.key === MAIN_KEY || (block.key === EXPORT_MODIFIER && block.name === MAIN_KEY);

/** The `.ap` files at the project root that hold a `MAIN:` block — one, in a project with a main. */
function mainFilesAt(projectRoot: string, sources: SourceRegistry = new SourceRegistry()): string[] {
  if (!existsSync(projectRoot)) return [];
  return readdirSync(projectRoot).sort()
    .filter(entry => entry.endsWith('.ap'))
    .map(entry => resolve(projectRoot, entry))
    .filter(path => statSync(path).isFile() && sources.tree(path).blocks.some(isMain));
}

/** The main of the project — null when it has none. Throws when two files hold a MAIN block. */
export function readMainFile(projectRoot: string, sources: SourceRegistry = new SourceRegistry()): MainFile | null {
  const files = mainFilesAt(projectRoot, sources);
  if (files.length > 1) throw new Error(`a project has one main — ${files.map(file => basename(file)).join(' and ')} each hold a MAIN block`);
  const path = files[0];
  const block = path === undefined ? undefined : sources.tree(path).blocks.find(isMain);
  if (path === undefined || block === undefined) return null;
  const source = sources.read(path);
  return { path, source, block, name: unitNameFromPath(path), childIndent: block.children[0]?.indent ?? 0, ...headOf(block), unit: blockUnit(source.split(/\r?\n/), block, MAIN_HEAD_LINES) };
}

/** Whether a file is its project's main: at the project root — its folder — with a MAIN block. */
export function isMainFile(path: string): boolean {
  const file = resolve(path);
  return mainFilesAt(dirname(file)).includes(file);
}

/** What the head lines of a MAIN block say: its ABOUT and VERSION (the first of each), its TEAMS and MEMBER lists. */
function headOf(block: Block): Pick<MainFile, 'about' | 'version' | 'teams' | 'members'> {
  const lines = block.children.flatMap(child => (child.type === 'line' ? [child] : []));
  const first = (keyword: string): string => lines.find(line => line.keyword === keyword)?.rest.trim() ?? '';
  const listed = (keyword: string): Listed[] => lines.filter(line => line.keyword === keyword).flatMap(line => splitList(line.rest.trim()).map(name => ({ name, line: line.line })));
  return { about: first('ABOUT'), version: first('VERSION'), teams: listed('TEAMS'), members: listed('MEMBER') };
}
