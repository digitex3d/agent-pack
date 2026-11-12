// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The pack — the container of every `.apx` file: the bundled engine, then its
 * data as sections, one per line, each a JavaScript comment so the file stays
 * a program Node runs as it is.
 *
 *   <engine>
 *   //apx:header::json:{ format, name, version, built, engine, sections, hash }
 *   //apx:<type>:<name>:<encoding>:<data>          one line per section
 *   //apx:end::json:{ hash, header }
 *
 * `type` and `name` identify a section (`image`, `store:verb-linter/vocab`,
 * `compute:dst-05154e81`, `tabeli:linux-x64`); a reader ignores the types it
 * does not know. `encoding` says how `data` holds the content: `json` as it
 * is, `gzip` and `tar+gzip` as the base64 of the gzipped bytes. `data` never
 * holds a line break — that is what makes the line a comment.
 *
 * The header lists every section with its byte offset — relative to the end
 * of the header line, so the header does not depend on its own length — its
 * size and its sha256; `hash` is the sha256 of the sections' hashes in order:
 * the identity of the program, which the engine does not change. The end
 * line repeats the hash and says where the header starts, so a reader opens
 * a pack of any size by reading its tail and its header, then the one section
 * it needs — and a truncated or altered file is refused before anything runs.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PACK_FORMAT = 1;

const MARK = '//apx:';
const HEADER_LINE = `${MARK}header::json:`;
const END_LINE = `${MARK}end::json:`;
const NAME_RE = /^[A-Za-z0-9._/-]*$/;
const ENCODINGS = ['json', 'gzip', 'tar+gzip'] as const;

export type SectionEncoding = (typeof ENCODINGS)[number];

/** A section as it is written: `data` is the text of the line's last field. */
export interface Section {
  type: string;
  name: string;
  encoding: SectionEncoding;
  data: string;
}

/** What the header says of a section: where it is in the file, how big, its hash. */
export interface SectionEntry {
  type: string;
  name: string;
  encoding: SectionEncoding;
  /** Byte offset of `data`, from the byte after the header line's `\n`. */
  offset: number;
  bytes: number;
  sha256: string;
}

export interface PackHeader {
  format: number;
  name: string;
  version: string;
  built: string;
  engine: string;
  sections: SectionEntry[];
  hash: string;
}

/** What a pack says of itself, beside its sections. */
export interface PackIdentity {
  name?: string;
  version: string;
  engine: string;
  built?: string;
}

/** A `json` section: `content` serialised compactly. */
export function jsonSection(type: string, name: string, content: unknown): Section {
  return { type, name, encoding: 'json', data: JSON.stringify(content) };
}

/** A `gzip` section of any bytes or text. */
export function gzipSection(type: string, name: string, content: Buffer | string, encoding: 'gzip' | 'tar+gzip' = 'gzip'): Section {
  return { type, name, encoding, data: gzipSync(content).toString('base64') };
}

/** The content of a section, decoded. */
export function sectionContent(section: Pick<Section, 'encoding' | 'data'>): Buffer {
  return section.encoding === 'json' ? Buffer.from(section.data, 'utf-8') : gunzipSync(Buffer.from(section.data, 'base64'));
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function checkSection(s: Section): void {
  if (!s.type || !NAME_RE.test(s.type)) throw new Error(`pack: section type "${s.type}" is not a name`);
  if (!NAME_RE.test(s.name)) throw new Error(`pack: section name "${s.name}" is not a name`);
  if (!ENCODINGS.includes(s.encoding)) throw new Error(`pack: section encoding "${s.encoding}" is unknown`);
  if (/[\r\n]/.test(s.data)) throw new Error(`pack: section ${s.type}:${s.name} holds a line break`);
  if (s.type === 'header' || s.type === 'end') throw new Error(`pack: "${s.type}" is the pack's own line, not a section`);
}

/**
 * The whole file: the engine, the header, the sections, the end line. The
 * header's `hash` is the identity of the data — the same sections give the
 * same hash whatever the engine.
 */
export function packFile(engine: string, identity: PackIdentity, sections: Section[]): string {
  for (const s of sections) checkSection(s);
  const engineText = `${engine.trimEnd()}\n`;
  const entries: SectionEntry[] = [];
  const lines: string[] = [];
  let offset = 0;
  for (const s of sections) {
    const prefix = `${MARK}${s.type}:${s.name}:${s.encoding}:`;
    const bytes = Buffer.byteLength(s.data, 'utf-8');
    entries.push({ type: s.type, name: s.name, encoding: s.encoding, offset: offset + Buffer.byteLength(prefix, 'utf-8'), bytes, sha256: sha256(s.data) });
    const line = `${prefix}${s.data}\n`;
    lines.push(line);
    offset += Buffer.byteLength(line, 'utf-8');
  }
  const hash = `sha256:${sha256(entries.map(e => e.sha256).join(''))}`;
  const header: PackHeader = {
    format: PACK_FORMAT,
    name: identity.name ?? '',
    version: identity.version,
    built: identity.built ?? new Date().toISOString(),
    engine: identity.engine,
    sections: entries,
    hash,
  };
  const end = { hash, header: Buffer.byteLength(engineText, 'utf-8') };
  return `${engineText}${HEADER_LINE}${JSON.stringify(header)}\n${lines.join('')}${END_LINE}${JSON.stringify(end)}\n`;
}

/** Positional reads over a file or a buffer — what a pack is read through. */
interface Source {
  size: number;
  read(position: number, length: number): Buffer;
  close(): void;
}

function fileSource(path: string): Source {
  const fd = openSync(path, 'r');
  return {
    size: fstatSync(fd).size,
    read(position, length) {
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, position + got);
        if (n === 0) break;
        got += n;
      }
      return got === length ? buf : buf.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: (p, l) => buf.subarray(p, p + l), close: () => {} };
}

