// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The contracts of the apx — the work a flow hands out on copies of the
 * project: the `contract` verbs (mark, start, get, within, merge, land, list),
 * the `guard` a harness hook asks before each write, and the steps the
 * `delegate` service and `wait` take on a piece with a copy of its own —
 * delivering it, launching it on another harness, folding it back in.
 *
 * What it uses of the engine: its output, its context and the session —
 * never the executors.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ApDocument as ApDocumentClass } from '../apdoc/document.js';
import type { ApRef } from '../apdoc/types.js';
import type { DomainBlock } from '../apdoc/blocks.js';
import { refName } from '../../adapters/md/phrases.js';
import { FORMULAS, fill } from '../formulas.js';
import { WORK_DIR, apxPath } from './paths.js';
import { jsonExample, jsonSchemaOf } from '../shapeSchema.js';
import { shortId } from '../apdoc/ids.js';
import { perimeterFiles, scanZones, zoneMarks, zonesText, parseZones } from './contracts.js';
import { DelegationTable, CONTRACT_ID_RE, MARK_ID_RE, Piece, STATE, pieceRecord, pieceOf, answerFlag, type DelegationRecord } from './delegations.js';
import { ApxArgs } from './args.js';
import { splitHarness, type ApMark, type HarnessInvocation } from '../delegation.js';
import { parsePayload } from './payload.js';
import { resolveWorkspace } from '../workspace/registry.js';
import type { Allowed, Delivery, WorkspaceSession } from '../workspace/types.js';
import { constantOf, readsOf } from '../vars.js';
import { NODE, countOf, emptyVariable, notCompiled, reasonOf, type ApxContext, type ApxOutput, type ApxSession, type NamedValue } from './service.js';
import { type PerimeterGlobs } from '../primitives.js';
import { matchesAnyGlob, literalGlob } from '../services/glob.js';

/** What the apx says, by area (src/config/formulas.json). */
const WORDS = FORMULAS.apx;

/** What every contract verb works with: the session's registry, where the copies live. */
interface ContractContext {
  table: DelegationTable;
  /** The project root — where the copies live. */
  root: string;
  session: string;
  /** The session's copies, opened on first use. */
  workspace: () => WorkspaceSession;
}

/** How many zones a MARK binds at most when neither it nor the config says (`mark.max`). */
export const DEFAULT_MARK_MAX = 20;

/** The workspace engine the copies run on — one ships; a second one is a registry entry and a config key (src/workspace/registry.ts). */
const CONTRACT_WORKSPACE = 'git';

/** The sides `contract merge --prefer` keeps. */
const MERGE_SIDE = { ours: 'ours', theirs: 'theirs' } as const;

/** The value of `--flag <value>` among args, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  return new ApxArgs(args).value(flag.replace(/^--/, ''));
}

/** What a delivery exits with when it does not go through: the piece's state does not allow it, the call lacks a flag, its trial refuses it. */
const DELIVERY_EXIT = { state: 1, usage: 2, refused: 3 } as const;

/** One delivery of a contract: the piece, its trial run on the copy, the reason for what it leaves out, and — from another harness — its answer. */
interface ContractDelivery {
  piece: Piece;
  trial: Delivery;
  reason: string | undefined;
  answer: string | null;
}

/** Why a trial delivery cannot go through — its zones' marks lost, the work done outside the copy, something left out with no reason — or null when it can. */
type DeliveryRefusal = 'lostZones' | 'strayed' | 'leftOut';

function deliveryRefusal(delivery: Delivery, why: string | undefined): DeliveryRefusal | null {
  if (delivery.lostZones.length) return 'lostZones';
  if (delivery.committed.length === 0 && delivery.strayed.length) return 'strayed';
  if (delivery.leftOut.length && !why) return 'leftOut';
  return null;
}

/** What `scanZones` finds: the zones of each contract, and why some contracts' marks are wrong. */
type ScannedZones = ReturnType<typeof scanZones>;

/** A MARK of this agent's flows, with its id. */
type IdentifiedMark = ApMark & { id: string };

/** Who carries out a list's contracts, and where: in a copy here, or on another harness through its recipe. */
interface Runner {
  /** The `--by` value, as written. */
  by: string;
  agent: string;
  elsewhere: { harness: string; invocation: HarnessInvocation } | null;
}

/** The zones each contract of a list starts on, and the WITHIN domain its MARK lets it write beyond them. */
interface StartZones {
  zones: ScannedZones['zones'];
  within: string[];
}

/** One contract to start: its MARK, who runs it, its zones, and when the round started. */
interface ContractStart extends StartZones {
  mark: IdentifiedMark;
  runner: Runner;
  record: DelegationRecord;
  startedAt: string;
}

export class ContractWork {
  constructor(private readonly host: ApxOutput & ApxContext & ApxSession) {}

  /** The session's registry and copies — or null after saying why there are none. */
  private context(): ContractContext | null {
    const session = this.host.sessionIdOrReason();
    if ('reason' in session) { this.host.lastCode = this.host.refuse(2, WORDS.variables.nothingDone, { reason: session.reason }); return null; }
    const root = this.host.projectRoot;
    const table = DelegationTable.open(root, session.id);
    let copies: WorkspaceSession | null = null;
    // The copies: opened on the first verb that needs them — a project outside git fails there, with the way out.
    return { table, root, session: session.id, workspace: () => copies ??= resolveWorkspace(CONTRACT_WORKSPACE).session(root, session.id) };
  }

