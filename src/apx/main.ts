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
import { relative, resolve } from 'node:path';
import { ApDocument } from '../apdoc/document.js';
import { ApxEngine } from './engine.js';
import { Pack } from './pack.js';
import { heldNames, packPayload, packHolds, viewHolding, parsePayload, packBlock, MIN_NODE_MAJOR, UNIT_SECTION, type ApxPayload, type UnitSection } from './payload.js';
import type { ApBlockData } from '../apdoc/types.js';
import type { ApBlock } from '../apdoc/block.js';
import { LS_VERB, isUnitVerb, runUnitVerb, throughUnit, unitHolds } from './unit.js';
import { JSON_FLAG, listingOf } from './listing.js';
import { readEnvelope, takeEnvelope } from './call.js';
import { CallLog } from './callLog.js';
import { projectRootOf } from './paths.js';

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
// The envelope a call may end with is taken off before any command sees the words.
const words = takeEnvelope(process.argv.slice(2));
const argv = words.command;
const envelope = words.envelope === null ? null : readEnvelope(words.envelope);

/** This call's line in the log: the branch that serves the call says who serves it; it is written once, as the call ends — a pack that cannot be read too. */
const log = new CallLog({ words: argv, envelope, projectRoot: resolve(projectRootOf(self)) });
process.on('exit', code => log.write(code));

const text = embedded === null ? readFileSync(self, 'utf-8') : null;
const pack = embedded !== null ? Pack.fromData(embedded, self) : text !== null && Pack.isPack(text) ? Pack.fromText(text, self) : null;
const unit = pack?.json<UnitSection>(UNIT_SECTION, '') ?? null;
// In a unit, every command of an agent it holds goes through it.
if (unit) {
  // What a unit holds is named by a call to it: each agent, and — the main — each team.
  log.holds(unitHolds(unit));
  const through = throughUnit(unit, cmd);
  const plain = out;
  out = line => plain(through(line));
}

/** A pack's store as a document reads it: each block revived once, by its id. */
function storeOf(from: Pack): (id: string) => ApBlock | null {
  const revived = new Map<string, ApBlock | null>();
  return id => {
    if (!revived.has(id)) {
      const data = packBlock<ApBlockData>(from, id);
      revived.set(id, data ? ApDocument.reviveBlock(data) : null);
    }
    return revived.get(id) ?? null;
  };
}

const documents = new WeakMap<ApxPayload, ApDocument>();

/** A payload's document, parsed once however many times it is asked for. */
function documentOf(payload: ApxPayload): ApDocument {
  const known = documents.get(payload);
  if (known) return known;
  const parsed = ApDocument.fromJson(payload.document);
  documents.set(payload, parsed);
  return parsed;
}

/** Who serves the call: the agent that answers it, from the document it is served from — the one place the log is told. */
function servedBy(agent: string, from: ApxPayload | null): ApDocument | null {
  const doc = from ? documentOf(from) : null;
  log.servedBy(agent, doc);
  return doc;
}

/** Serve one agent: the one this apx is, or — `inUnit` — the one a unit's first word names. */
function serve(payload: ApxPayload, inUnit: string | null, args: string[]): void {
  const doc = documentOf(payload);
  servedBy(inUnit ?? doc.root()?.name ?? '', payload);
  // One id, one block: a block the document only refers to — a member, a team — is read from the pack's store.
  if (pack) doc.readsFrom(storeOf(pack));
  const engine = new ApxEngine(doc, payload.build, exe, out, undefined, undefined, inUnit);
  void Promise.resolve(engine.run(args)).then(code => { process.exitCode = code; });
}

/** A unit's own document — its flows — when it has one: its image with no name. */
const own = unit !== null && pack && packHolds(pack) ? packPayload(pack) : null;

/** A call the unit answers itself: it is served by the unit, in the session its own document names. */
function servedByUnit(name: string): void {
  servedBy(name, own);
}

if (unit !== null && pack !== null && argv[0] === LS_VERB && argv[1] === JSON_FLAG) {
  // A unit's listing: every document it holds, its own first.
  servedByUnit(unit.name);
  const store = storeOf(pack);
  const docs = heldNames(pack).map(holder => {
    const doc = ApDocument.fromJson(packPayload(pack, holder).document);
    doc.readsFrom(store);
    return { doc, holder };
  });
  out(JSON.stringify(listingOf(docs, { kind: unit.kind, name: unit.name })));
} else if (pack === null) serve(parsePayload(text ?? ''), null, argv);
else if (unit === null) serve(packPayload(pack), null, argv);
// A unit starts as an agent does: its own document — who it is, what it holds, its routing and flows.
else if ((argv[0] === undefined || argv[0] === 'start') && own) serve(own, null, argv);
else if (isUnitVerb(argv[0]) && !(argv[0] === 'ls' && argv.length > 1 && own)) {
  servedByUnit(unit.name);
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
  servedByUnit(unit.name);
  out(`# error: no agent '${argv[0]}' in this ${unit.kind} — the agents: ${cmd} ls`);
  process.exitCode = BAD_CALL;
}