const TAIL = 4096;
const HEADER_CHUNK = 64 * 1024;

interface PackEnd { hash: string; header: number }

/** The end line's record — the hash of the data and the byte the header starts at. */
function endOf(source: Source, where: string): PackEnd {
  const tailStart = Math.max(0, source.size - TAIL);
  const tail = source.read(tailStart, source.size - tailStart).toString('utf-8');
  const at = tail.lastIndexOf(`\n${END_LINE}`);
  if (at < 0) { source.close(); throw new Error(`${where} carries no pack data — rebuild it: agent-pack bundle all`); }
  try {
    return JSON.parse(tail.slice(at + 1 + END_LINE.length).trimEnd()) as PackEnd;
  } catch {
    source.close();
    throw new Error(`${where} is truncated — its end line is cut`);
  }
}

/** A pack's text in two: the engine, and the data lines from the header on — `packFile` in reverse. */
export function splitPack(text: string, where = 'this .apx'): { engine: string; data: string } {
  const buf = Buffer.from(text, 'utf-8');
  const end = endOf(bufferSource(buf), where);
  const engine = buf.subarray(0, end.header).toString('utf-8');
  const data = buf.subarray(end.header).toString('utf-8');
  if (!data.startsWith(HEADER_LINE)) throw new Error(`${where} is damaged — no header where its end line says`);
  return { engine, data };
}

/**
 * A pack opened for reading: its header, and each section on demand — read
 * from its offset, checked against its hash, decoded.
 */
export class Pack {
  private constructor(private readonly source: Source, readonly header: PackHeader, private readonly dataStart: number) {}

  static fromFile(path: string): Pack {
    return Pack.open(fileSource(path), path);
  }

  static fromText(text: string, where = 'this .apx'): Pack {
    return Pack.open(bufferSource(Buffer.from(text, 'utf-8')), where);
  }

  /** Whether a file's text is a pack — else it is an apx of the older, one-line form, or no apx at all. */
  static isPack(text: string): boolean {
    return text.lastIndexOf(`\n${END_LINE}`) >= 0;
  }

  /**
   * The data lines alone — header, sections, end — as the `pack` command
   * carries them into a compiled binary. The end line still counts the
   * engine's bytes before the header, so the data is read as if it followed
   * an engine of that size.
   */
  static fromData(data: string, where = 'this pack'): Pack {
    const buf = Buffer.from(data, 'utf-8');
    const base = endOf(bufferSource(buf), where).header;
    return Pack.open({ size: base + buf.length, read: (p, l) => buf.subarray(p - base, p - base + l), close: () => {} }, where);
  }

  private static open(source: Source, where: string): Pack {
    const end = endOf(source, where);
    let headerText = '';
    let position = end.header;
    for (;;) {
      const chunk = source.read(position, HEADER_CHUNK).toString('utf-8');
      const nl = chunk.indexOf('\n');
      if (nl >= 0) { headerText += chunk.slice(0, nl); position += Buffer.byteLength(chunk.slice(0, nl + 1), 'utf-8'); break; }
      if (chunk.length === 0) { source.close(); throw new Error(`${where} is damaged — its header has no end`); }
      headerText += chunk;
      position += Buffer.byteLength(chunk, 'utf-8');
    }
    if (!headerText.startsWith(HEADER_LINE)) { source.close(); throw new Error(`${where} is damaged — no header where its end line says`); }
    const header = JSON.parse(headerText.slice(HEADER_LINE.length)) as PackHeader;
    if (header.format !== PACK_FORMAT) { source.close(); throw new Error(`${where} is a pack of format ${header.format} — this agent-pack reads format ${PACK_FORMAT}`); }
    if (header.hash !== end.hash) { source.close(); throw new Error(`${where} is damaged — its end line does not seal its header`); }
    return new Pack(source, header, position);
  }

  /** The entries of one type, in file order. */
  entries(type: string): SectionEntry[] {
    return this.header.sections.filter(e => e.type === type);
  }

  /** The entry of a section, or null when the pack has none. */
  entry(type: string, name = ''): SectionEntry | null {
    return this.header.sections.find(e => e.type === type && e.name === name) ?? null;
  }

  /** A section as it is written — null when the pack has none; an error when the bytes are not the header's. */
  raw(type: string, name = ''): Section | null {
    const e = this.entry(type, name);
    if (!e) return null;
    const data = this.source.read(this.dataStart + e.offset, e.bytes);
    if (data.length !== e.bytes || sha256(data) !== e.sha256) throw new Error(`section ${type}:${name} is damaged — its bytes are not the header's`);
    return { type, name, encoding: e.encoding, data: data.toString('utf-8') };
  }

  /** The content of a section — null when the pack has none; an error when the bytes are not the header's. */
  section(type: string, name = ''): Buffer | null {
    const raw = this.raw(type, name);
    return raw === null ? null : sectionContent(raw);
  }

  /** A `json` section parsed — null when the pack has none. */
  json<T = unknown>(type: string, name = ''): T | null {
    const content = this.section(type, name);
    return content === null ? null : (JSON.parse(content.toString('utf-8')) as T);
  }

  close(): void {
    this.source.close();
  }
}
