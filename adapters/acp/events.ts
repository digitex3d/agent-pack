// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The events of a chat (`agent-pack chat`): one JSONL file per chat, one
 * complete line per event, in the order they arrive — the boss's, written by
 * the chat, and each delegated harness's, written by the ACP client when the
 * file's path is in `AGENT_PACK_CHAT_EVENTS`. The chat's terminal is one
 * reader of it; any other tool may read it the same way.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { obj, str, type Params } from './rpc.js';
import { SESSION_UPDATE, SETTLED_STATUSES, TEXT_CONTENT, TOOL_KIND, TOOL_STATUS } from './protocol.js';
import { errorMessage } from '../../src/errors.js';
import { reportedModel, type Usage } from './usage.js';
import { HARNESS_SEP } from '../../src/delegation.js';
import { FORMULAS, fill } from '../../src/formulas.js';

/** The environment variable that holds the absolute path of the chat's events file. */
export const EVENTS_ENV = 'AGENT_PACK_CHAT_EVENTS';

/**
 * The environment variable that holds the name of the participant a process
 * of a chat runs for — the boss's source for the boss, the delegated
 * participant's for a delegation: what an apx run there writes its identity as.
 */
export const SOURCE_ENV = 'AGENT_PACK_CHAT_SOURCE';

/** Where a chat keeps its events file, from the project root. */
export const CHATS_DIR = '.agent-pack/chats';

/** The source of the boss's own events; a delegated harness's events carry its name. */
export const BOSS_SOURCE = 'boss';

/** What an event is. */
export const EVENT_KIND = {
  /** A piece of the agent's message, streamed. */
  text: 'text',
  /** A tool call, as it starts: its title, its id — and, as its status, its ACP kind (`read`, `edit`, …). */
  toolStart: 'tool-start',
  /** A tool call, once it settled: its title, its status, its id. */
  tool: 'tool',
  /** A permission decided: what it was for and why — status `allowed` or `refused`. */
  verdict: 'verdict',
  /** A line the user typed. */
  user: 'user',
  /** The end of a turn — status its stop reason. */
  turn: 'turn',
  /** Something the chat or the client says of the run itself. */
  notice: 'notice',
  /** A participant joined the chat's group — the first time it speaks; its source is its name. */
  join: 'join',
  /** A participant the user removed from the group (`/remove <name>`) — its source is its name. */
  leave: 'leave',
  /** The model a participant runs on, as it reports it — its text. */
  model: 'model',
  /** What a participant's turn cost, as it reports it — its text, a `Usage` as JSON. */
  usage: 'usage',
  /** An apx served who it is (`start`, `scope`) in a chat's process — its text the agent's name; status `main` for the main. */
  identity: 'identity',
} as const;
export type EventKind = typeof EVENT_KIND[keyof typeof EVENT_KIND];

/**
 * The name a participant of the chat goes by — its events' source: the
 * harness and the agent it runs (`codex-acp:reviewer`), or the harness alone
 * when no agent is named.
 */
export function participantOf(harness: string, agent: string | null): string {
  return agent ? `${harness}${HARNESS_SEP}${agent}` : harness;
}

/** The kind of the main — and the status of an identity event that names it: the boss as itself again. */
export const MAIN_IDENTITY = 'main';

/**
 * An apx served who it is inside a chat (the events file in the environment):
 * one `identity` event, under the source the environment names — unless that
 * source's last identity was this one already. Outside a chat, nothing.
 */
export function announceIdentity(name: string, kind: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = env[EVENTS_ENV];
  if (!file) return;
  const source = env[SOURCE_ENV] || BOSS_SOURCE;
  let last: ChatEvent | undefined;
  // A file that cannot be read has no identity yet: the writer below says why, if it cannot write either.
  try { last = new EventTail(file).read().filter(e => e.kind === EVENT_KIND.identity && e.source === source).pop(); } catch { last = undefined; }
  if (last?.text === name) return;
  eventSink(file, source, text => text, () => { /* an apx run is no chat: its identity is lost, its work goes on */ })(EVENT_KIND.identity, name, kind === MAIN_IDENTITY ? MAIN_IDENTITY : null);
}

/** The statuses of a verdict. */
export const VERDICT_STATUS = { allowed: 'allowed', refused: 'refused' } as const;

/** One event, as one line of the file holds it. */
export interface ChatEvent {
  time: string;
  source: string;
  kind: EventKind;
  text: string;
  status: string | null;
  /** The tool call's id, on a tool event — null on any other. */
  id: string | null;
}

/** A writer of one source's events — `null` when there is no file to write. */
export type EventSink = (kind: EventKind, text: string, status?: string | null, id?: string | null) => void;

