// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `.apx` files `bundle all` writes — one per agent, whatever adapters are
 * configured: the apx is agent-pack's standard output. Adapters only choose
 * what goes into their harness: a pointer to the apx, or the complete `.md`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKAGE_ROOT, TABELI_ENGINE, JUDGE_LOCK_DEFAULT, packageVersion, type Config } from '../config.js';
import type { EmittedFile } from '../../adapters/types.js';
import { apxFile, type ApxLimits } from './payload.js';
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
    { path: resolve(projectRoot, apxPath(agent)), content: apxFile(engine, document, packageVersion(), TABELI_ENGINE, compress, checks, limits) },
    { path: resolve(projectRoot, APX_DIR, 'package.json'), content: '{ "type": "commonjs" }\n' },
  ];
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
