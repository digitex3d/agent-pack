// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `delegate` service — work handed to someone else (D46):
 *
 *   - a contract (`exe-…`): an agent's own `DELEGATE … BY`, a `PROCEDURE*`, an
 *     `IF*` — what the delegate is handed, and its answer checked and kept:
 *     `<apx> delegate input <exe-id>`, `<apx> delegate answer <exe-id> - [--into <var>]`;
 *   - a flow's background piece (`dlg-…`, `DELEGATE~` / `FORK~`), in the
 *     session's registry (src/apx/delegations.ts): started by the lead,
 *     delivered or blocked by whoever carries it out, taken back by
 *     `<apx> wait` — at most its limit, each one's state at the end (D48, D52);
 *   - a contract (`ctr-…`) a MARK bound and a DELEGATE of its list started
 *     (`<apx> contract start`): the same life on the same registry — delivered
 *     from its copy, merged when a WAIT takes it back.
 *
 * A program's contract (`PROCEDURE**`, `COMPUTE`) is the engine's `run`.
 */
import { readFileSync } from 'node:fs';
import { FORMULAS, fill } from '../../formulas.js';
import { refName } from '../../../adapters/md/phrases.js';
import { jsonExample } from '../../shapeSchema.js';
import { sha256Hex } from '../../apdoc/ids.js';
import { parseDuration, DURATION_FORM } from '../../delegation.js';
import { DelegationTable, DELEGATION_ID_RE, CONTRACT_ID_RE, MARK_ID_RE, SETTLED_STATES, pieceRecord, pieceOf, runsOf, answerFlag, type DelegationRecord, type DelegationState } from '../delegations.js';
import { countOf, type ApxHost, type ApxService } from '../service.js';
import { errorMessage } from '../../errors.js';

/** The service's old name: what it says to whoever still calls it. */
export const OLD_DELEGATE_KIND = 'ask';

/** How long a wait waits when neither its WAIT nor the config says. */
export const DEFAULT_WAIT_MAX = '30m';

export const delegateService: ApxService = {
  kind: 'delegate',
  about: 'work handed to someone else: a contract and its answer; a background piece of a flow — start, deliver, block, take back',
  operations: [
    { op: 'input', args: '<exe-id>', about: 'what the delegate receives: the JSON of the variables and constants it reads, then the shape of its answer' },
    { op: 'answer', args: '<exe-id> - [--into <var>]', about: "store the delegate's answer (on stdin): checked against its contract, kept in its INTO variable" },
    { op: 'start', args: '<dlg-id>', about: 'record a background piece as running, before you hand it over' },
    { op: 'deliver', args: '<dlg-id> - | <dlg-id> --answer | <ctr-id> [--answer] [--why "<reason>"]', about: 'deliver a background piece (its result on stdin, kept in its INTO variable), one run on another harness (its answer file and its copy), or a contract (from its copy — with --answer, one run on another harness)' },
    { op: 'block', args: '<dlg-id | ctr-id> "<why>"', about: 'a piece that cannot be done as asked: blocked, with why' },
    { op: 'ended', args: '<dlg-id | ctr-id>', about: 'the agent of a piece stopped without delivering: the lead decides what next' },
    { op: 'take', args: '<dlg-id | ctr-id>', about: 'the lead carries a running or ended piece out itself' },
    { op: 'reassign', args: '<dlg-id | ctr-id> <agent>', about: 'hand a running or ended piece to another agent' },
    { op: 'list', args: '', about: 'every piece of this session — background pieces and contracts — with its state' },
  ],
  serve(host, op, args) {
    switch (op) {
      case 'input': return input(host, args);
      case 'answer': return answer(host, args);
      case 'start': case 'deliver': case 'block': case 'ended': case 'take': case 'reassign': case 'list':
        return withRegistry(host, `delegate ${op}`, table => REGISTRY_OPS[op](host, table, args));
    }
    return host.fail(2, `${op ? `'${op}' is no operation of delegate` : 'delegate takes an operation'} — ${host.cmd} delegate ${delegateService.operations.map(o => o.op).join('|')} …`);
  },
};

/**
 * `input <exe-id>` — what a delegate is handed: the JSON it receives, and
 * nothing else, then the shape its answer takes — `{"holds": …}` for a
 * condition, its template's example, or plain text.
 */