  /**
   * `contract <verb> …` — the contracts a flow's MARKs bind (D16–18): `mark`
   * one, `start` a MARK's, `get` one's spec, `within` for the hook, `merge` and
   * `land` after a conflict, `list`. Delivering, blocking, taking over — the
   * life of any piece handed out — is `delegate`'s, on the same registry.
   */
  serve(args: string[]): number {
    const [verb, ...rest] = args;
    const verbs = 'mark|start|get|within|merge|land|list';
    if (!verb || !verbs.split('|').includes(verb)) {
      const problem = verb ? fill(WORDS.contract.verbUnknown, { verb }) : WORDS.contract.verbMissing;
      return this.host.refuse(2, WORDS.contract.verbProblem, { problem, verbs });
    }
    const contracts = this.context();
    if (!contracts) return this.host.lastCode;
    try {
      switch (verb) {
        case 'mark': return this.mark(contracts, rest);
        case 'start': return this.start(contracts, rest);
        case 'get': return this.get(contracts, rest);
        case 'within': return this.within(contracts, rest);
        case 'merge': return this.merge(contracts, rest);
        case 'land': return this.land(contracts);
        default: return this.list(contracts, rest);
      }
    } catch (error) {
      return this.host.refuse(2, WORDS.contract.failed, { reason: reasonOf(error) });
    }
  }

  /** An agent's own perimeter — this one's, or a fellow member's from its apx beside this one; null when it has none or no apx. */
  private agentPerimeter(agent: string): PerimeterGlobs | null {
    if (agent === this.host.root.name) return this.host.doc.perimeter();
    const file = resolve(this.host.projectRoot, apxPath(agent));
    if (!existsSync(file)) return null;
    try {
      return ApDocumentClass.fromJson(parsePayload(readFileSync(file, 'utf-8')).document).perimeter();
    } catch {
      return null;
    }
  }

  /**
   * The perimeter a piece is handed under, as the registry keeps it (D65): the
   * WRITES globs of the domains of its `@WITHIN`, and those of its assignee's
   * own — JSON, one glob list each; '' when neither has one.
   */
  workPerimeter(within: readonly string[], assignee: string): string {
    const sets: string[][] = [];
    if (within.length > 0) sets.push([...new Set(within.flatMap(name => this.domainGlobs(name)))]);
    const own = assignee ? this.agentPerimeter(assignee) : null;
    if (own) sets.push(own.writes);
    return sets.length > 0 ? JSON.stringify(sets) : '';
  }

