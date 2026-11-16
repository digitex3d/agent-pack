// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx entry point — the head of every `.apx` file. Bundled once, at
 * agent-pack's build, into `dist/apx-engine.js`; `bundle all` writes it,
 * followed by the agent's data line, as `.agent-pack/apx/<agent>.apx`.
 *
 * The file reads itself: the pack lines at its tail are the data (pack.ts).
 * A unit's apx — the main's or a team's — holds a `unit` section and an image
 * per agent: its first word is one of its own verbs (unit.ts) or the agent to run.
 * Compiled by `agent-pack bundle --executable` into one executable, the same engine finds the
 * data lines in `__APX_PACK` instead, set by the binary's entry — and is
 * then the executable itself, `process.execPath`.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ApDocument } from '../apdoc/document.js';
import { ApxEngine } from './engine.js';
import { Pack } from './pack.js';
import { heldNames, packPayload, packHolds, viewHolding, parsePayload, MIN_NODE_MAJOR, UNIT_SECTION, type ApxPayload, type UnitSection } from './payload.js';
import { LS_VERB, START_VERB, isUnitVerb, runUnitVerb, throughUnit } from './unit.js';
import { announceIdentity } from '../../adapters/acp/events.js';
import { JSON_FLAG, listingOf } from './listing.js';

/** The data lines a compiled binary carries — undefined when this engine heads an `.apx` file. */
declare const __APX_PACK: string | undefined;

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

/** The verbs that take a block's id: in a unit, the block is found wherever it is held. */
const BY_ID: ReadonlySet<string> = new Set(['get', 'refs']);

/** The exit code of a call the apx cannot serve — as the engine's own. */
const BAD_CALL = 2;

const embedded = typeof __APX_PACK === 'string' ? __APX_PACK : null;
const self = embedded === null ? process.argv[1] : process.execPath;
const exe = relative(process.cwd(), self) || self;
const cmd = embedded === null ? `node ${exe}` : exe;
let out = (line: string): void => { process.stdout.write(`${line}\n`); };
const argv = process.argv.slice(2);
const text = embedded === null ? readFileSync(self, 'utf-8') : null;
const pack = embedded !== null ? Pack.fromData(embedded, self) : text !== null && Pack.isPack(text) ? Pack.fromText(text, self) : null;
const unit = pack?.json<UnitSection>(UNIT_SECTION, '') ?? null;
// In a unit, every command of an agent it holds goes through it.
if (unit) {
  const through = throughUnit(unit, cmd);
  const plain = out;
  out = line => plain(through(line));
}

/** Serve one agent: the one this apx is, or — `inUnit` — the one a unit's first word names. */
function serve(payload: ApxPayload, inUnit: string | null, args: string[]): void {
  const engine = new ApxEngine(ApDocument.fromJson(payload.document), payload.build, exe, out, undefined, undefined, inUnit);
  void Promise.resolve(engine.run(args)).then(code => { process.exitCode = code; });
}

/** A unit's own document — its flows — when it has one: its image with no name. */
const own = unit !== null && pack && packHolds(pack) ? packPayload(pack) : null;

if (unit !== null && pack !== null && argv[0] === LS_VERB && argv[1] === JSON_FLAG) {
  // A unit's listing: every document it holds, its own first.
  const docs = heldNames(pack).map(holder => ({ doc: ApDocument.fromJson(packPayload(pack, holder).document), holder }));
  out(JSON.stringify(listingOf(docs, { kind: unit.kind, name: unit.name })));
} else if (pack === null) serve(parsePayload(text ?? ''), null, argv);
else if (unit === null) serve(packPayload(pack), null, argv);
else if (isUnitVerb(argv[0]) && !(argv[0] === 'ls' && argv.length > 1 && own)) {
  if ((argv[0] ?? START_VERB) === START_VERB) announceIdentity(unit.name, unit.kind);
  runUnitVerb(argv[0], { unit, cmd, out, built: pack.header.built });
  // `ls` alone: what the unit holds, then its own blocks.
  if (argv[0] === 'ls' && own) serve(own, null, ['ls']);
} else if (argv[0] && packHolds(pack, argv[0])) serve(packPayload(pack, argv[0]), argv[0], argv.slice(1));
else if (own) {
  // An id is one block, whoever holds it: asked of the unit itself, a block of one of its documents is served from there.
  const holder = BY_ID.has(argv[0]) && argv[1] ? viewHolding(pack, argv[1]) : null;
  if (holder) serve(packPayload(pack, holder), holder, argv.slice(0));
  else serve(own, null, argv);
}
else {
  out(`# error: no agent '${argv[0]}' in this ${unit.kind} — the agents: ${cmd} ls`);
  process.exitCode = BAD_CALL;
}
