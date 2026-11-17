// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `agent-pack chat` — a terminal that talks ACP to the boss harness, one
 * session, a turn per line typed; agent-pack orchestrates nothing: the boss
 * runs the flows as it always does. What the boss says and does, and what the
 * harnesses it delegates to say and do (the ACP client writes their events),
 * goes to one events file (./events.ts); a front shows it as it arrives
 * (./front.ts): full screen on a terminal (./tui.ts), else inline lines
 * (./inline.ts). A permission the boss asks for is asked there — allow once
 * or reject, never always — and the choice written as a verdict.
 *
 * Ctrl-C in a turn cancels it; at an empty prompt, or Ctrl-D, it quits: the
 * boss and everything it started are stopped.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AcpServer } from './index.js';
import { errorMessage } from '../../src/errors.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import { Connection, obj, str, type Params } from './rpc.js';
import { REJECT_KINDS, optionOf, outcomeOf, requestName } from './perimeter.js';
import { killGroup } from './terminals.js';
import { reportedModel } from './usage.js';
import { colorOn } from './ansi.js';
import { Host } from './host.js';
import { initialize, maskedError, maskerOf, openSession, prompt, spawnServer } from './server.js';
import { OPTION_KIND, SESSION_UPDATE, TURN_END } from './protocol.js';
import { BOSS_SOURCE, CHATS_DIR, EVENTS_ENV, SOURCE_ENV, EVENT_KIND, EventTail, TurnEvents, VERDICT_STATUS, eventSink, type ChatEvent, type EventSink } from './events.js';
import { Group, Personas } from './conversation.js';
import { Room } from './room.js';
import { Catalog, type CatalogEntry } from './catalog.js';
import { HARNESS_SEP } from '../../src/delegation.js';
import { ALLOW_ONCE, type Front } from './front.js';
import { InlineFront } from './inline.js';
import { TuiFront } from './tui.js';

const CHAT = FORMULAS.messages.chat;
/** What a word starts with when it cites a block of the project: `#<name>`. */
const CITE_MARK = '#';

/** How often the events file is read for what was appended, in milliseconds. */
const TAIL_EVERY_MS = 50;
/** The chat's exit codes. */
const CHAT_EXIT = { ok: 0, failed: 1 } as const;
/** The random bytes that make a chat's session id its own, beside its time. */
const SESSION_SUFFIX_BYTES = 3;

export interface ChatOptions {
  /** The project root: the boss's cwd, and its perimeter. */
  root: string;
  /** The boss's harness name, its server, and where its commands find the session id. */
  boss: string;
  server: AcpServer;
  sessionEnv: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** The other harnesses the boss may consult, and the command that runs `agent-pack` from its shell — told to it with its first prompt. */
  consult: { harnesses: string[]; agentPack: string };
  /** The agents of the project — what `/invite` offers with the harnesses. */
  agents: string[];
  /** One task handed to a participant of the room — `agent-pack ask`'s; `events` the chat's events file. */
  ask(target: string, task: string, events: string, signal: AbortSignal): Promise<string>;
}

/**
 * What the boss's first prompt opens with: the harnesses it may consult, and
 * how — `agent-pack ask`, so their work reaches the chat's log; never their
 * own CLI. Null when there is none to consult.
 */
function bossPreamble(consult: ChatOptions['consult']): string | null {
  if (consult.harnesses.length === 0) return null;
  return [
    `[agent-pack] Other agents can work for you in this project, each on its own harness: ${consult.harnesses.join(', ')}.`,
    `To consult one or hand it a task, run from your shell: ${consult.agentPack} ask <harness> "<task>" — its answer is printed on stdout.`,
    "Never run a harness's own CLI for this (codex, claude, opencode, …): only `ask` puts its work in this chat's log.",
    '',
    "The user's message:",
    '',
  ].join('\n');
}

