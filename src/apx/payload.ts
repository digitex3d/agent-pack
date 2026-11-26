// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * An agent's `.apx` as a pack (pack.ts) with one section, `image`: the
 * payload `{ build, document }` — build provenance (the agent-pack version
 * and the `checks` a checked condition needs included) and the agent's compiled
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

/** The section a whole document was, in a pack of the form before the store — still read. */
export const IMAGE_SECTION = 'image';

/** A document of the pack: its build, its meta and the ids of its blocks — '' is the pack's own. */
const VIEW_SECTION = 'view';

/** A block of the store, named by its id: kept once, whoever holds it. */
const BLOCK_SECTION = 'block';

/** The section that makes a pack a unit's — the main's or a team's: what it is and holds, and the text `start` prints. */
export const UNIT_SECTION = 'unit';

/** A unit's own section: its kind and identity, what it holds, and its compiled text. A team holds one team, itself. */
export interface UnitSection {
  kind: 'main' | 'team';
  name: string;
  about: string;
  version: string;
  teams: { name: string; about: string; members: string[] }[];
  /** Its standalone agents. */
  members: { name: string; about: string }[];
  /** What `start` prints: the main's rules and orchestration, a team's routing and flows. */
  text: string;
}

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

/** How a document's payload is built: the agent-pack that builds it, the checks and limits it records. */
export interface PayloadBuild {
  agentPackVersion: string;
  checks?: ApxChecks | null;
  limits?: ApxLimits;
}

/**
 * A compiled document's payload: its build provenance and the document
 * itself. The build hash is the document's own content hash — same sources,
 * same hash.
 */
export function payloadFor(document: string, how: PayloadBuild): ApxPayload {
  const { agentPackVersion, checks = null, limits = {} } = how;
  const compact = JSON.stringify(JSON.parse(document));
  const build: ApxBuild = {
    builtAt: new Date().toISOString(),
    agentPackVersion,
    hash: sha256Hex(compact).slice(0, 12),
    ...(checks ? { checks } : {}),
    ...(limits.waitMax ? { waitMax: limits.waitMax } : {}),
    ...(limits.markMax ? { markMax: limits.markMax } : {}),
    ...(limits.drivers?.length ? { drivers: limits.drivers } : {}),
  };
  return { build, document: compact };
}

/** A document a pack holds, under its name — '' is the pack's own: an agent's in its apx, a unit's flows in the unit's. */
export interface Held {
  name: string;
  payload: ApxPayload;
}

/** A view as a pack keeps it: a document without its blocks — each one named by its address and its id, kept once in the store. */
interface View {
  build: ApxBuild;
  schemaVersion: unknown;
  meta: unknown;
  blocks: [address: string, id: string][];
}

/**
 * The data of a pack: a store of blocks and a view per document.
 *
 * One id, one block, one definition: every block is a `block:<id>` section,
 * written once whoever holds it, and a document is a `view:<name>` section —
 * its build, its meta and the ids of its blocks, in order. That a document
 * has a block is its view naming the id, never a copy. Two documents holding
 * different blocks under one id fail the build.
 */
export function storeSections(held: readonly Held[], compress: boolean): Section[] {
  const section = (type: string, name: string, json: string): Section => (compress ? gzipSection(type, name, json) : { type, name, encoding: 'json', data: json });
  const blocks = new Map<string, { json: string; from: string }>();
  const views: Section[] = [];
  for (const { name, payload } of held) {
    const doc = JSON.parse(payload.document) as { schemaVersion: unknown; meta: unknown; blocks: Record<string, { id: string }> };
    const who = name || 'this document';
    for (const block of Object.values(doc.blocks)) {
      const json = JSON.stringify(block);
      const prior = blocks.get(block.id);
      if (prior && prior.json !== json) throw new Error(`one id, one definition: ${block.id} is one block in ${prior.from} and another in ${who}`);
      if (!prior) blocks.set(block.id, { json, from: who });
    }
    const view: View = { build: payload.build, schemaVersion: doc.schemaVersion, meta: doc.meta, blocks: Object.entries(doc.blocks).map(([address, block]) => [address, block.id]) };
    views.push(section(VIEW_SECTION, name, JSON.stringify(view)));
  }
  return [...views, ...[...blocks].map(([id, block]) => section(BLOCK_SECTION, id, block.json))];
}