function input(host: ApxHost, args: string[]): number {
  const spec = host.executorArg('delegate input', args[0]);
  if (!spec) return host.lastCode;
  const json = host.inputJson(spec);
  if (!json) return host.lastCode;
  host.out(JSON.stringify(json, null, 1));
  const A = FORMULAS.keywords.EXECUTOR.answer;
  const shape = host.answerShape(spec);
  if (spec.output.holds) return host.print(A.holds);
  if (!shape) return host.print(A.text);
  const slots = host.doc.slotsOf(shape);
  host.out(fill(A.shaped, { name: refName(shape) }));
  return host.print(JSON.stringify(slots ? jsonExample(slots, host.doc.slotResolver()) : {}));
}

/** `answer <exe-id> -` — a delegate's answer, checked against its contract, stored and recorded. */
function answer(host: ApxHost, argv: string[]): number {
  const id = argv[0];
  const found = host.executorArg('delegate answer', id);
  const into = found && host.intoArg(found, id!, argv);
  if (!into) return host.lastCode;
  const { spec, args } = into;
  const from = args[1];
  if (spec.executor !== 1) return host.fail(1, `a program carries out ${id}, not a delegate: ${host.cmd} run ${id}`);
  const text = from === '-' || from === undefined ? readFileSync(0, 'utf-8') : args.slice(1).join(' ');
  const json = host.inputJson(spec);
  if (!json) return host.lastCode;
  const broken = host.deliver(id!, spec, text, 'answered', sha256Hex(JSON.stringify(json)));
  if (broken) return host.fail(6, `the delegate's answer breaks the contract of ${id}: ${broken} — hand it over again, with the same input; nothing was stored`);
  return host.delivered(id!, spec, text);
}

// ------------------------------------------------------------ the registry

/** Open the session's registry and run `then` on it — or say why it cannot be opened. */
function withRegistry(host: ApxHost, needs: string, then: (table: DelegationTable) => number | Promise<number>): number | Promise<number> {
  const session = host.sessionIdOrReason(`${needs} needs`);
  if ('reason' in session) return host.fail(2, `${session.reason} — nothing was read or written`);
  const table = DelegationTable.open(host.projectRoot, session.id);
  try {
    return then(table);
  } catch (e) {
    return host.fail(2, `the background work could not be read or written: ${errorMessage(e)}`);
  }
}

/** A piece's line: its id, what it fills, its state, who carries it out. */
function line(r: DelegationRecord): string {
  return `${r.dlg}  ${r.into || r.step}  ${r.state === 'ended' ? 'ended without delivery' : r.state}  → ${r.assignee || 'a fork'}${r.reason ? `  — ${r.reason}` : ''}`;
}

/**
 * A piece the flows of this agent start, by id — or null after saying why. A
 * delegation inside an EACH is started once per run, `<dlg-id>-<k>`: a run past
 * the EACH's MAX is the list running longer than its bound (D57).
 */
function known(host: ApxHost, id: string | undefined, usage: string): string | null {
  if (id && CONTRACT_ID_RE.test(id)) return id;
  if (!id || !DELEGATION_ID_RE.test(id)) { host.lastCode = host.fail(2, `a piece id is needed (dlg-… or ctr-…) — ${host.cmd} delegate ${usage}`); return null; }
  const { work: base, run } = pieceOf(id);
  const work = host.doc.meta.background?.[base];
  if (!work) { host.lastCode = host.fail(1, `no flow of ${host.root.name} starts ${base} — the ids are in its compiled flows`); return null; }
  if (work.each && run === null) { host.lastCode = host.fail(2, `${id} runs once per element of an EACH — name the run: ${host.cmd} delegate ${usage.split(' ')[0]} ${id}-<k>, <k> the run's number from 1`); return null; }
  if (!work.each && run !== null) { host.lastCode = host.fail(2, `${base} is in no EACH — it is one piece: ${host.cmd} delegate ${usage.split(' ')[0]} ${base}`); return null; }
  if (work.each && run! > work.each.max) {
    host.lastCode = host.fail(3, `${id}: the list runs longer than the EACH's MAX ${work.each.max} — an error: stop the flow and report it`);
    return null;
  }
  return id;
}

/** A recorded piece — or null after saying why. */
function recorded(host: ApxHost, table: DelegationTable, id: string | undefined, usage: string): DelegationRecord | null {
  if (!known(host, id, usage)) return null;
  const r = table.get(id!);
  if (!r) {
    host.lastCode = host.fail(1, CONTRACT_ID_RE.test(id!) ? `no contract ${id} in this session — ${host.cmd} contract list` : `${id} was never started in this session — ${host.cmd} delegate start ${id}`);
    return null;
  }
  return r;
}