/** One chat: its boss, its session, its events, its terminal. */
class Chat {
  private readonly file: string;
  private readonly sink: EventSink;
  private readonly tail: EventTail;
  private readonly front: Front;
  private readonly turnEvents: TurnEvents;
  private child: ChildProcess | null = null;
  private conn: Connection | null = null;
  private sessionId = '';
  private busy = false;
  /** The participants that joined, as the chat records them; and the writer of each one's joins and leaves. */
  private readonly group: Group;
  private readonly personas: Personas;
  private readonly room: Room;
  /** The project's blocks, read from its apx files — what the launcher offers and a `#<name>` cites. */
  private readonly catalog: Catalog;
  private readonly sinks = new Map<string, EventSink>();
  private ended = false;
  /** Lines typed while a turn runs, nothing being asked: each a turn of its own, in order, once the turn ends. */
  private readonly ahead: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private done: (code: number) => void = () => {};
  /** The boss's env values masked in whatever of its words is written. */
  private readonly mask: (text: string) => string;
  /** When the chat began, as file names take it: its events file's name, and its session id's. */
  private readonly stamp = new Date().toISOString().replace(/[:.]/g, '-');
  /** What the first prompt opens with — sent once, then null. */
  private preamble: string | null;
  /** The chat's own session id, and what the boss's environment holds over its entry's: the events file, that id. */
  private readonly chatSession = `chat-${this.stamp}-${randomBytes(SESSION_SUFFIX_BYTES).toString('hex')}`;
  private readonly extraEnv: Record<string, string>;

  constructor(private readonly o: ChatOptions) {
    this.preamble = bossPreamble(o.consult);
    this.personas = new Personas(o.boss);
    this.catalog = new Catalog(o.root);
    this.group = new Group(o.boss);
    this.room = new Room({
      boss: o.boss, group: this.group, invitable: { harnesses: o.consult.harnesses, agents: o.agents },
      ask: (target, task, signal) => o.ask(target, task, this.file, signal),
      notice: text => { this.sink(EVENT_KIND.notice, text); this.flush(); },
      // A join carries the pseudonym given, so the log keeps it.
      mark: (source, kind) => { this.sinkOf(source)(kind, kind === EVENT_KIND.join ? this.group.name(source, null) ?? '' : ''); this.flush(); },
      said: line => this.sink(EVENT_KIND.user, line),
      busy: () => this.busy, later: line => this.ahead.push(line), idle: () => this.front.busy(false),
      work: run => this.work(run), bossTurn: sent => this.bossTurn(sent, null),
    });
    mkdirSync(join(o.root, CHATS_DIR), { recursive: true });
    this.file = join(o.root, CHATS_DIR, `${this.stamp}.jsonl`);
    // The boss's commands write to the chat's events — an apx it reads, its identity — under the boss's source.
    this.extraEnv = { [EVENTS_ENV]: this.file, [SOURCE_ENV]: BOSS_SOURCE, [o.sessionEnv]: this.chatSession };
    this.mask = maskerOf(o.server, this.extraEnv);
    writeFileSync(this.file, '');
    this.sink = eventSink(this.file, BOSS_SOURCE, this.mask, why => this.lost(why));
    this.tail = new EventTail(this.file);
    this.turnEvents = new TurnEvents(this.sink);
    // A terminal on both sides: the full screen; anything else, inline lines.
    const tty = o.input.isTTY === true && o.output.isTTY === true;
    this.front = tty
      ? new TuiFront({
        boss: o.boss, stamp: this.stamp, input: o.input, output: o.output, color: colorOn(),
        catalog: () => this.catalog.entries(),
        invitable: o.consult.harnesses.flatMap(harness => [harness, ...o.agents.map(agent => `${harness}${HARNESS_SEP}${agent}`)]),
      })
      : new InlineFront({ boss: o.boss, input: o.input, output: o.output, tty });
  }

