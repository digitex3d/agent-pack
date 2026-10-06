// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `.apx` files `bundle all` writes — one per agent, whatever adapters are
 * configured: the apx is agent-pack's standard output. Adapters only choose
 * what goes into their harness: a pointer to the apx, or the complete `.md`.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PACKAGE_ROOT, TABELI_ENGINE, JUDGE_LOCK_DEFAULT, type Config } from '../config.js';
import type { EmittedFile } from '../../adapters/types.js';
import { apxFile } from './payload.js';
import type { ApxChecks } from './engine.js';
import { JudgeLock } from '../judge/lock.js';

import { APX_DIR, apxPath } from './paths.js';

let engine: string | null = null;
let version: string | null = null;

/**
 * The agent's `.apx` (engine + data), and the `package.json` that makes Node
 * run every `.apx` in the directory as CommonJS — even inside a project whose
 * own package.json says `"type": "module"`.
 */
export function apxFiles(agent: string, document: string, projectRoot: string, compress: boolean, checks: ApxChecks | null = null): EmittedFile[] {
  engine ??= readFileSync(resolve(PACKAGE_ROOT, 'dist/apx-engine.js'), 'utf-8');
  version ??= (JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
  return [
    { path: resolve(projectRoot, apxPath(agent)), content: apxFile(engine, document, version, TABELI_ENGINE, compress, checks) },
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
  return { adapter: checks.adapter.name, threshold: checks.threshold, rounds: checks.rounds, ...(model ? { model } : {}) };
}