/** The whole `.apx` file of an agent: the bundled engine, then the pack lines — its view and its blocks. */
export function apxFile(engine: string, document: string, agentPackVersion: string, compress: boolean, checks: ApxChecks | null = null, limits: ApxLimits = {}, name = ''): string {
  const payload = payloadFor(document, { agentPackVersion, checks, limits });
  return packFile(engine, { name, version: agentPackVersion, engine: `agent-pack ${agentPackVersion}` }, storeSections([{ name: '', payload }], compress));
}

/**
 * A unit's `.apx`: the engine once, the unit's section, then the store — a
 * view for its own document (its flows) and for everything it holds, every
 * agent and in the main every team, and each block once.
 */
export function unitApxFile(engine: string, agentPackVersion: string, unit: UnitSection, store: Section[]): string {
  return packFile(engine, { name: unit.name, version: unit.version || agentPackVersion, engine: `agent-pack ${agentPackVersion}` },
    [{ type: UNIT_SECTION, name: '', encoding: 'json', data: JSON.stringify(unit) }, ...store]);
}

/** Read the payload back from an `.apx` file's own text. */
export function parsePayload(fileText: string): ApxPayload {
  return Pack.isPack(fileText) ? packPayload(Pack.fromText(fileText)) : payloadOf(oldDataLine(fileText));
}

/** Whether a pack holds a document under `name` — '' is its own. */
export function packHolds(pack: Pack, name = ''): boolean {
  return pack.entry(VIEW_SECTION, name) !== null || pack.entry(IMAGE_SECTION, name) !== null;
}

/** The names of the documents a pack holds — its own ('') first. */
export function heldNames(pack: Pack): string[] {
  const names = new Set([VIEW_SECTION, IMAGE_SECTION].flatMap(type => pack.entries(type).map(entry => entry.name)));
  return [...names].sort((left, right) => Number(right === '') - Number(left === ''));
}

/**
 * The payload of an opened pack — a file's, or the data a compiled binary
 * carries (`Pack.fromData`): the document `name` views, each block taken from
 * the store ('' is the pack's own). A pack of the form before the store reads
 * its `image` section.
 */
export function packPayload(pack: Pack, name = ''): ApxPayload {
  const view = pack.json<View>(VIEW_SECTION, name);
  if (!view) {
    const image = pack.section(IMAGE_SECTION, name);
    if (!image) throw new Error(name ? `no ${name} in this pack` : 'this .apx carries no document — rebuild it: agent-pack bundle all');
    return payloadOf(image.toString('utf-8'));
  }
  const blocks: Record<string, unknown> = {};
  for (const [address, id] of view.blocks) {
    const block = packBlock(pack, id);
    if (block === null) throw new Error(`this pack is damaged — ${name || 'its document'} names the block ${id}, which it does not hold`);
    blocks[address] = block;
  }
  return { build: view.build, document: JSON.stringify({ schemaVersion: view.schemaVersion, meta: view.meta, blocks }) };
}

/** One block of the pack's store, by its id — null when the pack holds none. */
export function packBlock<T>(pack: Pack, id: string): T | null {
  return pack.json<T>(BLOCK_SECTION, id);
}

/** The name of a document of the pack that has the block `id` — its own first — or null: an id is one block, whoever holds it. */
export function viewHolding(pack: Pack, id: string): string | null {
  const names = pack.entries(VIEW_SECTION).map(entry => entry.name).sort((left, right) => Number(right === '') - Number(left === ''));
  return names.find(name => pack.json<View>(VIEW_SECTION, name)?.blocks.some(([, held]) => held === id)) ?? null;
}

function payloadOf(json: string): ApxPayload {
  const parsed = JSON.parse(json) as { build: ApxBuild; document: unknown };
  return { build: parsed.build, document: JSON.stringify(parsed.document) };
}

function oldDataLine(fileText: string): string {
  const at = fileText.lastIndexOf(`\n${OLD_MARK}`);
  if (at < 0) throw new Error('this .apx carries no agent data — rebuild it: agent-pack bundle all');
  const line = fileText.slice(at + 1 + OLD_MARK.length).trimEnd();
  return line.startsWith('gzip:') ? gunzipSync(Buffer.from(line.slice(5), 'base64')).toString('utf-8') : line.slice(5);
}