  async run(): Promise<number> {
    const mask = this.mask;
    const { child, lastWords } = spawnServer(this.o.server, this.o.root, mask, this.extraEnv);
    this.child = child;
    const host = new Host({
      harness: this.o.boss, root: this.o.root, terminal: this.o.server.terminal,
      report: line => this.sink(EVENT_KIND.notice, line), permission: p => this.ask(p),
    });
    this.conn = new Connection(child, host.onRequest, (method, params) => { if (method === SESSION_UPDATE.method) this.turnEvents.update(obj(params.update)); });
    const ended = new Promise<number>(resolve => { this.done = resolve; });
    child.on('exit', code => { this.sink(EVENT_KIND.notice, fill(CHAT.bossExited, { code: String(code), lastWords: lastWords() })); this.quit(CHAT_EXIT.failed); });
    this.timer = setInterval(() => this.flush(), TAIL_EVERY_MS);
    try {
      const methods = await initialize(this.conn, this.o.server.terminal);
      const { sessionId, opened } = await openSession(this.conn, { harness: this.o.boss, cwd: this.o.root, methods, mask });
      this.sessionId = sessionId;
      this.turnEvents.model(reportedModel(opened));
    } catch (e) {
      this.sink(EVENT_KIND.notice, fill(CHAT.cannotStart, { why: errorMessage(maskedError(e, mask)) }));
      this.quit(CHAT_EXIT.failed);
      return ended;
    }
    this.front.start(`chat with ${this.o.boss} — events: ${this.file}`, {
      line: text => this.onLine(text), interrupt: () => this.interrupt(), quit: () => this.quit(CHAT_EXIT.ok),
      run: entry => this.runFlow(entry), show: entry => this.showBlock(entry),
    });
    return ended;
  }

  /** The events appended since the last read, rendered. */
  private flush(): void {
    for (const e of this.tail.read()) { this.track(e); this.front.show(e); }
  }

  /** The group, as the events say it: a participant speaking for the first time — or again, once removed — joins, and the log says so. */
  private track(e: ChatEvent): void {
    if (e.kind === EVENT_KIND.identity) { this.personas.identity(e); return; }
    if (e.kind === EVENT_KIND.leave) { this.group.leave(e.source); return; }
    const source = this.personas.sourceOf(e);
    if (!Group.counts(source) || !this.group.join(source) || e.kind === EVENT_KIND.join) return;
    // The join carries the pseudonym given — from the model it reports first, when that is what it says — so the log keeps it.
    this.sinkOf(source)(EVENT_KIND.join, this.group.name(source, e.kind === EVENT_KIND.model ? e.text : null) ?? '');
  }

  /** The writer of a participant's events — the chat writes its joins and its leaves. */
  private sinkOf(source: string): EventSink {
    let sink = this.sinks.get(source);
    if (!sink) { sink = eventSink(this.file, source, this.mask, why => this.lost(why)); this.sinks.set(source, sink); }
    return sink;
  }

  private onLine(line: string): void {
    if (this.room.command(line)) return;
    if (this.busy) { this.ahead.push(line); return; }
    if (line.trim() === '') { this.front.busy(false); return; }
    this.work(() => this.bossTurn(line, line));
  }

  /** Work that keeps the chat busy until it settles — a boss turn, the room's sends; then the next line kept, or the prompt. */
  private work(run: () => Promise<void>): void {
    this.busy = true;
    this.front.busy(true);
    void run().finally(() => {
      this.busy = false;
      this.flush();
      const next = this.ahead.shift();
      if (next === undefined) this.front.busy(false);
      else this.onLine(next);
    });
  }

  /** The launcher's run: one boss turn asking it to run the flow through its apx — the log keeps the action as the user's line. */
  private runFlow(entry: CatalogEntry): void {
    const L = FORMULAS.messages.launcher;
    const prompted = fill(L.runPrompt, { name: entry.name, of: entry.unit ? fill(L.of, { unit: entry.unit }) : '', command: this.catalog.command(entry, 'flow') });
    if (this.busy) return;
    this.work(() => this.bossTurn(prompted, fill(L.runLine, { name: entry.name })));
  }