/**
 * The writer of `source`'s events to `file`: each event one line, written at
 * once — no escape codes, and `mask` over the text (a server's env values).
 * A write that fails is handed to `failed`, once, and nothing more is written:
 * its writer decides whether to go on without the events.
 */
export function eventSink(file: string, source: string, mask: (text: string) => string, failed: (why: string) => void): EventSink {
  let broken = false;
  return (kind, text, status = null, id = null) => {
    if (broken) return;
    const event: ChatEvent = { time: new Date().toISOString(), source, kind, text: mask(stripVTControlCharacters(text)), status, id };
    try {
      appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch (e) {
      broken = true;
      failed(fill(FORMULAS.messages.acp.eventsUnwritable, { file, why: errorMessage(e) }));
    }
  };
}


/**
 * The events of a turn, out of the agent's `session/update` messages: its
 * message chunks as they come; per tool call, one event as it starts and one
 * when it settles (or at the end of the turn, with its last status) —
 * thoughts and plans left out.
 */
export class TurnEvents {
  private readonly tools = new Map<string, { title: string; status: string }>();
  private readonly started = new Set<string>();
  /** The session's spend the agent last reported, and the part of it already written. */
  private spent: { amount: number; currency: string } | null = null;
  private written = 0;
  /** The model last written. */
  private current: string | null = null;

  constructor(private readonly sink: EventSink) {}

  update(update: Params): void {
    switch (update.sessionUpdate) {
      case SESSION_UPDATE.agentMessageChunk: {
        const content = obj(update.content);
        if (content.type === TEXT_CONTENT && str(content.text)) this.sink(EVENT_KIND.text, str(content.text) ?? '');
        break;
      }
      case SESSION_UPDATE.toolCall:
      case SESSION_UPDATE.toolCallUpdate:
        this.tool(update);
        break;
      case SESSION_UPDATE.configOptions:
        this.model(reportedModel(update));
        break;
      case SESSION_UPDATE.usage:
        this.spend(obj(update.cost));
        break;
      default:
        break;
    }
  }

  /** The model the agent runs on, once known or changed — nothing when it reports none. */
  model(model: string | null): void {
    if (!model || model === this.current) return;
    this.current = model;
    this.sink(EVENT_KIND.model, model);
  }

  /** The turn ended: each tool call not settled yet written with its last status, what the turn cost when reported, then the end itself. */
  end(stopReason: string, usage: Usage | null = null): void {
    for (const [id, t] of this.tools) this.sink(EVENT_KIND.tool, t.title, t.status, id);
    this.tools.clear();
    this.started.clear();
    // The spend is the session's so far: the turn's is what grew since the last one written.
    const grown = this.spent && this.spent.amount > this.written ? { cost: this.spent.amount - this.written, currency: this.spent.currency } : null;
    if (this.spent) this.written = this.spent.amount;
    if (usage || grown) this.sink(EVENT_KIND.usage, JSON.stringify({ ...(usage ?? { input: 0, output: 0, total: 0 }), ...grown }));
    this.sink(EVENT_KIND.turn, '', stopReason);
  }

  /** A `usage_update`'s cost: the session's spend so far. */
  private spend(cost: Params): void {
    if (typeof cost.amount === 'number') this.spent = { amount: cost.amount, currency: str(cost.currency) ?? 'USD' };
  }

  /** A tool call's start, written the first time its id is seen. */
  private startOnce(id: string, title: string, update: Params): void {
    if (this.started.has(id)) return;
    this.started.add(id);
    this.sink(EVENT_KIND.toolStart, title, str(update.kind) ?? TOOL_KIND.other, id);
  }

  private tool(update: Params): void {
    const id = str(update.toolCallId) ?? '';
    const known = this.tools.get(id);
    const t = { title: str(update.title) ?? known?.title ?? 'a tool call', status: str(update.status) ?? known?.status ?? TOOL_STATUS.pending };
    this.startOnce(id, t.title, update);
    // Settled, a tool call is written, once.
    if (!SETTLED_STATUSES.has(t.status)) { this.tools.set(id, t); return; }
    this.tools.delete(id);
    this.sink(EVENT_KIND.tool, t.title, t.status, id);
  }
}

/** A reader of the events file from where it stopped: each call, the complete lines appended since. */
export class EventTail {
  private offset = 0;
  private partial = '';

  constructor(private readonly file: string) {}

  read(): ChatEvent[] {
    const size = statSync(this.file).size;
    if (size <= this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, 'r');
    try { readSync(fd, buffer, 0, buffer.length, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const lines = `${this.partial}${buffer.toString('utf-8')}`.split('\n');
    this.partial = lines.pop() ?? '';
    return lines.filter(Boolean).flatMap(line => {
      // A line that is no event is none of the chat's: skipped, not shown.
      try { return [JSON.parse(line) as ChatEvent]; } catch { return []; }
    });
  }
}
