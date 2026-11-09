// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The pack (src/apx/pack.ts) — the container of every .apx: the engine, then
 * one comment line per section, a header that locates them and an end line
 * that seals it. Round trip of several sections; each read by offset from the
 * file, never by scanning; a damaged or truncated file refused; an unknown
 * section type ignored; the file still a program Node runs; the older
 * one-line apx still read by parsePayload.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

const { packFile, Pack, jsonSection, gzipSection, PACK_FORMAT } = await import('../dist/src/apx/pack.js');
const { parsePayload } = await import('../dist/src/apx/payload.js');

const engine = `#!/usr/bin/env node\nconsole.log('engine ran');\n`;
const identity = { name: 'orfeo', version: '0.1.0', engine: 'agent-pack 0.21.0', built: '2026-11-07T10:00:00.000Z' };
const rows = [{ id: 1, verb: 'write' }, { id: 2, verb: 'read' }];
const script = Buffer.from('module.exports = x => x * 2;\n');
const sections = [
  jsonSection('image', '', { blocks: 3, main: 'orfeo' }),
  gzipSection('store', 'verb-linter/vocab', JSON.stringify(rows)),
  gzipSection('compute', 'dst-05154e81', script, 'tar+gzip'),
  gzipSection('tabeli', 'linux-x64', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3])),
];

