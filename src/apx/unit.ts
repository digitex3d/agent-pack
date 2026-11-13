// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A unit's own verbs, in its `.apx` — a unit is what holds agents: the main,
 * or a team. `ls` lists what it holds, `version` and `help` say what it is;
 * `start` is not one of them: a unit starts as an agent does, the engine
 * serving its own document. Any other first word names a block it holds,
 * which the engine then serves (src/apx/main.ts): `<unit> <agent> <verb> …`.
 */
import type { UnitSection } from './payload.js';
import { apxCommand } from './paths.js';
import { escapeRegex } from '../services/text.js';

/** One run of a unit verb: the unit, how it is run, where its lines go, when it was built. */
export interface UnitRun {
  unit: UnitSection;
  cmd: string;
  out: (line: string) => void;
  built: string;
}

/** What `start` says a unit's text is, by its kind. */
const WHAT: Record<UnitSection['kind'], string> = {
  main: 'its rules and its orchestration',
  team: 'its routing and its flows',
};

/** The verbs a unit answers itself — any other first word is an agent's name. */
const UNIT_VERBS: Record<string, (run: UnitRun) => void> = {
  ls: ({ unit, cmd, out }) => {
    for (const t of unit.teams) {
      out(`team ${t.name}${about(t.about)}`);
      for (const m of t.members) out(`  ${m}`);
    }
    if (unit.members.length) out('agents');
    for (const a of unit.members) out(`  ${a.name}${about(a.about)}`);
    out(`# an agent's own verbs: ${cmd} <agent> help`);
  },
  version: ({ unit, out, built }) => out(`${unit.name}${unit.version ? ` ${unit.version}` : ''} — built ${built}`),
  help: ({ unit, cmd, out }) => {
    out(`${cmd} — ${unit.about}`);
    out(`  ${cmd} start              the ${unit.kind}: ${WHAT[unit.kind]}`);
    out(`  ${cmd} ls                 the ${unit.kind === 'main' ? 'teams and agents' : 'members'} it holds`);
    out(`  ${cmd} version            its name, version and build`);
    out(`  ${cmd} <agent> <verb> …   an agent of the ${unit.kind} — its verbs: ${cmd} <agent> help`);
  },
};

const about = (text: string): string => (text ? ` — ${text}` : '');

/** Whether the first word is one of a unit's own verbs — `start` is not: a unit starts as an agent does, from its own document. */
export function isUnitVerb(word: string | undefined): word is string {
  return word !== undefined && Object.hasOwn(UNIT_VERBS, word);
}

/** Answer one of a unit's own verbs. */
export function runUnitVerb(verb: string, run: UnitRun): void {
  UNIT_VERBS[verb](run);
}

/**
 * What a unit prints, with every command of what it holds going through it:
 * the compiler writes an agent's or a team's commands as its own apx runs it
 * (`node .agent-pack/apx/<name>.apx …`), the same text it prints alone — the
 * unit, which serves it, says how it reaches it: `<cmd> <name> …`.
 */
export function throughUnit(unit: UnitSection, cmd: string): (line: string) => string {
  const own = new Map(unitHolds(unit).map(held => [apxCommand(held), `${cmd} ${held}`]));
  if (own.size === 0) return line => line;
  const pattern = new RegExp([...own.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|'), 'g');
  return line => line.replace(pattern, found => own.get(found) ?? found);
}

/** The agents a unit holds: its standalone agents, then each team's members. */
export function unitAgents(unit: UnitSection): string[] {
  return [...unit.members.map(a => a.name), ...unit.teams.flatMap(t => t.members)];
}

/** What a unit holds an image of: its agents, and — the main — its teams, each with its own document. */
export function unitHolds(unit: UnitSection): string[] {
  return [...unitAgents(unit), ...(unit.kind === 'main' ? unit.teams.map(t => t.name) : [])];
}
