// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * DISTILL — the mark that a procedure's reasoning can be distilled into a
 * deterministic script. A bare line in a PROCEDURE; the contract is the
 * procedure's own — input `LENS-IN <template>` (optional), output
 * `AS <template>` (required):
 *
 *   PROCEDURE compute-totals:
 *       LENS-IN   invoice
 *       AS        totals
 *       DISTILL!!
 *       DO        add net, VAT and gross from the invoice lines
 *
 * Levels (a force-level family): `DISTILL` may, `DISTILL!` should, `DISTILL!!`
 * must, `!DISTILL` never. They matter only until the script exists — an
 * existing script is always used. The agent writes the script at the first
 * execution (how is the harness's business); agent-pack fixes only the
 * interface: any language, executable, JSON in on stdin, JSON out on stdout,
 * exit 0 = the result. Scripts live in `distilled/<id>.<ext>`, found by name.
 *
 * This module is the one place that names a script and words the instruction.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { FORMULAS, fill } from './formulas.js';
import { DISTILLED_DIR } from './apx/paths.js';

/**
 * The script id of a procedure: `dst-` + a hash of its source (the DISTILL line
 * left out — a new level is not a new program) and of every template of its
 * contract, nested ones included. Spacing and blank lines do not count; any
 * other edit gives a new id — the old script is simply no longer found, and a
 * new one is distilled.
 */
export function distillId(source: string, contracts: readonly string[] = []): string {
  const words = (text: string) => text.split(/\r?\n/)
    .filter(l => !/^[ \t]*!?DISTILL!{0,2}[ \t]*$/.test(l))
    .map(l => l.trim().replace(/[ \t]+/g, ' '))
    .filter(Boolean)
    .join('\n');
  const hash = createHash('sha256').update([source, ...contracts].map(words).join('\n\u0000\n'), 'utf-8').digest('hex');
  return `dst-${hash.slice(0, 8)}`;
}

/** Where a construct's script lives, extension left to the agent. */
export function scriptPath(id: string): string {
  return `${DISTILLED_DIR}/${id}`;
}

/** What a renderer knows of one DISTILL mark, in its own reference form. */
export interface DistillView {
  force: number;
  id: string;
  /** The level's phrase (the DISTILL force-level family). */
  intro: string;
  /** The command that runs the script: `node <apx> run <id>`. */
  run: string;
  /** The output contract template: its name and reference. */
  shape: { name: string; ref: string };
  /** Example JSON values of the output and, when declared, of the input. */
  outputExample: string;
  inputExample?: string;
}

/** The instruction lines of one DISTILL mark. */
export function distillLines(v: DistillView): string[] {
  const D = FORMULAS.keywords.DISTILL;
  if (v.force < 0) return [v.intro];
  return [
    fill(D.use, { id: v.id, run: v.run }),
    fill(D.write, { intro: v.intro, script: scriptPath(v.id), shape: fill(D.shape, v.shape) }),
    ...(v.inputExample !== undefined ? [fill(D.input, { json: v.inputExample })] : []),
    fill(D.output, { json: v.outputExample }),
  ];
}

/**
 * The scripts in `distilled/` whose id matches no DISTILL mark any more — the
 * construct was edited (new id) or removed. Reported, never deleted: they are
 * versioned work, for a human to review.
 */
export function orphanScripts(projectRoot: string, liveIds: ReadonlySet<string>): string[] {
  const dir = resolve(projectRoot, DISTILLED_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^dst-[0-9a-f]{8}(\.|$)/.test(f) && !liveIds.has(f.slice(0, 12)))
    .map(f => `${DISTILLED_DIR}/${f}`);
}