  /** The launcher's show: the block's text, in the chat only — no boss turn. */
  private showBlock(entry: CatalogEntry): void {
    let text: string;
    try { text = this.catalog.text(entry); } catch (e) { text = errorMessage(e); }
    this.sink(EVENT_KIND.notice, text.trimEnd());
    this.flush();
  }

  /** What a message tells the boss of each block it cites (`#<name>`): its id, and the command that reads it. */
  private citations(sent: string): string {
    const L = FORMULAS.messages.launcher;
    const named = new Set(sent.split(/\s+/).filter(word => word.startsWith(CITE_MARK)).map(word => word.slice(CITE_MARK.length)));
    const cited = named.size ? this.catalog.entries().filter(entry => named.has(entry.name)) : [];
    return cited.length ? `\n\n${cited.map(entry => fill(L.citeRef, { name: entry.name, kind: entry.kind, id: entry.id, command: this.catalog.command(entry, 'get') })).join('\n')}` : '';
  }

  /** A boss turn: `sent` the prompt, `shown` the line the log keeps of the user's — none for one the chat writes (a recap). */
  private async bossTurn(sent: string, shown: string | null): Promise<void> {
    // The log holds the line the user typed; that the preamble went with it is a notice of its own.
    if (shown !== null) this.sink(EVENT_KIND.user, shown);
    const prompted = `${this.preamble ?? ''}${sent}${this.citations(sent)}`;
    if (this.preamble) this.sink(EVENT_KIND.notice, fill(CHAT.preambleSent, { harnesses: this.o.consult.harnesses.join(', ') }));
    this.preamble = null;
    try {
      const ended = this.conn ? await prompt(this.conn, this.sessionId, prompted) : null;
      this.turnEvents.end(ended?.stopReason ?? TURN_END.none, ended?.usage ?? null);
    } catch (e) {
      this.sink(EVENT_KIND.notice, fill(CHAT.turnFailed, { why: errorMessage(maskedError(e, this.mask)) }));
      this.turnEvents.end(TURN_END.error);
    }
  }

  /** A permission the boss asks for, asked here: allow once, or reject — never always. */
  private async ask(params: Params): Promise<Params> {
    const what = requestName(params);
    this.flush();
    const answer = await this.front.ask(what, str(obj(params.toolCall).toolCallId));
    // Cancelled while asked: the request is answered cancelled, as ACP asks.
    if (answer === null) return outcomeOf(null);
    const once = ALLOW_ONCE.has(answer) ? optionOf(params.options, [OPTION_KIND.allowOnce]) : null;
    this.sink(EVENT_KIND.verdict, `${what}: ${once ? 'you allowed it once' : 'you rejected it'}`, once ? VERDICT_STATUS.allowed : VERDICT_STATUS.refused);
    return outcomeOf(once ?? optionOf(params.options, REJECT_KINDS));
  }

  /** Ctrl-C: a turn running is cancelled; at an empty prompt, the chat ends; a line typed is cleared. */
  private interrupt(): void {
    if (this.busy) {
      this.front.cancelAsk();
      this.room.abort();
      this.conn?.notify('session/cancel', { sessionId: this.sessionId });
      return;
    }
    if (this.front.clearOrEmpty()) this.quit(CHAT_EXIT.ok);
  }

  /** The events file cannot be written: the terminal shows what it holds, so the chat cannot go on — it stops, saying why. */
  private lost(why: string): void {
    process.stderr.write(fill(CHAT.eventsLost, { why }));
    this.quit(CHAT_EXIT.failed);
  }

  /** The end: what is left of the events rendered, the boss and everything it started stopped. */
  private quit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.child?.removeAllListeners('exit');
    this.flush();
    if (this.child) killGroup(this.child);
    this.front.stop();
    this.done(code);
  }
}

/** A chat with the boss, until it ends — its exit code. */
export function runChat(o: ChatOptions): Promise<number> {
  return new Chat(o).run();
}
