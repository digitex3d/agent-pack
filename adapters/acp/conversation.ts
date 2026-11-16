// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat screen's conversation, out of the events as they are read: the
 * user's messages, each source's text — the pieces streamed into one entry —
 * its tool calls (started, then settled, by id), its verdicts and notices.
 * Pure: the screen draws it, at whatever width.
 */
import { BOSS_SOURCE, EVENT_KIND, MAIN_IDENTITY, VERDICT_STATUS, type ChatEvent, type EventKind } from './events.js';
import { STOP_REASON, TOOL_KIND, TOOL_STATUS, TURN_END } from './protocol.js';
import { addUsage, usageOf, type Usage } from './usage.js';
import { pseudonymOf } from './pseudonyms.js';
import { HARNESS_SEP } from '../../src/delegation.js';

/** What an entry is. */
export const ENTRY_KIND = { user: 'user', text: 'text', tool: 'tool', verdict: 'verdict', notice: 'notice', turn: 'turn', join: 'join', leave: 'leave' } as const;
type K = typeof ENTRY_KIND;

export type Entry = (
  | { kind: K['user']; text: string }
  | { kind: K['text']; source: string; text: string; model?: string }
  /** A tool call: `running` from its start until its settled event — the end of a turn settles it too, with its last status. */
  | { kind: K['tool']; source: string; id: string; title: string; toolKind: string; status: string; running: boolean; ms?: number; model?: string }
  | { kind: K['verdict']; source: string; allowed: boolean; text: string; model?: string }
  | { kind: K['notice']; source: string; text: string }
  /** The boss's turn that ended otherwise than by its end: cancelled, refused, failed. */
  | { kind: K['turn']; source: string; status: string }
  /** A participant that joined the group, or that the user removed from it. */
  | { kind: K['join']; source: string; model?: string }
  | { kind: K['leave']; source: string })
  /** When it began: the time of its first event. */
  & { time: string };

/**
 * The chat's group: the participants besides the boss and the user (members
 * from the start), in the order they joined. One joins the first time it
 * speaks, and again after the user removed it.
 */
export class Group {
  readonly members: string[] = [];
  /** What each participant reports — the boss's under its source: the model it runs on, and what its turns cost. */
  readonly models = new Map<string, string>();
  readonly usage = new Map<string, Usage>();
  /** Each participant's pseudonym, given when it first joined and kept — the boss's own agents keep their real names. */
  readonly pseudonyms = new Map<string, string>();

  /** `boss`: the boss's name — the agents it becomes (`<boss>:<agent>`) are the boss, under their real names. */
  constructor(private readonly boss: string = BOSS_SOURCE) {}

  /** A participant's pseudonym, given on first sight from the model known then, or the one a log recorded — none for the boss's own. */
  name(id: string, model: string | null, recorded: string | null = null): string | null {
    if (id.startsWith(`${this.boss}${HARNESS_SEP}`)) return null;
    const given = recorded || this.pseudonyms.get(id) || pseudonymOf({ id, model }, new Set(this.pseudonyms.values()));
    this.pseudonyms.set(id, given);
    return given;
  }

  /** Who is in the room for `@all`: the participants that joined — not the boss, nor any agent the boss became. */
  room(): string[] {
    return this.members.filter(name => !name.startsWith(`${this.boss}${HARNESS_SEP}`));
  }

  /** The participant a name stands for: its id, given its pseudonym or itself. */
  idOf(name: string): string {
    return [...this.pseudonyms].find(([, pseudonym]) => pseudonym === name)?.[0] ?? name;
  }

  /** Whether an event's source is one to count: a delegated participant's, not the boss's. */
  static counts(source: string): boolean {
    return source !== BOSS_SOURCE;
  }

  /** In: true when it was not a member. */
  join(name: string): boolean {
    if (this.members.includes(name)) return false;
    this.members.push(name);
    return true;
  }

  /** Out: true when it was a member. */
  leave(name: string): boolean {
    const at = this.members.indexOf(name);
    if (at < 0) return false;
    this.members.splice(at, 1);
    return true;
  }
}

/** What a participant says as the agent it became: its text, its tool calls, its verdicts — not its turns, its model, its usage. */
const SPOKEN: ReadonlySet<string> = new Set([EVENT_KIND.text, EVENT_KIND.toolStart, EVENT_KIND.tool, EVENT_KIND.verdict]);

/**
 * Who a source speaks as: after an `identity` event — an apx it read served
 * who it is — the boss's lines are `<boss>:<agent>`'s, a harness's
 * `<harness>:<agent>`'s, until another identity; the main is the boss itself.
 * Known limit: native subagents running in parallel share one session, so the
 * lines follow the last identity read, whoever read it.
 */
export class Personas {
  private readonly active = new Map<string, string>();

  constructor(private readonly boss: string) {}

  /** An identity event read: the participant its source now speaks as — null when it is itself again. */
  identity(e: ChatEvent): string | null {
    const harness = e.source === BOSS_SOURCE ? this.boss : e.source.split(HARNESS_SEP)[0];
    const persona = `${harness}${HARNESS_SEP}${e.text}`;
    if (e.status === MAIN_IDENTITY || persona === e.source) { this.active.delete(e.source); return null; }
    this.active.set(e.source, persona);
    return persona;
  }

  /** Who an event is from: the participant its source speaks as, for what it says; its source, for anything else. */
  sourceOf(e: ChatEvent): string {
    return SPOKEN.has(e.kind) ? this.active.get(e.source) ?? e.source : e.source;
  }

