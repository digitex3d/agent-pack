// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat's room — its group of participants — and the commands that act on
 * it, handled by the chat itself, never sent to the boss as typed:
 *
 *   /invite [<harness>[:<agent>]]  someone in, without making it speak — alone, who can be invited
 *   /remove <name>                 someone off the list (it may still be called, and joins again)
 *   @<participant> <message>       the message to that one participant, as `agent-pack ask` runs it
 *   @all <message>                 to every participant of the room at once — then the boss writes a recap
 *
 * Any other line goes to the boss as it is.
 */
import type { Group } from './conversation.js';
import { EVENT_KIND } from './events.js';
import { YOU } from './lines.js';
import { targetOf } from './ask.js';
import { errorMessage } from '../../src/errors.js';
import { FORMULAS, fill } from '../../src/formulas.js';

const SAY = FORMULAS.messages.chat;
/** A command line: its word, and what follows it. */
const COMMAND_RE = /^(?<word>\/\S+)(?:\s+(?<rest>[\s\S]*))?$/;
const MENTION_RE = /^@(?<name>\S+)\s+(?<message>\S[\s\S]*)$/;
/** The mention that reaches the whole room. */
export const ALL = 'all';

/**
 * The chat's commands — the one table the dispatcher runs and the input's
 * menu lists: each one's word, what it takes, what it does, and how it runs.
 */
export const COMMANDS: readonly { word: string; args: string; about: string; run: (room: Room, rest: string) => void }[] = [
  { word: '/invite', args: '[name]', about: SAY.aboutInvite, run: (room, rest) => room.invite(rest) },
  { word: '/remove', args: '<name>', about: SAY.aboutRemove, run: (room, rest) => room.remove(rest) },
];

/** What the room needs of its chat. */
export interface RoomHost {
  boss: string;
  group: Group;
  /** What `/invite` offers: the harnesses besides the boss, and the agents of the project. */
  invitable: { harnesses: string[]; agents: string[] };
  /** One task handed to a participant — `agent-pack ask`'s, its events in the chat's. */
  ask(target: string, task: string, signal: AbortSignal): Promise<string>;
  notice(text: string): void;
  /** A participant's join or leave, written under its name. */
  mark(source: string, kind: typeof EVENT_KIND.join | typeof EVENT_KIND.leave): void;
  /** The line the user typed, logged. */
  said(line: string): void;
  busy(): boolean;
  /** A line kept for when the work running ends. */
  later(line: string): void;
  /** Work that keeps the chat busy until it settles: Ctrl-C reaches it. */
  work(run: () => Promise<void>): void;
  /** A boss turn: `sent` the prompt — the log keeps no line of the user's for it. */
  bossTurn(sent: string): Promise<void>;
  /** The prompt is back, when nothing runs. */
  idle(): void;
}

export class Room {
  private aborts: AbortController | null = null;

  constructor(private readonly h: RoomHost) {}

  /** A line, when it is one of the room's commands: handled — true; else false, for the boss. */
  command(line: string): boolean {
    const text = line.trim();
    const typed = COMMAND_RE.exec(text)?.groups;
    const command = typed ? COMMANDS.find(c => c.word === typed.word) : undefined;
    if (command) { command.run(this, (typed?.rest ?? '').trim()); return true; }
    const mention = MENTION_RE.exec(text)?.groups;
    if (!mention) return false;
    if (this.h.busy()) this.h.later(line);
    else this.mention(this.h.group.idOf(mention.name), mention.message, text);
    return true;
  }

  /** Ctrl-C: every send running, stopped — and the recap with them. */
  abort(): void {
    this.aborts?.abort();
  }

  /** `/remove <name>` — a participant named by its id or its pseudonym. */
  remove(named: string): void {
    const name = this.h.group.idOf(named);
    if (!name) this.h.notice(SAY.removeUsage);
    else if (name === this.h.boss || name === YOU) this.h.notice(fill(SAY.removeFixed, { name }));
    else if (!this.h.group.members.includes(name)) this.h.notice(fill(SAY.removeUnknown, { name, names: this.h.group.members.join(', ') || '—' }));
    else this.h.mark(name, EVENT_KIND.leave);
    if (!this.h.busy()) this.h.idle();
  }

  invite(name: string): void {
    const { harnesses, agents } = this.h.invitable;
    const listed = { harnesses: harnesses.join(', ') || '—', agents: agents.join(', ') || '—' };
    const { harness, agent } = targetOf(name);
    if (!name) this.h.notice(fill(SAY.inviteList, listed));
    else if (!harnesses.includes(harness) || (agent !== null && !agents.includes(agent))) this.h.notice(fill(SAY.inviteUnknown, { name, ...listed }));
    else if (this.h.group.members.includes(name)) this.h.notice(fill(SAY.inviteAlready, { name }));
    else this.h.mark(name, EVENT_KIND.join);
    if (!this.h.busy()) this.h.idle();
  }

  private mention(name: string, message: string, line: string): void {
    const room = this.h.group.room();
    if (name === ALL && room.length === 0) { this.h.notice(SAY.emptyRoom); this.h.idle(); return; }
    if (name !== ALL && !this.h.group.members.includes(name)) { this.h.notice(fill(SAY.notInRoom, { name, names: room.join(', ') || '—' })); this.h.idle(); return; }
    this.h.said(line);
    this.h.work(() => this.send(name === ALL ? room : [name], message, name === ALL));
  }

  /** The message to each one, all at once; their answers come as their events do — then, for the room, one recap by the boss. */
  private async send(names: string[], message: string, recap: boolean): Promise<void> {
    const aborts = new AbortController();
    this.aborts = aborts;
    // Each one settled: its answer, or why it has none.
    const settled = await Promise.all(names.map(name => this.h.ask(name, message, aborts.signal).then(
      answer => ({ name, answer, why: null }),
      (failure: unknown) => ({ name, answer: null, why: errorMessage(failure) }),
    )));
    this.aborts = null;
    for (const { name, why } of settled) if (why !== null) this.h.notice(fill(SAY.sendFailed, { name, why }));
    if (!recap || aborts.signal.aborted) return;
    const answers = settled.map(({ name, answer, why }) => (answer !== null ? fill(SAY.recapAnswer, { name, answer: answer.trim() }) : fill(SAY.recapFailed, { name, why: why ?? '' })));
    this.h.notice(SAY.recapSent);
    await this.h.bossTurn(fill(SAY.recapPrompt, { message, answers: answers.join('\n\n') }));
  }
}