/** Move a piece from one of `from` to `to` — false after saying why when it is in none of them, or moved meanwhile. */
function move(host: ApxHost, table: DelegationTable, r: DelegationRecord, from: readonly DelegationState[], to: DelegationState, fields: Partial<DelegationRecord> = {}): boolean {
  if (!from.includes(r.state)) {
    host.lastCode = host.fail(1, `${r.dlg} is ${r.state}, not ${from.join(' or ')} — ${host.cmd} delegate list`);
    return false;
  }
  if (!table.transition(r.dlg, r.state, to, fields)) {
    host.lastCode = host.fail(1, `${r.dlg} moved meanwhile — ${host.cmd} delegate list`);
    return false;
  }
  return true;
}

/** A background piece handed to someone else keeps its step's `@WITHIN` and takes its new assignee's own perimeter; a contract keeps its zones. */
function rebound(host: ApxHost, r: DelegationRecord, assignee: string): Partial<DelegationRecord> {
  if (CONTRACT_ID_RE.test(r.dlg)) return {};
  const work = host.doc.meta.background?.[pieceOf(r.dlg).work];
  return { perimeter: host.workPerimeter(work?.within ?? [], assignee) };
}

type RegistryOp = (host: ApxHost, table: DelegationTable, args: string[]) => number;

const REGISTRY_OPS: Record<string, RegistryOp> = {
  start(host, table, [id]) {
    if (id && CONTRACT_ID_RE.test(id)) return host.fail(2, `a contract starts with the rest of its list — ${host.cmd} contract start <mrk-id> --by <agent>`);
    if (!known(host, id, 'start <dlg-id>')) return host.lastCode;
    const work = host.doc.meta.background![pieceOf(id!).work];
    const fresh = pieceRecord({
      dlg: id!, flow: work.flow, step: work.step, into: work.into ?? '', assignee: work.by ?? '',
      state: 'running', started_at: new Date().toISOString(), author: host.root.name,
      perimeter: host.workPerimeter(work.within ?? [], work.by ?? ''),
    });
    const prior = table.get(id!);
    // A loop starts the same piece on every round: only a piece still running cannot start again.
    if (prior?.state === 'running') return host.fail(1, `${id} is still running — wait for it first: ${host.cmd} wait ${id}`);
    if (prior) table.set(id!, fresh);
    else table.add(fresh);
    // Another harness: its copy, its prompt and the command to launch it (D66) — the caller runs the command.
    if (work.harness) return host.contracts.launch(fresh);
    host.out(line(fresh));
    return host.print(`# when done it runs: ${host.cmd} delegate deliver ${id} -   — or: ${host.cmd} delegate block ${id} "<why>"`);
  },

  deliver(host, table, [id, from, ...rest]) {
    const r = recorded(host, table, id, 'deliver <dlg-id> -');
    if (!r) return host.lastCode;
    // A contract is delivered from its copy, not from stdin.
    if (CONTRACT_ID_RE.test(r.dlg)) return host.contracts.deliver(table, r, [from, ...rest].filter((a): a is string => a !== undefined));
    // Another harness: its answer is the file its command wrote, its changes are in its copy (D66).
    if (r.harness) {
      if (from !== '--answer') return host.fail(2, answerFlag(r, host.cmd));
      return host.contracts.deliverElsewhere(table, r);
    }
    if (r.state !== 'running') return host.fail(1, `${id} is ${r.state} — only a running piece is delivered`);
    const text = (from === '-' || from === undefined ? readFileSync(0, 'utf-8') : from).trim();
    // One run of an EACH keeps its result: the WAIT collects the runs' into the list its INTO names.
    if (r.into && pieceOf(r.dlg).run === null) {
      const block = host.variable(r.into);
      const failed = block ? host.storeVariable(block, text) : null;
      if (failed) return host.fail(6, `${id} delivers into \`${r.into}\`: ${failed.reason} — deliver it again; nothing was stored`);
    }
    if (!move(host, table, r, ['running'], 'delivered', { result: JSON.stringify(text) })) return host.lastCode;
    return host.print(line({ ...r, state: 'delivered' }));
  },

  block(host, table, [id, ...why]) {
    const r = recorded(host, table, id, 'block <dlg-id> "<why>"');
    if (!r) return host.lastCode;
    const reason = why.join(' ').trim();
    if (!reason) return host.fail(2, `say why ${id} cannot be done — ${host.cmd} delegate block ${id} "<why>"`);
    if (!move(host, table, r, ['running', 'ended'], 'blocked', { reason })) return host.lastCode;
    return host.print(line({ ...r, state: 'blocked', reason }));
  },

  ended(host, table, [id]) {
    const r = recorded(host, table, id, 'ended <dlg-id>');
    if (!r) return host.lastCode;
    if (!move(host, table, r, ['running'], 'ended')) return host.lastCode;
    host.out(line({ ...r, state: 'ended' }));
    return host.print(`# decide: ${host.cmd} delegate take ${id}, ${host.cmd} delegate reassign ${id} <agent>, or ${host.cmd} delegate block ${id} "<why>"`);
  },

  take(host, table, [id]) {
    const r = recorded(host, table, id, 'take <dlg-id>');
    if (!r) return host.lastCode;
    if (!move(host, table, r, ['running', 'ended'], 'running', { assignee: host.root.name, ...rebound(host, r, host.root.name) })) return host.lastCode;
    host.out(line({ ...r, state: 'running', assignee: host.root.name }));
    if (CONTRACT_ID_RE.test(r.dlg)) return host.print(`# it is yours: work in its copy, ${host.contracts.copy(r.dlg)}, then ${host.cmd} delegate deliver ${id}`);
    return host.print(`# it is yours: carry it out, then ${host.cmd} delegate deliver ${id} -`);
  },

  reassign(host, table, [id, agent]) {
    const r = recorded(host, table, id, 'reassign <dlg-id> <agent>');
    if (!r) return host.lastCode;
    if (!agent) return host.fail(2, `name who takes ${id} over — ${host.cmd} delegate reassign ${id} <agent>`);
    if (!move(host, table, r, ['running', 'ended'], 'running', { assignee: agent, ...rebound(host, r, agent) })) return host.lastCode;
    host.out(line({ ...r, state: 'running', assignee: agent }));
    return host.print(`# hand it to ${agent}: it ends with ${host.cmd} delegate deliver ${id} -   — or: ${host.cmd} delegate block ${id} "<why>"`);
  },

  list(host, table) {
    const all = table.all();
    for (const r of all) host.out(line(r));
    return host.print(`# ${countOf(all.length, 'background piece', 'background pieces')} in this session`);
  },
};

