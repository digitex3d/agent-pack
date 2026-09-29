// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `.apx` files `bundle all` writes — one per agent, whatever adapters are
 * configured: the apx is agent-pack's standard output. Adapters only choose
 * what goes into their harness: a pointer to the apx, or the complete `.md`.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PACKAGE_ROOT } from '../config.js';
import type { EmittedFile } from '../../adapters/types.js';
import { apxFile } from './payload.js';

import { APX_DIR, apxPath } from './paths.js';

let engine: string | null = null;
let version: string | null = null;

/**
 * The agent's `.apx` (engine + data), and the `package.json` that makes Node
 * run every `.apx` in the directory as CommonJS — even inside a project whose
 * own package.json says `"type": "module"`.
 */
export function apxFiles(agent: string, document: string, projectRoot: string, compress: boolean): EmittedFile[] {
  engine ??= readFileSync(resolve(PACKAGE_ROOT, 'dist/apx-engine.js'), 'utf-8');
  version ??= (JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
  return [
    { path: resolve(projectRoot, apxPath(agent)), content: apxFile(engine, document, version, compress) },
    { path: resolve(projectRoot, APX_DIR, 'package.json'), content: '{ "type": "commonjs" }\n' },
  ];
}
