// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The flow `STRATEGY contracts` runs (D44), as `.ap` source: one routing WHEN
 * and one FLOW — the lead prepares and hands the work out, the members carry
 * their contracts out in the background (`DELEGATE~`, then `WAIT ALL`), the
 * lead merges. Written once here, read by
 * the builder (the members' documents, their apx, the harness script) and by
 * the orchestration (AGENTS.md) exactly as a hand-written flow is.
 */
import { FORMULAS, fill } from '../formulas.js';
import type { TeamFile } from './teamMetadata.js';
import { apxPath } from '../apx/paths.js';

/** The name of the flow a team of contracts runs. */
export function contractsFlowName(team: string): string {
  return `${team}-contracts`;
}

/**
 * The source: `WHEN <when>: RUN <flow>`, then the FLOW — at indent 0, like the
 * routing and the flows of a team file's unit. `workers` are the agents a
 * contract's BY hands work to (a team's lead for a contract handed to a team),
 * the team's own lead left out — it carries out what is blocked at the merge.
 */
export function contractsFlowSource(team: string, lead: string, workers: string[]): string {
  const F = FORMULAS.blocks.contract.flow;
  const name = contractsFlowName(team);
  // Each delegation names the apx of the agent that carries it out: its `contract` commands are that apx's.
  const delegate = (async: boolean, title: string, by: string, dos: string[]) =>
    [`        DELEGATE${async ? '~' : ''} ${title} BY ${by}:`, ...dos.map(d => `            DO ${fill(d, { apx: `node ${apxPath(by)}` })}`)];
  return [
    `WHEN ${F.when}:`,
    `    RUN ${name}`,
    '',
    `FLOW ${name}:`,
    `    STEP ${F.prepare}:`,
    ...delegate(false, F.prepare, lead, F.prepareDo),
    ...(workers.length ? [`    STEP ${F.work}:`, ...workers.flatMap(w => delegate(true, fill(F.workOf, { member: w }), w, F.workDo)), '        WAIT ALL'] : []),
    `    STEP ${F.merge}:`,
    ...delegate(false, F.merge, lead, F.mergeDo),
    '',
  ].join('\n');
}

/** The agents a team of contracts hands work to, once each, in order — its lead left out; a team in a BY stands for its lead. */
export function contractWorkers(team: TeamFile, leadOf: (name: string) => string | null): string[] {
  const lead = team.lead?.name ?? '';
  return [...new Set(team.contracts.flatMap(c => c.by.map(name => leadOf(name) ?? name)))].filter(n => n !== lead);
}
