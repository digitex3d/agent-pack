// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `.apx` files `bundle all` writes — one per agent, whatever adapters are
 * configured: the apx is agent-pack's standard output. Adapters only choose
 * what goes into their harness: a pointer to the apx, or the complete `.md`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, JUDGE_LOCK_DEFAULT, packageVersion, type Config } from '../config.js';
import type { EmittedFile } from '../../adapters/types.js';
import { apxFile, payloadFor, packPayload, storeSections, unitApxFile, type ApxLimits, type ApxPayload, type Held, type UnitSection } from './payload.js';
import { unitHolds } from './unit.js';
import { Pack } from './pack.js';
import type { ApxChecks } from './engine.js';
import { JudgeLock } from '../judge/lock.js';

import { APX_DIR, apxPath } from './paths.js';

let engine: string | null = null;

/**
 * The agent's `.apx` (engine + data), and the `package.json` that makes Node
 * run every `.apx` in the directory as CommonJS — even inside a project whose
 * own package.json says `"type": "module"`.
 */
export function apxFiles(agent: string, document: string, projectRoot: string, compress: boolean, checks: ApxChecks | null = null, limits: ApxLimits = {}): EmittedFile[] {
  engine ??= readFileSync(resolve(PACKAGE_ROOT, 'dist/apx-engine.js'), 'utf-8');
  return [
    { path: resolve(projectRoot, apxPath(agent)), content: apxFile(engine, document, packageVersion(), compress, checks, limits, agent) },
    { path: resolve(projectRoot, APX_DIR, 'package.json'), content: '{ "type": "commonjs" }\n' },
  ];
}

/**
 * A unit's `.apx`, `.agent-pack/apx/<unit>.apx` — the main's or a team's: the
 * engine once, the unit's section, and the store: its own document (`own`,
 * the document of its flows, when it has one) and the document of everything
 * it holds, read back from the apx each one has just been given — every block
 * once. What the build wrote no apx for fails it.
 */
export function unitApxFiles(unit: UnitSection, projectRoot: string, own: ApxPayload | null = null, compress = false): EmittedFile[] {
  engine ??= readFileSync(resolve(PACKAGE_ROOT, 'dist/apx-engine.js'), 'utf-8');
  const held: Held[] = unitHolds(unit).map(name => {
    const path = resolve(projectRoot, apxPath(name));
    if (!existsSync(path)) throw new Error(`the ${unit.kind} ${unit.name} holds ${name}, which has no apx — its build failed: fix it, then bundle again`);
    const pack = Pack.fromFile(path);
    try {
      return { name, payload: packPayload(pack) };
    } finally {
      pack.close();
    }
  });
  return [{ path: resolve(projectRoot, apxPath(unit.name)), content: unitApxFile(engine, packageVersion(), unit, storeSections([...(own ? [{ name: '', payload: own }] : []), ...held], compress)) }];
}

/** The payload of a unit's own document, as every apx's is made. */
export function unitPayload(document: string, checks: ApxChecks | null = null, limits: ApxLimits = {}): ApxPayload {
  return payloadFor(document, { agentPackVersion: packageVersion(), checks, limits });
}

/**
 * What every apx records of the `checks` config key — null without one. The
 * model is the one the judge lock pins for that same judge (the compile-time
 * judge's lock, `judge.lock`, or its default path): a project that pins its
 * judge's model checks conditions with it too; otherwise the judge's own
 * default answers, and every check records the model that did.
 */
export function apxChecks(config: Config, projectRoot: string): ApxChecks | null {
  const checks = config.checks;
  if (!checks) return null;
  const model = JudgeLock.load(config.judge?.lock ?? resolve(projectRoot, JUDGE_LOCK_DEFAULT), checks.adapter.name).model;
  return { adapter: checks.adapter.name, threshold: checks.threshold, ...(model ? { model } : {}) };
}