/**
 * `wait <dlg-id | var> … [--max <duration>] [--now]`, `wait all` — take back what was
 * started: it returns when every piece it names is delivered, blocked or ended
 * without delivery, or when the limit is reached — and leaves what is still
 * running as it is (D52). Then each one's state (D48): exit 0 when all were
 * delivered, 1 otherwise — the lead decides.
 */
export function waitFor(host: ApxHost, argv: string[], pollMs = 500): number | Promise<number> {
  const args = [...argv];
  // `--now`: no waiting — each one's state at once, its limit counted from when it started (a harness that is told when work ends, D60).
  const now = args.includes('--now');
  if (now) args.splice(args.indexOf('--now'), 1);
  const at = args.indexOf('--max');
  const max = at >= 0 ? args.splice(at, 2)[1] : host.build.waitMax ?? DEFAULT_WAIT_MAX;
  const ms = max ? parseDuration(max) : null;
  if (ms === null) return host.fail(2, `--max ${max ?? ''}: a duration is ${DURATION_FORM}`);
  const names = args.flatMap(a => a.split(',')).map(a => a.trim()).filter(Boolean);
  if (names.length === 0) return host.fail(2, `wait takes what to wait for — ${host.cmd} wait <dlg-id | mrk-id | var> … [--max <duration>] [--now] | ${host.cmd} wait all`);
  return withRegistry(host, 'wait', async table => {
    const pick = (): DelegationRecord[] | string => {
      const all = table.all();
      if (names.length === 1 && names[0] === 'all') return all.filter(r => r.state === 'running');
      const out: DelegationRecord[] = [];
      for (const name of names) {
        // A MARK's id: the contracts its latest DELEGATE started — none started: nothing to wait for.
        if (MARK_ID_RE.test(name)) { out.push(...table.batchOf(name)); continue; }
        const r = DELEGATION_ID_RE.test(name) ? all.find(x => x.dlg === name || pieceOf(x.dlg).work === name) : [...all].reverse().find(x => x.into === name);
        if (!r) return `${name} was never started in this session — ${DELEGATION_ID_RE.test(name) ? `${host.cmd} delegate start ${name}` : `no background piece fills \`${name}\``}`;
        // A delegation of an EACH: every run of it; a run named alone, that run.
        out.push(...(r.dlg === name ? [r] : runsOf(all, pieceOf(r.dlg).work)));
      }
      return out;
    };
    const first = pick();
    if (typeof first === 'string') return host.fail(1, first);
    const ids = [...new Set(first.map(r => r.dlg))];
    const deadline = now ? Date.now() : Date.now() + ms;
    let pieces = first;
    while (pieces.some(r => !SETTLED_STATES.includes(r.state)) && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      const all = table.all();
      pieces = ids.map(id => all.find(r => r.dlg === id)!);
    }
    // What the contracts delivered is merged and lands; then each one's state.
    pieces = host.contracts.fold(table, pieces);
    collectRuns(host, pieces);
    contractStates(host, table, pieces);
    // Past its limit: the time it has run, from its start — with --now; else the wait itself.
    const past = (r: DelegationRecord) => !now || Date.now() - Date.parse(r.started_at) >= ms;
    for (const r of pieces) {
      host.out(r.state !== 'running' ? line(r) : past(r) ? `${line(r)}  — still running after ${max}` : `${line(r)}  — running, within its ${max}`);
      if (r.state === 'delivered' && !r.into && r.result) host.out(`  result: ${JSON.parse(r.result)}`);
    }
    const open = pieces.filter(r => r.state !== 'delivered' && r.state !== 'merged');
    if (open.length === 0) return host.print(`# ${countOf(pieces.length, 'piece', 'pieces')} delivered — go on with each one's result`);
    // Still within their limit, and nothing else open: wait for the word of each one.
    if (open.every(r => r.state === 'running' && !past(r))) {
      host.out(`# ${countOf(open.length, 'piece', 'pieces')} still running, within the limit — wait for the word that each one ended, then look again`);
      host.lastCode = 1;
      return 1;
    }
    host.out(`# ${countOf(open.length, 'piece', 'pieces')} not delivered — you decide: wait again (${host.cmd} wait ${open.map(r => r.dlg).join(' ')}),`);
    host.out(`#   ${host.cmd} delegate take <dlg-id>, ${host.cmd} delegate reassign <dlg-id> <agent>, or ${host.cmd} delegate block <dlg-id> "<why>"`);
    host.lastCode = 1;
    return 1;
  });
}

/**
 * The runs of an EACH, taken back: once every run of a delegation is settled,
 * its INTO holds one result per run, in run order (D56) — a plain variable the
 * list as JSON, a run not delivered as its state; a variable typed with one
 * LIST slot that slot, only when every run delivered.
 */
function collectRuns(host: ApxHost, pieces: readonly DelegationRecord[]): void {
  const works = new Map<string, DelegationRecord[]>();
  for (const r of pieces) {
    const { work, run } = pieceOf(r.dlg);
    if (run !== null) works.set(work, [...(works.get(work) ?? []), r]);
  }
  for (const [work, runs] of works) {
    const into = host.doc.meta.background?.[work]?.into;
    if (!into || runs.some(r => !SETTLED_STATES.includes(r.state))) continue;
    const block = host.variable(into);
    if (!block) continue;
    const result = (r: DelegationRecord) => { try { return JSON.parse(JSON.parse(r.result)); } catch { return r.result ? JSON.parse(r.result) : ''; } };
    const list = runs.map(r => (r.state === 'delivered' ? result(r) : { state: r.state === 'ended' ? 'ended without delivery' : r.state, ...(r.reason ? { reason: r.reason } : {}) }));
    const slot = block.type ? (host.doc.slotsOf(block.type) ?? []).find(x => x.spec.kind === 'list') : undefined;
    if (block.type && runs.some(r => r.state !== 'delivered')) {
      host.out(`# \`${into}\` not stored: not every run of ${work} delivered, and its template takes only results`);
      continue;
    }
    const failed = host.storeVariable(block, JSON.stringify(slot ? { [slot.name]: list } : list));
    host.out(failed ? `# \`${into}\` not stored: ${failed.reason}` : `# \`${into}\` holds the ${countOf(runs.length, 'run', 'runs')} of ${work}, in order — read it: ${host.cmd} get ${into}`);
  }
}

/**
 * The contracts of a MARK, taken back: its list's variable holds each one's
 * state (D50) — what `{{<list>}}` reads after the WAIT: its id, its state, why
 * it was blocked. Before the WAIT it holds their ids.
 */
function contractStates(host: ApxHost, table: DelegationTable, pieces: readonly DelegationRecord[]): void {
  const marks = new Set(pieces.filter(r => CONTRACT_ID_RE.test(r.dlg) && r.mark).map(r => r.mark));
  for (const mark of marks) {
    const batch = table.batchOf(mark);
    const list = batch[0]?.into;
    const block = list ? host.variable(list) : null;
    if (!block) continue;
    const states = batch.map(r => ({ id: r.dlg, state: r.state === 'ended' ? 'ended without delivery' : r.state, ...(r.reason ? { reason: r.reason } : {}) }));
    const failed = host.storeVariable(block, JSON.stringify(states));
    if (failed) host.out(`# \`${list}\` not stored: ${failed.reason}`);
  }
}
