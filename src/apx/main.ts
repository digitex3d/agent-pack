// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx entry point — the head of every `.apx` file. Bundled once, at
 * agent-pack's build, into `dist/apx-engine.js`; `bundle all` writes it,
 * followed by the agent's data line, as `.agent-pack/apx/<agent>.apx`.
 *
 * The file reads itself: its last line is the data — `//apx:json:<payload>`
 * or `//apx:gzip:<base64 of the gzipped payload>`.
 */
import { readFileSync } from 'fs';
import { relative } from 'path';
import { ApDocument } from '../apdoc/document.js';
import { ApxEngine } from './engine.js';
import { parsePayload, MIN_NODE_MAJOR } from './payload.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  process.stdout.write(`# error: this agent needs Node ${MIN_NODE_MAJOR} or newer (found ${process.versions.node}) — install a newer Node, then run it again\n`);
  process.exit(2);
}

// A reader that stops early (`… | head`) closes the pipe: it has what it needs.
process.stdout.on('error', err => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  throw err;
});

const self = process.argv[1];
const payload = parsePayload(readFileSync(self, 'utf-8'));
const exe = relative(process.cwd(), self) || self;
const engine = new ApxEngine(ApDocument.fromJson(payload.document), payload.build, exe, line => process.stdout.write(`${line}\n`));
void Promise.resolve(engine.run(process.argv.slice(2))).then(code => { process.exitCode = code; });