  /** The participant a source speaks as now — null when itself. */
  personaOf(source: string): string | null {
    return this.active.get(source) ?? null;
  }
}

export class Conversation {
  readonly entries: Entry[] = [];
  readonly group: Group;
  private readonly personas: Personas;

  /** `boss`: the boss's name, what the agents it becomes are named after. */
  constructor(boss: string = BOSS_SOURCE) {
    this.personas = new Personas(boss);
    this.group = new Group(boss);
  }

  private readonly apply_: Partial<Record<EventKind, (e: ChatEvent) => void>> = {
    [EVENT_KIND.user]: e => this.entries.push({ kind: ENTRY_KIND.user, text: e.text , time: e.time }),
    [EVENT_KIND.text]: e => this.text(e),
    [EVENT_KIND.toolStart]: e => this.entries.push({ ...this.modelOf(e.source), kind: ENTRY_KIND.tool, source: e.source, id: e.id ?? '', title: e.text, toolKind: e.status ?? TOOL_KIND.other, status: TOOL_STATUS.pending, running: true , time: e.time }),
    [EVENT_KIND.tool]: e => this.settle(e),
    [EVENT_KIND.verdict]: e => this.entries.push({ ...this.modelOf(e.source), kind: ENTRY_KIND.verdict, source: e.source, allowed: e.status === VERDICT_STATUS.allowed, text: e.text , time: e.time }),
    [EVENT_KIND.notice]: e => this.entries.push({ kind: ENTRY_KIND.notice, source: e.source, text: e.text , time: e.time }),
    [EVENT_KIND.model]: e => this.model(e),
    [EVENT_KIND.usage]: e => { const used = usageOf(e.text); if (used) this.group.usage.set(e.source, addUsage(this.group.usage.get(e.source), used)); },
    [EVENT_KIND.turn]: e => {
      if (e.source === BOSS_SOURCE && e.status !== STOP_REASON.endTurn) this.entries.push({ kind: ENTRY_KIND.turn, source: e.source, status: e.status ?? TURN_END.none , time: e.time });
    },
  };

  apply(event: ChatEvent): void {
    if (event.kind === EVENT_KIND.identity) { this.become(event); return; }
    const e = { ...event, source: this.personas.sourceOf(event) };
    // A participant that speaks for the first time — or again after it was removed — joins, before what it says.
    if (e.kind === EVENT_KIND.leave) { if (this.group.leave(e.source)) this.entries.push({ kind: ENTRY_KIND.leave, source: e.source, time: e.time }); return; }
    this.arrive(e);
    this.apply_[e.kind]?.(e);
  }

  /** A participant seen: on first sight — or again after it was removed — it joins, with its pseudonym, before what it says. */
  private arrive(e: ChatEvent): void {
    const recorded = e.kind === EVENT_KIND.join && e.text ? e.text : null;
    if (Group.counts(e.source) && this.group.join(e.source)) {
      // Its pseudonym: the one its join event recorded, else one given now — from the model it reports first, when that is what it says.
      this.group.name(e.source, e.kind === EVENT_KIND.model ? e.text : this.group.models.get(e.source) ?? null, recorded);
      this.entries.push({ kind: ENTRY_KIND.join, source: e.source, time: e.time, ...this.modelOf(e.source) });
    }
    if (recorded) this.group.name(e.source, null, recorded);
  }

  /** An identity read: what the source says next is the agent's — on the source's model. */
  private become(e: ChatEvent): void {
    const persona = this.personas.identity(e);
    const model = this.group.models.get(e.source);
    if (persona && model) this.group.models.set(persona, model);
  }

  /** The model a participant reports, kept; its latest join line that has none takes it — it may come right after the join. */
  private model(e: ChatEvent): void {
    this.group.models.set(e.source, e.text);
    // The agent it became runs on its model too.
    const persona = this.personas.personaOf(e.source);
    if (persona) this.group.models.set(persona, e.text);
    const joined = [...this.entries].reverse().find((x): x is Extract<Entry, { kind: K['join'] }> => x.kind === ENTRY_KIND.join && x.source === e.source);
    if (joined && joined.model === undefined) joined.model = e.text;
  }

  private modelOf(source: string): { model?: string } {
    const model = this.group.models.get(source);
    return model ? { model } : {};
  }

  /** A piece of text: added to its source's text when that is the last entry, else a new one. */
  private text(e: ChatEvent): void {
    const last = this.entries[this.entries.length - 1];
    if (last?.kind === ENTRY_KIND.text && last.source === e.source) last.text += e.text;
    else this.entries.push({ ...this.modelOf(e.source), kind: ENTRY_KIND.text, source: e.source, text: e.text, time: e.time });
  }

  /** A tool call settled: its running entry, by id, takes its status — or a new entry when it never started. */
  private settle(e: ChatEvent): void {
    // The latest running one: an agent may use an id again in a later turn.
    const pending = [...this.entries].reverse().find((x): x is Extract<Entry, { kind: K['tool'] }> => x.kind === ENTRY_KIND.tool && x.running && x.source === e.source && x.id === e.id);
    if (pending) {
      Object.assign(pending, { status: e.status ?? pending.status, title: e.text || pending.title, running: false });
      // How long it ran: from its start's time to its end's.
      const ms = Date.parse(e.time) - Date.parse(pending.time);
      if (Number.isFinite(ms)) pending.ms = ms;
      return;
    }
    this.entries.push({ kind: ENTRY_KIND.tool, source: e.source, id: e.id ?? '', title: e.text, toolKind: TOOL_KIND.other, status: e.status ?? TOOL_STATUS.completed, running: false , time: e.time });
  }
}
