// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * An agent's `.apx` as a pack (pack.ts) with one section, `image`: the
 * payload `{ build, document }` — build provenance (the tabeli engine and
 * the `checks` a checked condition needs included) and the agent's compiled
 * document, exactly as `ApDocument.asJson()` wrote it. Written by `bundle
 * all`, read back by the engine at the head of the same file.
 *
 * An apx of the older, one-line form — `//apx:json:<payload>` or
 * `//apx:gzip:<base64>` as the last line — still reads, until it is rebuilt.
 */
import { gunzipSync } from 'node:zlib';
import type { ApxBuild, ApxChecks } from './engine.js';
import { sha256Hex } from '../apdoc/ids.js';
import type { DriverEntry } from '../storeDrivers/registry.js';
import { Pack, gzipSection, packFile, type Section } from './pack.js';

/** The oldest Node an apx runs on. */
export const MIN_NODE_MAJOR = 20;

/** The section an agent's payload is. */
export const IMAGE_SECTION = 'image';

const OLD_MARK = '//apx:';

export interface ApxPayload {
  build: ApxBuild;
  /** The compiled document, as JSON text. */
  document: string;
}

/** What else of the config an apx carries: `wait.max`, `mark.max`, and the store drivers it must import again. */
export interface ApxLimits {
  waitMax?: string | null;
  markMax?: number | null;
  drivers?: DriverEntry[] | null;
}

/**
 * The whole `.apx` file: the bundled engine, then the pack lines with the
 * `image` section. The build hash is the document's own content hash — same
 * sources, same hash.
 */
export function apxFile(engine: string, document: string, agentPackVersion: string, tabeli: string, compress: boolean, checks: ApxChecks | null = null, limits: ApxLimits = {}, name = ''): string {
  const compact = JSON.stringify(JSON.parse(document));
  const build: ApxBuild = {
    builtAt: new Date().toISOString(),
    agentPackVersion,
    hash: sha256Hex(compact).slice(0, 12),
    tabeli,
    ...(checks ? { checks } : {}),
    ...(limits.waitMax ? { waitMax: limits.waitMax } : {}),
    ...(limits.markMax ? { markMax: limits.markMax } : {}),
    ...(limits.drivers?.length ? { drivers: limits.drivers } : {}),
  };
  const payload = `{"build":${JSON.stringify(build)},"document":${compact}}`;
  const image: Section = compress ? gzipSection(IMAGE_SECTION, '', payload) : { type: IMAGE_SECTION, name: '', encoding: 'json', data: payload };
  return packFile(engine, { name, version: agentPackVersion, engine: `agent-pack ${agentPackVersion}` }, [image]);
}

/** Read the payload back from an `.apx` file's own text. */
export function parsePayload(fileText: string): ApxPayload {
  const json = Pack.isPack(fileText) ? imageOf(fileText) : oldDataLine(fileText);
  const parsed = JSON.parse(json) as { build: ApxBuild; document: unknown };
  return { build: parsed.build, document: JSON.stringify(parsed.document) };
}

function imageOf(fileText: string): string {
  const pack = Pack.fromText(fileText);
  const image = pack.section(IMAGE_SECTION);
  if (!image) throw new Error('this .apx carries no image section — rebuild it: agent-pack bundle all');
  return image.toString('utf-8');
}

function oldDataLine(fileText: string): string {
  const at = fileText.lastIndexOf(`\n${OLD_MARK}`);
  if (at < 0) throw new Error('this .apx carries no agent data — rebuild it: agent-pack bundle all');
  const line = fileText.slice(at + 1 + OLD_MARK.length).trimEnd();
  return line.startsWith('gzip:') ? gunzipSync(Buffer.from(line.slice(5), 'base64')).toString('utf-8') : line.slice(5);
}
