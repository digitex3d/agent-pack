// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The data line of an `.apx` file — written by `bundle all`, read back by the
 * engine at the head of the same file. One format, both directions, here.
 *
 *   //apx:json:<payload>                       compact JSON (the default)
 *   //apx:gzip:<base64 of the gzipped payload> compressed
 *
 * The payload is `{ build, document }`: build provenance and the agent's
 * compiled document, exactly as `ApDocument.asJson()` wrote it.
 */
import { createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import type { ApxBuild } from './engine.js';

/** The oldest Node an apx runs on. */
export const MIN_NODE_MAJOR = 20;

const MARK = '//apx:';

export interface ApxPayload {
  build: ApxBuild;
  /** The compiled document, as JSON text. */
  document: string;
}

/**
 * The whole `.apx` file: the bundled engine, then the data line. The build
 * hash is the document's own content hash — same sources, same hash.
 */
export function apxFile(engine: string, document: string, agentPackVersion: string, compress: boolean): string {
  const compact = JSON.stringify(JSON.parse(document));
  const build: ApxBuild = {
    builtAt: new Date().toISOString(),
    agentPackVersion,
    hash: createHash('sha256').update(compact).digest('hex').slice(0, 12),
  };
  const payload = `{"build":${JSON.stringify(build)},"document":${compact}}`;
  const data = compress
    ? `${MARK}gzip:${gzipSync(payload).toString('base64')}`
    : `${MARK}json:${payload}`;
  return `${engine.trimEnd()}\n${data}\n`;
}

/** Read the data line back from an `.apx` file's own text. */
export function parsePayload(fileText: string): ApxPayload {
  const at = fileText.lastIndexOf(`\n${MARK}`);
  if (at < 0) throw new Error('this .apx carries no agent data — rebuild it: agent-pack bundle all');
  const line = fileText.slice(at + 1 + MARK.length).trimEnd();
  const json = line.startsWith('gzip:')
    ? gunzipSync(Buffer.from(line.slice(5), 'base64')).toString('utf-8')
    : line.slice(5);
  const parsed = JSON.parse(json) as { build: ApxBuild; document: unknown };
  return { build: parsed.build, document: JSON.stringify(parsed.document) };
}