  /**
   * `guard <path> [--agent <name>] [--subagent] [--after]` — whether a write
   * stays within the perimeter of the work in progress (D65): exit 0, or 3 with
   * who, which file, which perimeter, and what to do. What a harness hook asks
   * before every write (adapters/claude-code).
   *
   * Which work a write belongs to: the harness says only who writes — the main
   * conversation, or a subagent of a given name. A subagent named as the
   * assignee of pieces in progress is held to theirs; one it cannot tell apart
   * (a fork, an agent no piece names) to every piece in progress that has a
   * perimeter — the narrowest reading, never the widest. The main conversation
   * — whoever runs the flow — is held to none. Every agent is held to its own
   * `@WITHIN` as well. A contract's work goes in its copy: `--after`, there,
   * says whether the file stays within the contract.
   */
  guard(args: string[]): number {
    const valueAfter = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] ?? '' : null; };
    const agent = valueAfter('--agent') || '';
    const subagent = args.includes('--subagent');
    const path = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--agent');
    if (!path) return this.host.refuse(2, WORDS.guard.pathNeeded);
    const inCopy = new RegExp(`^${WORK_DIR}/(ctr-[0-9a-f]{8})/(.+)$`).exec(path);
    if (args.includes('--after')) {
      if (!inCopy) return 0;
      const contracts = this.context();
      if (!contracts) return this.host.lastCode;
      return this.within(contracts, [inCopy[1], inCopy[2]]);
    }
    const blocked = (why: string) => { this.host.say(WORDS.guard.blocked, { path, why }); return 3; };
    if (agent) {
      // A contract's copy mirrors the project root: its files are judged by their path inside it.
      const own = this.agentPerimeter(agent);
      if (own && !matchesAnyGlob(inCopy ? inCopy[2] : path, own.writes)) return blocked(fill(WORDS.guard.outsideOwn, { agent, perimeter: own.writes.join(', ') || WORDS.guard.writesNothing }));
    }
    if (!subagent) return 0;
    const session = this.host.sessionIdOrReason(WORDS.guard.needs);
    if ('reason' in session) return 0;   // no session, no work recorded in it
    const table = DelegationTable.open(this.host.projectRoot, session.id);
    const running = table.all().filter(record => new Piece(record).isRunning());
    const carriedOut = agent ? running.filter(record => record.assignee === agent) : [];
    // A write in a contract's copy is that contract's: its zones are checked once written (--after).
    if (inCopy && running.some(record => record.dlg === inCopy[1])) return 0;
    const breach = this.pieceBreach(path, agent, carriedOut.length > 0 ? carriedOut : running, carriedOut.length > 0);
    return breach === null ? 0 : blocked(breach);
  }

  /** Why a write to `path` is outside the perimeter of the pieces `held` — or null when it stays within. `own`: the writer carries them out. */
  private pieceBreach(path: string, agent: string, held: DelegationRecord[], own: boolean): string | null {
    for (const record of held) {
      if (CONTRACT_ID_RE.test(record.dlg)) {
        // Its assignee works in its copy, never in the project folder; whoever else writes is not bound by it.
        if (own) return fill(WORDS.guard.inCopy, { agent, id: record.dlg, copy: WORK_DIR });
        continue;
      }
      if (!record.perimeter) continue;
      const sets = JSON.parse(record.perimeter) as string[][];
      const unmatched = sets.find(globs => !matchesAnyGlob(path, globs));
      if (unmatched) {
        const who = own
          ? fill(WORDS.guard.carrying, { agent, id: record.dlg, step: record.step })
          : fill(WORDS.guard.inProgress, { id: record.dlg, step: record.step, assignee: record.assignee ? `, ${record.assignee}` : '' });
        return fill(WORDS.guard.outsidePerimeter, { who, perimeter: unmatched.join(', ') || WORDS.guard.writesNothing });
      }
    }
    return null;
  }

  /** A MARK of this agent's flows by id — or null after saying why. */
  private markArg(id: string | undefined, usage: string): IdentifiedMark | null {
    const mark = id ? this.host.doc.meta.marks?.[id] : undefined;
    if (!id || !MARK_ID_RE.test(id) || !mark) {
      const problem = id ? fill(WORDS.contract.markUnknown, { id }) : WORDS.contract.markMissing;
      this.host.lastCode = this.host.refuse(2, WORDS.contract.markProblem, { problem, usage });
      return null;
    }
    return { ...mark, id };
  }

  /** A contract by its id — or null after saying why. */
  private contractArg(contracts: ContractContext, id: string | undefined, usage: string): DelegationRecord | null {
    if (!id || !CONTRACT_ID_RE.test(id)) { this.host.lastCode = this.host.refuse(2, WORDS.contract.idMissing, { usage }); return null; }
    const record = contracts.table.get(id);
    if (!record) { this.host.lastCode = this.host.refuse(1, WORDS.contract.noContract, { id }); return null; }
    return record;
  }

  /** The template a MARK's spec is shaped as, as a reference — null when this agent was compiled without it. */
  private specRef(mark: ApMark): ApRef | null {
    const template = this.host.doc.byKind('template').find(block => block.name === mark.spec);
    return template ? { id: template.id, target: template.address, kind: 'template' } : null;
  }

  /** The globs a domain of this document writes — what a MARK's WITHIN lets its contracts write beyond their zones. */
  private domainGlobs(name: string | null): string[] {
    const domain = name ? (this.host.doc.byKind('domain') as DomainBlock[]).find(block => block.name === name) : undefined;
    if (!domain) return [];
    const side = domain.side('WRITES');
    return [...side.globs, ...[...side.within, ...Object.keys(side.uncertain)].map(literalGlob)];
  }

  /** What a contract's delivery may keep: its zones, the files it created, and its MARK's WITHIN domain (D49). */
  private allowedOf(record: DelegationRecord): Allowed {
    const files = [...new Set(parseZones(record.zone).map(zone => zone.file))];
    return {
      globs: [...files, ...record.writes.split(',').filter(Boolean)],
      ...(files.length ? { marks: { ...zoneMarks(record.dlg), files, only: true } } : {}),
      created: true,
    };
  }

  /**
   * `mark <mrk-id> -` — whoever runs the flow binds a zone to a contract: the
   * spec on stdin, checked against the MARK's AS; the contract waits, marked,
   * until a DELEGATE of its list starts it. Its id joins the list's variable.
   */
  private mark(contracts: ContractContext, args: string[]): number {
    const usage = 'mark <mrk-id> - < spec.json';
    const mark = this.markArg(args[0], usage);
    if (!mark) return this.host.lastCode;
    if (args[1] !== '-') return this.host.refuse(2, WORDS.contract.specOnStdin, { usage });
    const waiting = this.waiting(contracts, mark);
    const limit = mark.max || this.host.build.markMax || DEFAULT_MARK_MAX;
    if (waiting.length >= limit) return this.host.refuse(3, WORDS.contract.zonesFull, { list: mark.list, max: limit });
    const specTemplate = this.specRef(mark);
    if (!specTemplate) return this.host.fail(2, notCompiled(mark.list, mark.spec));
    const text = readFileSync(0, 'utf-8').trim();
    const issues = this.host.contractIssues(text, specTemplate);
    if (issues) {
      const slots = this.host.doc.slotsOf(specTemplate);
      const example = slots ? fill(WORDS.contract.specExample, { example: JSON.stringify(jsonExample(slots, this.host.doc.slotResolver())) }) : '';
      return this.host.refuse(6, WORDS.contract.specBreaks, { spec: mark.spec, issues, example });
    }
    const spec = JSON.stringify(JSON.parse(text));
    const contractId = shortId('ctr', JSON.stringify([contracts.session, mark.id, contracts.table.all().filter(record => record.mark === mark.id).length, spec]));
    // The list's variable holds its contracts' ids — what `{{<list>}}` reads.
    const list = this.host.variable(mark.list);
    if (list) {
      const ids = [...waiting.map(record => record.dlg), contractId];
      const failed = this.host.storeVariable(list, JSON.stringify(ids));
      if (failed) return this.host.refuse(6, WORDS.contract.listRefused, { list: mark.list, reason: failed.reason });
    }
    contracts.table.add(pieceRecord({ dlg: contractId, state: STATE.marked, flow: mark.flow, step: mark.step, into: mark.list, mark: mark.id, spec, author: this.host.root.name }));
    const marks = zoneMarks(contractId);
    this.host.out(`${contractId}  ${mark.list}  ${STATE.marked}`);
    return this.host.print(this.host.phrase(WORDS.contract.marks, { open: marks.open, close: marks.close }));
  }

  /**
   * `start <mrk-id> --by <agent>` — a DELEGATE of a list starts every contract
   * its MARK left waiting: each one's zones are found by their marks, what was
   * merged since the last round lands, and each one gets its copy (D64: one
   * agent for the whole list). None waiting: nothing to start, and it says so.
   * `--by <harness>:<agent>`: each one is launched on another harness (D66) —
   * its prompt written beside its copy, its command printed, filled from the
   * harness's recipe, for the caller to run.
   */
  private start(contracts: ContractContext, args: string[]): number {
    const usage = 'start <mrk-id> --by <agent | harness:agent>';
    const mark = this.markArg(args[0], usage);
    if (!mark) return this.host.lastCode;
    const runner = this.runnerOf(args, mark, usage);
    if (!runner) return this.host.lastCode;
    const pending = this.waiting(contracts, mark);
    if (pending.length === 0) return this.host.print(this.host.phrase(WORDS.contract.nothingMarked, { list: mark.list }));
    const startZones = this.zonesToStart(contracts, mark, pending);
    if (!startZones) return this.host.lastCode;
    const landed = this.landMerged(contracts);
    if (!landed) return this.host.lastCode;
    if (landed.length) this.host.say(WORDS.landing.landed, { files: landed.join(', ') });
    const startedAt = new Date().toISOString();
    for (const record of pending) {
      if (!this.startOne(contracts, { mark, runner, record, startedAt, ...startZones })) return this.host.lastCode;
    }
    return this.reportStarted(mark, runner, pending.length);
  }

  /** The contracts of a MARK waiting to start. */
  private waiting(contracts: ContractContext, mark: IdentifiedMark): DelegationRecord[] {
    return contracts.table.all().filter(record => record.mark === mark.id && record.state === STATE.marked);
  }

  /** Who `--by` names, and where its contracts run — or null after saying why it cannot run them. */
  private runnerOf(args: string[], mark: IdentifiedMark, usage: string): Runner | null {
    const by = flagValue(args.slice(1), '--by');
    if (!by) {
      this.host.lastCode = this.host.refuse(2, WORDS.contract.whoMissing, { usage });
      return null;
    }
    const other = splitHarness(by);
    if (!other) return { by, agent: by, elsewhere: null };
    const invocation = this.host.doc.meta.harnesses?.[other.harness];
    if (!invocation) {
      this.host.lastCode = this.host.refuse(2, WORDS.contract.recipeMissing, { harness: other.harness, name: this.host.root.name, list: mark.list, by });
      return null;
    }
    return { by, agent: other.agent, elsewhere: { harness: other.harness, invocation } };
  }

  /** The zones the contracts `pending` start on, found by their marks — or null after saying which cannot start. */
  private zonesToStart(contracts: ContractContext, mark: IdentifiedMark, pending: DelegationRecord[]): StartZones | null {
    const scope = this.host.doc.perimeter()?.writes;
    const files = perimeterFiles(contracts.root, scope && scope.length ? scope : ['**']);
    const { zones, problems } = scanZones(contracts.root, files, pending.map(record => record.dlg));
    const within = this.domainGlobs(mark.within);
    const refusals = this.zoneRefusals(pending, zones, problems, within);
    if (refusals.length === 0) return { zones, within };
    for (const line of refusals) this.host.out(`refused: ${line}`);
    this.host.lastCode = this.host.refuse(3, WORDS.contract.startRefused, { count: countOf(refusals.length, 'contract', 'contracts') });
    return null;
  }

  /** What was merged since the last round, landed in the working folder: the files — or null after naming the conflicts. */
  private landMerged(contracts: ContractContext): string[] | null {
    const landing = contracts.workspace().land();
    if (!('conflicts' in landing)) return landing.landed;
    this.host.lastCode = this.host.fail(3, this.conflictsText(landing.conflicts, WORDS.landing.thenStart));
    return null;
  }

  /** One contract started: its copy opened, here or on another harness, and the registry moved to running — false after saying it moved meanwhile. */
  private startOne(contracts: ContractContext, { mark, runner, record, zones, within, startedAt }: ContractStart): boolean {
    const recordZones = zones.get(record.dlg) ?? [];
    const writes = [...new Set([...recordZones.map(zone => zone.file), ...within])];
    const { elsewhere } = runner;
    let command: string | null = null;
    if (elsewhere) command = this.openElsewhere(contracts, record.dlg, elsewhere.invocation, runner.agent, writes, this.contractPrompt(record, mark, recordZones, within), null);
    else contracts.workspace().open(record.dlg, { reads: null, writes });
    const fields = { assignee: runner.agent, zone: zonesText(recordZones), writes: within.join(','), started_at: startedAt, ...(elsewhere ? { harness: elsewhere.harness } : {}) };
    if (!contracts.table.transition(record.dlg, STATE.marked, STATE.running, fields)) {
      this.host.lastCode = this.host.refuse(4, WORDS.contract.changedList, { id: record.dlg, mark: mark.id });
      return false;
    }
    this.host.out(`${record.dlg}  → ${runner.agent}${elsewhere ? ` on ${elsewhere.harness}` : ''}${recordZones.length ? `  ${zonesText(recordZones)}` : ''}  copy: ${contracts.workspace().path(record.dlg)}`);
    if (command) this.host.out(command);
    return true;
  }

  /** What a start says once its contracts are running: how many, and how they are taken back — from another harness, how each one ends. */
  private reportStarted(mark: IdentifiedMark, { by, agent, elsewhere }: Runner, count: number): number {
    const started = countOf(count, 'contract', 'contracts');
    const takesBack = this.host.phrase(WORDS.contract.takesBack, { mark: mark.id });
    if (!elsewhere) return this.host.print(this.host.phrase(WORDS.contract.started, { started, by, takesBack }));
    this.host.say(WORDS.contract.startedElsewhere, { started, harness: elsewhere.harness });
    return this.elsewhereTail(elsewhere.invocation, agent, elsewhere.harness, { id: '<ctr-id>', many: true, flags: ' [--why "<reason>"]', then: `; ${takesBack}` });
  }

  /** Why the contracts `pending` cannot start: the zones whose marks are wrong, and those with no zone and no WITHIN domain to write in. */
  private zoneRefusals(pending: DelegationRecord[], zones: ScannedZones['zones'], problems: ScannedZones['problems'], within: string[]): string[] {
    const refusals = [...problems].map(([contractId, why]) => `${contractId}: ${why}`);
    for (const record of pending) {
      if (!zones.get(record.dlg) && !problems.has(record.dlg) && within.length === 0) {
        const marks = zoneMarks(record.dlg);
        refusals.push(fill(WORDS.contract.zoneMissing, { id: record.dlg, open: marks.open, close: marks.close }));
      }
    }
    return refusals;
  }

  /** What was merged conflicts with the working folder: the files, and what to do then. */
  private conflictsText(files: string[], then: string): string {
    return this.host.phrase(WORDS.landing.conflicts, { files: files.join(', '), then });
  }

  /** What a contract launched on another harness is handed: its spec, its zones, what else it may write — never the conversation (D66). */
  private contractPrompt(record: DelegationRecord, mark: ApMark, zones: Parameters<typeof zonesText>[0], within: string[]): string[] {
    const marks = zoneMarks(record.dlg);
    return [
      `Carry out the contract ${record.dlg}: its spec, shaped as \`${mark.spec}\`, is`,
      '```json', JSON.stringify(JSON.parse(record.spec || '{}'), null, 2), '```',
      ...(zones.length ? ['', `Its zones: ${zonesText(zones).split(';').join(', ')} — write inside them, between the lines that hold \`${marks.open}\` and \`${marks.close}\`, and leave those marks where they are.`] : []),
      '', `You may also create files${within.length ? `, and write ${within.join(', ')}` : ''}; anything else you change is left out of the delivery.`,
      'When the contract cannot be honoured as written, change nothing and say why.',
    ];
  }

  private list(contracts: ContractContext, args: string[]): number {
    const mark = args[0] ? this.markArg(args[0], 'list [mrk-id]') : null;
    if (args[0] && !mark) return this.host.lastCode;
    const listed = contracts.table.all().filter(record => CONTRACT_ID_RE.test(record.dlg) && (!mark || record.mark === mark.id));
    for (const record of listed) this.host.out(this.line(record));
    return this.host.print(this.host.phrase(WORDS.contract.listed, { count: countOf(listed.length, 'contract', 'contracts') }));
  }

  /** One contract on one line: its id, its list, how it stands, who has it, its zones, what it left out, why it stopped. */
  private line(record: DelegationRecord): string {
    const state = record.state === STATE.ended ? WORDS.contract.endedWithout : record.state;
    return `${record.dlg}  ${record.into}  ${state}${record.assignee ? `  → ${record.assignee}` : ''}${record.zone ? `  ${record.zone}` : ''}${record.left_out ? `  left out: ${record.left_out}` : ''}${record.reason ? `  — ${record.reason}` : ''}`;
  }

  private get(contracts: ContractContext, args: string[]): number {
    const record = this.contractArg(contracts, args[0], 'get <ctr-id>');
    if (!record) return this.host.lastCode;
    const assignee = record.assignee ? fill(WORDS.contract.carriedOutBy, { assignee: record.assignee }) : '';
    this.host.say(WORDS.contract.header, { id: record.dlg, list: record.into, state: record.state, assignee });
    this.host.out(`zones: ${this.zonesLine(record)}`);
    this.host.say(WORDS.contract.mayWrite, { extra: record.writes ? `, ${record.writes.split(',').join(', ')}` : '' });
    if (record.state !== STATE.marked) this.host.out(`copy: ${contracts.workspace().path(record.dlg)}`);
    if (record.reason) this.host.out(`blocked: ${record.reason}`);
    if (record.left_out) this.host.say(WORDS.deliver.done.leftOut, { files: record.left_out, why: record.why });
    this.host.out('spec:');
    this.host.print(JSON.stringify(JSON.parse(record.spec || '{}'), null, 2));
    if (record.state === STATE.running) {
      this.host.say(WORDS.contract.workInCopy, { copy: contracts.workspace().path(record.dlg) });
      this.host.out(`# when done: ${this.host.cmd} delegate deliver ${record.dlg}`);
      this.host.say(WORDS.contract.cannotHonour, { id: record.dlg });
    }
    return 0;
  }

  /** A contract's zones as `get` lists them: as it recorded them, or why it has none. */
  private zonesLine(record: DelegationRecord): string {
    if (record.zone) return record.zone.split(';').join(', ');
    return record.state === STATE.marked ? WORDS.contract.notStartedYet : 'none';
  }

  /**
   * `within <ctr> <path>` — whether a file the contract's copy changed stays
   * within it: exit 0, or 3 with the warning. What a harness hook calls as
   * soon as the file is written (adapters/claude-code).
   */
  private within(contracts: ContractContext, args: string[]): number {
    const record = this.contractArg(contracts, args[0], 'within <ctr-id> <path>');
    if (!record) return this.host.lastCode;
    const path = args[1];
    if (!path) return this.host.refuse(2, WORDS.contract.pathNeeded, { id: record.dlg });
    if (record.state === STATE.marked) return this.host.refuse(2, WORDS.contract.noCopy, { id: record.dlg });
    const delivery = contracts.workspace().deliver(record.dlg, this.allowedOf(record), { dryRun: true });
    const concernsPath = (entry: string) => entry === path || entry.startsWith(`${path} (`);
    const lost = delivery.lostZones.filter(concernsPath);
    if (lost.length) { this.host.say(WORDS.contract.marksLost, { files: lost.join(', '), id: record.dlg }); return 3; }
    const outside = delivery.leftOut.filter(concernsPath);
    if (outside.length === 0) return 0;
    this.host.say(WORDS.contract.outsideContract, { files: outside.join(', '), id: record.dlg, writes: record.writes ? fill(WORDS.contract.andWrites, { writes: record.writes }) : '' });
    return 3;
  }

  /**
   * A contract delivered from its copy (`delegate deliver <ctr-id>`): it keeps
   * its zones, the files it created and its WITHIN domain; anything else is
   * left out, and only with a reason (`--why`).
   */
  deliver(table: DelegationTable, record: DelegationRecord, words: string[]): number {
    const contracts = this.context();
    if (!contracts) return this.host.lastCode;
    const piece = new Piece(record);
    const args = new ApxArgs(words);
    if (!piece.isRunning()) return this.refuseDelivery('notRunning', { id: piece.id, state: piece.state });
    const handedBack = this.handedBack(contracts, piece, args);
    if (!handedBack) return this.host.lastCode;
    const copies = contracts.workspace();
    const trial = copies.deliver(piece.id, handedBack.allowed, { dryRun: true });
    const delivery: ContractDelivery = { piece, trial, reason: args.why(), answer: handedBack.answer };
    const refusal = deliveryRefusal(delivery.trial, delivery.reason);
    if (refusal) return this.refuseTrial(refusal, delivery, copies);
    copies.deliver(piece.id, handedBack.allowed);
    if (!this.recordDelivery(table, delivery)) return this.refuseDelivery('moved', { id: piece.id, cmd: this.host.cmd });
    this.reportDelivery(delivery);
    return 0;
  }

  /**
   * What a piece hands back: the files it may deliver and, from another
   * harness, its answer — the file its command wrote; what was carried into
   * its copy is never delivered (D66). Null after saying why it cannot.
   */
  private handedBack(contracts: ContractContext, piece: Piece, args: ApxArgs): { allowed: Allowed; answer: string | null } | null {
    const allowed = this.allowedOf(piece.record);
    switch (piece.where()) {
      case 'here':
        return { allowed, answer: null };
      case 'elsewhere': {
        if (!args.hasAnswer()) {
          this.host.lastCode = this.host.fail(DELIVERY_EXIT.usage, answerFlag(piece.record, this.host.cmd));
          return null;
        }
        const answer = this.elsewhereAnswer(contracts, piece.record);
        return answer === null ? null : { allowed: { ...allowed, exclude: [...this.carriedOf(piece.record)] }, answer };
      }
    }
  }

  /** A delivery refused before its trial: the piece is not running, or it moved meanwhile. */
  private refuseDelivery(reason: 'notRunning' | 'moved', values: Record<string, string>): number {
    return this.host.fail(DELIVERY_EXIT.state, fill(FORMULAS.apx.deliver.refused[reason], values));
  }

  /** A delivery its trial refuses: the marks of its zones lost, the work done outside its copy, or something left out with no reason. */
  private refuseTrial(refusal: DeliveryRefusal, { piece, trial }: ContractDelivery, copies: WorkspaceSession): number {
    const refused = FORMULAS.apx.deliver.refused;
    switch (refusal) {
      case 'lostZones':
        return this.host.fail(DELIVERY_EXIT.refused, fill(refused.lostZones, { id: piece.id, files: trial.lostZones.join(', ') }));
      case 'strayed':
        return this.host.fail(DELIVERY_EXIT.refused, fill(refused.strayed, { id: piece.id, files: trial.strayed.join(', '), copy: copies.path(piece.id) }));
      case 'leftOut':
        for (const entry of trial.leftOut) this.host.out(fill(FORMULAS.apx.deliver.done.leftOutLine, { entry }));
        return this.host.fail(DELIVERY_EXIT.refused, fill(refused.leftOut, { id: piece.id, cmd: this.host.cmd }));
    }
  }

  /** The piece moved from running to delivered in the registry, with what it left out and why, and its answer — false when it moved meanwhile. */
  private recordDelivery(table: DelegationTable, { piece, trial, reason, answer }: ContractDelivery): boolean {
    const leftOut = trial.leftOut.length > 0;
    return table.transition(piece.id, STATE.running, STATE.delivered, {
      left_out: trial.leftOut.join('; '),
      why: leftOut ? (reason ?? '').replace(/\s+/g, ' ') : '',
      ...(answer !== null ? { result: JSON.stringify(answer) } : {}),
    });
  }

  /** What the delivery says: the files it committed, what it left out and why, its answer. */
  private reportDelivery({ piece, trial, reason, answer }: ContractDelivery): void {
    const done = FORMULAS.apx.deliver.done;
    this.host.out(fill(done.delivered, { id: piece.id, files: trial.committed.length ? trial.committed.join(', ') : done.nothing }));
    if (trial.leftOut.length) this.host.out(fill(done.leftOut, { files: trial.leftOut.join(', '), why: reason ?? '' }));
    if (answer) this.host.out(fill(done.answer, { answer }));
  }

  /** The answer of a piece that ran on another harness, from the file its command wrote — null after saying why there is none. */
  private elsewhereAnswer(contracts: ContractContext, record: DelegationRecord): string | null {
    const files = this.elsewhereFiles(contracts, record.dlg);
    if (!existsSync(files.answer)) {
      this.host.lastCode = this.host.refuse(1, WORDS.elsewhere.noAnswer, { id: record.dlg, file: files.answer });
      return null;
    }
    return readFileSync(files.answer, 'utf-8').trim();
  }

  /** The files carried into the copy of a piece on another harness — its agent's definition — never delivered back. */
  private carriedOf(record: DelegationRecord): Set<string> {
    const invocation = record.harness ? this.host.doc.meta.harnesses?.[record.harness] : undefined;
    return new Set((invocation?.carry ?? []).map(pattern => pattern.replace(/\{agent\}/g, record.assignee)));
  }

  /** The files a delegation to another harness keeps beside its copy: the prompt it is handed, the answer it writes, the schema of an AS. */
  private elsewhereFiles(contracts: ContractContext, pieceId: string): { copy: string; prompt: string; answer: string; schema: string } {
    const copy = resolve(contracts.root, contracts.workspace().path(pieceId));
    return { copy, prompt: `${copy}.prompt.md`, answer: `${copy}.answer.txt`, schema: `${copy}.schema.json` };
  }

  /**
   * A delegation to another harness, started (D66): its copy is opened, the
   * files its harness needs and the copy may not hold are carried in, its
   * prompt is written — the task, what it reads, the form of its AS — and the
   * harness's recipe is printed, filled, with the rules to run it by. The
   * command is the caller's to run: nothing is launched here.
   */
  launch(record: DelegationRecord): number {
    const work = this.host.doc.meta.background?.[pieceOf(record.dlg).work];
    const invocation = work?.harness ? this.host.doc.meta.harnesses?.[work.harness] : undefined;
    if (!work?.harness || !invocation) return this.host.refuse(2, WORDS.elsewhere.noRecipe, { id: record.dlg, name: this.host.root.name });
    const agent = work.by ?? '';
    const contracts = this.context();
    if (!contracts) return this.host.lastCode;
    if (!this.landMerged(contracts)) return this.host.lastCode;
    const handed = this.handedValues(work.task);
    if ('empty' in handed) return this.host.refuse(1, WORDS.elsewhere.unfilled, { empty: emptyVariable(handed.empty), id: record.dlg });
    const shape = this.elsewhereShape(record.dlg);
    const prompt = [
      work.task,
      ...(handed.values.length ? ['', 'What you are handed:', '```json', JSON.stringify(Object.fromEntries(handed.values.map(entry => [entry.name, entry.value])), null, 2), '```'] : []),
      ...(shape ? ['', `Answer with JSON shaped as \`${refName(shape)}\`, like: ${JSON.stringify(jsonExample(this.host.doc.slotsOf(shape)!, this.host.doc.slotResolver()))}`] : []),
    ];
    const command = this.openElsewhere(contracts, record.dlg, invocation, agent, ['**'], prompt, shape);
    if (!contracts.table.transition(record.dlg, STATE.running, STATE.running, { harness: work.harness })) return this.host.refuse(4, WORDS.contract.changedDelegate, { id: record.dlg });
    this.host.out(`${record.dlg}  → ${agent} on ${work.harness}  copy: ${contracts.workspace().path(record.dlg)}`);
    this.host.say(WORDS.elsewhere.run);
    this.host.out(command);
    return this.elsewhereTail(invocation, agent, work.harness, { id: record.dlg });
  }

  /** What a task hands a piece on another harness: the constants and variables it reads, as this session holds them — or the first variable that is empty (D66). */
  private handedValues(task: string): { values: NamedValue[] } | { empty: string } {
    const names = [...new Set(readsOf(task).map(reference => reference.name))];
    const constants = names.flatMap(name => {
      const constant = constantOf(this.host.doc.mdSource?.vars, name);
      return constant === undefined ? [] : [{ name, value: constant }];
    });
    const variables = this.host.sessionVars();
    const read = variables ? this.host.readVariables(variables, names.filter(name => constantOf(this.host.doc.mdSource?.vars, name) === undefined)) : { values: [] };
    return 'empty' in read ? read : { values: [...constants, ...read.values] };
  }

  /** What follows the commands of pieces on another harness: the model, the recipe's rules, and how each one ends — `id` its id, or a placeholder when `many`. */
  private elsewhereTail(invocation: HarnessInvocation, agent: string, harness: string, end: { id: string; many?: boolean; flags?: string; then?: string }): number {
    if (invocation.model) {
      const model = this.modelOf(invocation, agent);
      if (model) this.host.say(WORDS.elsewhere.model, { model, agent, harness });
      else this.host.say(WORDS.elsewhere.modelDefault, { agent, harness });
    }
    for (const rule of invocation.rules) this.host.out(`# ${rule}`);
    return this.host.print(`# when ${end.many ? 'one' : 'it'} ends: ${this.host.cmd} delegate deliver ${end.id} --answer${end.flags ?? ''} — or: ${this.host.cmd} delegate block ${end.id} "<why>"${end.then ?? ''}`);
  }

  /** The model an agent runs on when its harness's CLI picks one — its BUDGET tier's there; null: the harness's own default. */
  private modelOf(invocation: HarnessInvocation, agent: string): string | null {
    return invocation.model ? invocation.models?.[agent] ?? null : null;
  }

  /**
   * A copy for a piece on another harness (D66), opened: the files its harness
   * needs carried in, its prompt written beside it — the CLI's intro, `task`,
   * then where it works — and the schema of its AS when the CLI binds one.
   * Returns the harness's command line, filled: the copy, the agent, the
   * prompt, the answer, the shape and the model its BUDGET tier maps to.
   */
  private openElsewhere(contracts: ContractContext, id: string, invocation: HarnessInvocation, agent: string, writes: string[], task: string[], shape: ApRef | null): string {
    contracts.workspace().open(id, { reads: null, writes });
    const files = this.elsewhereFiles(contracts, id);
    for (const path of invocation.carry.map(pattern => pattern.replace(/\{agent\}/g, agent))) {
      const from = join(contracts.root, path);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(files.copy, path)), { recursive: true });
      copyFileSync(from, join(files.copy, path));
    }
    const prompt = [
      ...(invocation.intro ? [invocation.intro.replace(/\{agent\}/g, agent), ''] : []),
      ...task,
      '', 'Work only in this folder: it is your own copy of the project. Your last message is your answer.',
    ].join('\n');
    writeFileSync(files.prompt, `${prompt}\n`);
    const slots = shape ? this.host.doc.slotsOf(shape) : null;
    if (shape && invocation.shape && slots) writeFileSync(files.schema, JSON.stringify(jsonSchemaOf(slots, this.host.doc.slotResolver()), null, 2));
    const flag = shape && invocation.shape && slots ? invocation.shape.replace(/\{schema\}/g, files.schema) : '';
    const model = this.modelOf(invocation, agent);
    const modelFlag = model ? invocation.model!.replace(/\{model\}/g, model) : '';
    return invocation.command.replace(/\{project\}/g, files.copy).replace(/\{agent\}/g, agent).replace(/\{prompt\}/g, files.prompt)
      .replace(/\{answer\}/g, files.answer).replace(/\{shape\}/g, flag).replace(/\{model\}/g, modelFlag).replace(/\s{2,}/g, ' ').trim();
  }

  /** The AS of a delegation to another harness, as a reference — null when it has none, or its template was not compiled in. */
  private elsewhereShape(pieceId: string): ApRef | null {
    const work = this.host.doc.meta.background?.[pieceOf(pieceId).work];
    if (!work) return null;
    for (const { node } of this.host.doc.nodes()) {
      if (node.type === NODE.directive && node.work === pieceOf(pieceId).work && node.as) return this.host.doc.slotsOf(node.as.ref) ? node.as.ref : null;
    }
    return null;
  }

  /**
   * A delegation to another harness, delivered (`delegate deliver <dlg-id>
   * --answer`): its answer, from the file its command wrote, is its result —
   * stored in its INTO; what its copy changed is kept only within its
   * perimeter (every glob list the registry recorded), the files carried in
   * never — anything else is left out, and said. A WAIT merges it.
   */
  deliverElsewhere(table: DelegationTable, record: DelegationRecord): number {
    const contracts = this.context();
    if (!contracts) return this.host.lastCode;
    const piece = new Piece(record);
    if (!piece.isRunning()) return this.host.refuse(1, WORDS.elsewhere.notRunning, { id: piece.id, state: piece.state });
    const text = this.elsewhereAnswer(contracts, record);
    if (text === null) return this.host.lastCode;
    if (record.into && pieceOf(record.dlg).run === null) {
      const block = this.host.variable(record.into);
      const failed = block ? this.host.storeVariable(block, text) : null;
      if (failed) return this.host.refuse(6, WORDS.elsewhere.deliversInto, { id: record.dlg, into: record.into, reason: failed.reason });
    }
    // What it changed: every file, then only those within its perimeter — a glob of each list it was handed under.
    const carried = this.carriedOf(record);
    const lists: string[][] = record.perimeter ? JSON.parse(record.perimeter) : [];
    const changed = contracts.workspace().deliver(record.dlg, { globs: ['**'], created: true }, { dryRun: true }).committed;
    const kept = changed.filter(file => !carried.has(file) && lists.every(globs => matchesAnyGlob(file, globs)));
    const leftOut = changed.filter(file => !kept.includes(file) && !carried.has(file));
    contracts.workspace().deliver(record.dlg, { globs: kept.map(literalGlob) });
    const outsidePerimeter = leftOut.length ? WORDS.elsewhere.outsidePerimeter : '';
    if (!table.transition(record.dlg, STATE.running, STATE.delivered, { result: JSON.stringify(text), left_out: leftOut.join('; '), why: outsidePerimeter })) {
      return this.host.refuse(1, WORDS.deliver.refused.moved, { id: record.dlg });
    }
    this.host.say(WORDS.deliver.done.delivered, { id: record.dlg, files: kept.length ? kept.join(', ') : WORDS.deliver.done.nothing });
    if (leftOut.length) this.host.say(WORDS.elsewhere.leftOut, { files: leftOut.join(', ') });
    return 0;
  }

  /** A contract's copy, from the project root — where whoever carries it out works. */
  copy(contractId: string): string | null {
    return this.context()?.workspace().path(contractId) ?? null;
  }

  /**
   * What a WAIT does with the contracts it took back: each delivered one merged
   * into the session's result, then what was merged lands in the working
   * folder. A conflict is named, and left to the lead (`contract merge`).
   */
  fold(table: DelegationTable, pieces: DelegationRecord[]): DelegationRecord[] {
    const contracts = this.context();
    if (!contracts) return pieces;
    const taken: DelegationRecord[] = [];
    let merged = 0;
    for (const record of pieces) {
      // A contract, or a delegation to another harness: both delivered from a copy of their own.
      if (record.state !== STATE.delivered || !(CONTRACT_ID_RE.test(record.dlg) || record.harness)) { taken.push(record); continue; }
      const outcome = contracts.workspace().merge(record.dlg);
      if (!outcome.merged) { this.host.say(WORDS.contract.foldConflict, { id: record.dlg, files: outcome.conflicts.join(', ') }); taken.push(record); continue; }
      table.transition(record.dlg, STATE.delivered, STATE.merged);
      merged++;
      taken.push({ ...record, state: STATE.merged });
    }
    if (merged > 0) {
      const landing = contracts.workspace().land();
      if ('conflicts' in landing) this.host.out(`# ${this.conflictsText(landing.conflicts, this.host.phrase(WORDS.landing.thenLandCommand))}`);
      else if (landing.landed.length) this.host.say(WORDS.landing.landedUncommitted, { files: landing.landed.join(', ') });
    }
    return taken;
  }

  /** `merge <ctr> [--prefer ours|theirs]` — a delivered contract that conflicted, merged with the side that wins. */
  private merge(contracts: ContractContext, args: string[]): number {
    const record = this.contractArg(contracts, args[0], 'merge <ctr-id> [--prefer ours|theirs]');
    if (!record) return this.host.lastCode;
    if (record.state !== STATE.delivered) return this.host.refuse(2, WORDS.contract.notDelivered, { id: record.dlg, state: record.state });
    const prefer = flagValue(args.slice(1), '--prefer');
    if (prefer !== undefined && prefer !== MERGE_SIDE.ours && prefer !== MERGE_SIDE.theirs) return this.host.refuse(2, WORDS.contract.preferTakes, { id: record.dlg });
    const outcome = contracts.workspace().merge(record.dlg, prefer);
    if (!outcome.merged) return this.host.refuse(3, WORDS.contract.mergeConflicts, { id: record.dlg, files: outcome.conflicts.join(', ') });
    if (!contracts.table.transition(record.dlg, STATE.delivered, STATE.merged)) return this.host.refuse(4, WORDS.contract.changedGet, { id: record.dlg });
    this.host.out(`${record.dlg}  merged`);
    if (record.left_out) this.host.say(WORDS.deliver.done.leftOut, { files: record.left_out, why: record.why });
    return this.host.print(`# then: ${this.host.cmd} contract land`);
  }

  /** `land` — what was merged, into the working folder, uncommitted. */
  private land(contracts: ContractContext): number {
    const landing = contracts.workspace().land();
    if ('conflicts' in landing) return this.host.fail(3, this.conflictsText(landing.conflicts, WORDS.landing.thenLand));
    return this.host.print(landing.landed.length ? this.host.phrase(WORDS.landing.landedUncommitted, { files: landing.landed.join(', ') }) : this.host.phrase(WORDS.landing.nothing));
  }
}