const tmp = mkdtempSync(join(tmpdir(), 'pack-'));
try {
  const text = packFile(engine, identity, sections);
  const file = join(tmp, 'orfeo.apx');
  writeFileSync(file, text);

  // --- the layout: engine, header, one line per section, end ---
  const lines = text.trimEnd().split('\n');
  assert.ok(lines[2].startsWith('//apx:header::json:'), 'the header follows the engine');
  assert.equal(lines.length, 3 + sections.length + 1, 'one line per section between header and end');
  assert.ok(lines.at(-1).startsWith('//apx:end::json:'), 'the end line closes the file');
  assert.ok(lines[3].startsWith('//apx:image::json:{'), 'a json section holds its content as it is');
  assert.ok(lines[4].startsWith('//apx:store:verb-linter/vocab:gzip:'), 'type, name and encoding name a section');
  assert.ok(lines[5].startsWith('//apx:compute:dst-05154e81:tar+gzip:'));

  // --- the header: identity, every section located and hashed, the seal ---
  const header = JSON.parse(lines[2].slice('//apx:header::json:'.length));
  assert.equal(header.format, PACK_FORMAT);
  assert.deepEqual([header.name, header.version, header.engine, header.built], ['orfeo', '0.1.0', 'agent-pack 0.21.0', identity.built]);
  assert.equal(header.sections.length, sections.length);
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(header.hash), 'the hash is the identity of the data');
  const end = JSON.parse(lines.at(-1).slice('//apx:end::json:'.length));
  assert.equal(end.hash, header.hash, 'the end line repeats the hash');
  assert.equal(end.header, Buffer.byteLength(engine), 'the end line says where the header starts');
  // the same sections under another engine: the same hash
  assert.equal(JSON.parse(packFile(`${engine}// another build\n`, identity, sections).split('\n')[3].slice('//apx:header::json:'.length)).hash, header.hash, 'the engine is not part of the identity');
  // the offsets locate each section's data in the file
  const headerEnd = end.header + Buffer.byteLength(lines[2]) + 1;
  const bytes = readFileSync(file);
  for (const [i, e] of header.sections.entries()) {
    assert.equal(bytes.subarray(headerEnd + e.offset, headerEnd + e.offset + e.bytes).toString('utf-8'), sections[i].data, `offset of ${e.type}:${e.name}`);
  }

  // --- reading: from the file, by offset, decoded and checked ---
  const pack = Pack.fromFile(file);
  assert.equal(pack.header.hash, header.hash);
  assert.deepEqual(pack.json('image'), { blocks: 3, main: 'orfeo' });
  assert.deepEqual(JSON.parse(pack.section('store', 'verb-linter/vocab').toString('utf-8')), rows, 'a gzip section comes back as its content');
  assert.ok(pack.section('compute', 'dst-05154e81').equals(script), 'bytes come back as bytes');
  assert.equal(pack.section('tabeli', 'darwin-arm64'), null, 'a section the pack has not is null');
  assert.equal(pack.entries('store').length, 1);
  assert.deepEqual(pack.entries('store').map(e => e.name), ['verb-linter/vocab']);
  pack.close();
  // the same from the text in memory
  assert.deepEqual(Pack.fromText(text).json('image'), { blocks: 3, main: 'orfeo' });

  // --- the file is a program: Node runs the engine, the sections are comments ---
  const run = spawnSync('node', [file], { encoding: 'utf-8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'engine ran');

  // --- refused: a damaged section, a truncated file, a header the end does not seal ---
  {
    const e = header.sections[1];
    const damaged = Buffer.from(bytes);
    const at = headerEnd + e.offset + 3;
    damaged[at] = damaged[at] === 65 ? 66 : 65;
    const f = join(tmp, 'damaged.apx');
    writeFileSync(f, damaged);
    const p = Pack.fromFile(f);
    assert.deepEqual(p.json('image'), { blocks: 3, main: 'orfeo' }, 'the other sections still read');
    assert.throws(() => p.section('store', 'verb-linter/vocab'), /store:verb-linter\/vocab is damaged/, 'the damaged one is refused');
    p.close();
  }
  {
    const f = join(tmp, 'truncated.apx');
    writeFileSync(f, bytes.subarray(0, bytes.length - 40));
    assert.throws(() => Pack.fromFile(f), /is truncated/, 'a file cut inside its end line is refused');
    writeFileSync(f, bytes.subarray(0, bytes.length - Buffer.byteLength(lines.at(-1)) - 1));
    assert.throws(() => Pack.fromFile(f), /carries no pack data/, 'a file without its end line is not a pack');
  }
  {
    const f = join(tmp, 'unsealed.apx');
    writeFileSync(f, text.replace(/"hash":"sha256:[0-9a-f]{4}/, '"hash":"sha256:0000'));
    assert.throws(() => Pack.fromFile(f), /does not seal its header/);
  }
  {
    const f = join(tmp, 'future.apx');
    writeFileSync(f, text.replace('"format":1', '"format":99'));
    assert.throws(() => Pack.fromFile(f), /format 99/);
  }

  // --- a section a reader does not know is carried and ignored ---
  {
    const p = Pack.fromText(packFile(engine, identity, [...sections, jsonSection('runs', 'r7', { pc: 4 })]));
    assert.deepEqual(p.json('runs', 'r7'), { pc: 4 });
    assert.deepEqual(p.json('image'), { blocks: 3, main: 'orfeo' });
  }

  // --- what cannot be a section ---
  assert.throws(() => packFile(engine, identity, [{ type: 'image', name: '', encoding: 'json', data: 'a\nb' }]), /line break/);
  assert.throws(() => packFile(engine, identity, [{ type: 'header', name: '', encoding: 'json', data: '{}' }]), /pack's own line/);
  assert.throws(() => packFile(engine, identity, [{ type: 'store', name: 'a b', encoding: 'json', data: '{}' }]), /not a name/);
  assert.throws(() => packFile(engine, identity, [{ type: 'store', name: 'x', encoding: 'zip', data: '{}' }]), /unknown/);

  // --- a big pack opens by its tail and its header, whatever its size ---
  {
    const big = packFile(engine, identity, [jsonSection('image', '', { big: true }), gzipSection('store', 'big', randomBytes(24 * 1024 * 1024))]);
    const f = join(tmp, 'big.apx');
    writeFileSync(f, big);
    const t0 = performance.now();
    const p = Pack.fromFile(f);
    assert.deepEqual(p.json('image'), { big: true });
    const opened = performance.now() - t0;
    p.close();
    assert.ok(opened < 500, `opening a ${(big.length / 1e6).toFixed(0)} MB pack and reading its image took ${opened.toFixed(0)} ms`);
    const r = spawnSync('node', [f], { encoding: 'utf-8' });
    assert.equal(r.stdout.trim(), 'engine ran', 'Node runs a pack of that size');
    console.log(`pack: ${(big.length / 1e6).toFixed(0)} MB opened in ${opened.toFixed(0)} ms, run by Node`);
  }

  // --- the older one-line apx still reads, until it is rebuilt ---
  {
    const payload = JSON.stringify({ build: { hash: 'abc' }, document: { blocks: [] } });
    assert.equal(parsePayload(`${engine}//apx:json:${payload}\n`).build.hash, 'abc');
    assert.equal(parsePayload(`${engine}//apx:gzip:${gzipSync(payload).toString('base64')}\n`).build.hash, 'abc');
    assert.throws(() => parsePayload(engine), /no agent data/);
  }
  console.log('pack tests passed.');
} finally {
  rmSync(tmp, { recursive: true });
}
