// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The dashboard: after a command's answer, the blocks the agent is likeliest
 * to forget for the action it is about to take — it reminds, it never checks.
 *
 * score = pertinence × weight, the weight compiled into the document
 * (src/dashboard.ts). The pertinence is the affinity of the envelope's `next`,
 * or of its goal and context together times `contextWeight`, whichever is
 * higher. The score is a first filter only: every block a word of the text
 * lights is a candidate, and the agent decides, on the name and ABOUT it
 * reads, which ones to open. A block shown `d` calls ago, `d` under `recall`,
 * keeps 1 − 1/(d + 1) of its score. Each kind keeps its best up to its own
 * `max`; the lists merge by score, cut at `maxEntries`, and print grouped by
 * band, the highest first. The numbers stay
 * inside: the agent reads sentences, never a score. The dashboard stores
 * nothing: how long ago a block was shown is the session's to say.
 */
import { FORMULAS, fill } from '../formulas.js';
import { isRecord } from '../guards.js';
import { openIndex, type AffinityIndex } from '../affinity/index.js';
import type { ApBlock } from '../apdoc/block.js';
import type { DashboardConfig } from '../config.js';
import type { ApDashboard, ApReminder } from '../dashboard.js';
import type { ReceivedEnvelope } from './call.js';

const WORDS = FORMULAS.apx.dashboard;

/** The bands, the highest first — each opens with its own sentence. */
const BANDS = ['high', 'medium', 'low'] as const;
type Band = typeof BANDS[number];

/** The envelope's fields the dashboard reads. */
const FIELD = { next: 'next', goal: 'goal', context: 'context' } as const;

/** What the dashboard reads of an envelope: the action about to be taken — null when it names none — and the work around it. */
export interface CallText {
  next: string | null;
  work: string;
}

/** A reminder as the dashboard prints it: its title line and the full command that reads it. */
export interface Remindable extends ApReminder {
  title: string;
  command: string;
}

/** The affinity of a text to each reminder, by key — a reminder it does not light is absent. */
export type Affinity = (text: string) => ReadonlyMap<string, number>;

/** How many calls ago a reminder was shown — null when it was not, lately. */
export type ShownAgo = (key: string) => number | null;

/** What a call shows: the lines to print after the answer, and the keys of the blocks they show — none when nothing is pertinent. */
export interface Reminded {
  lines: string[];
  shown: string[];
}

/** One reminder at this call, and its score. */
interface Scored {
  reminder: Remindable;
  score: number;
}

/** The envelope's words the dashboard reads — null without an envelope, or with one that is no JSON object. */
export function callTextOf(envelope: ReceivedEnvelope | null): CallText | null {
  if (!envelope || envelope.problem !== null || !isRecord(envelope.call)) return null;
  const call = envelope.call;
  const field = (name: string): string | null => {
    const value = call[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  return { next: field(FIELD.next), work: [field(FIELD.goal), field(FIELD.context)].filter(Boolean).join('\n') };
}

/** How a trigger is named wherever the apx shows it: `When <condition>`. */
export function triggerTitle(condition: string): string {
  return fill(WORDS.trigger, { head: FORMULAS.keywords.WHEN.head, condition });
}

/** The affinity of a text to each reminder, from the compiled index. */
function affinityOf(index: AffinityIndex): Affinity {
  const affinity = openIndex(index);
  return text => new Map(affinity.match(text).map(found => [found.key, found.score]));
}

/** The scored reminders, the highest first; equal scores keep their order. */
function byScore(scored: readonly Scored[]): Scored[] {
  return [...scored].sort((first, second) => second.score - first.score);
}

export class Dashboard {
  constructor(private readonly settings: DashboardConfig, private readonly reminders: readonly Remindable[], readonly affinity: Affinity) {}

  /**
   * A document's dashboard: each compiled reminder with its title — a rule's
   * name and ABOUT, a trigger's condition — and the command that reads its
   * block — a trigger's, the `get` of that trigger alone — run as `command`.
   * Left out: a reminder whose block the document lacks, and one the call's
   * own answer printed — by its key, or its block printed whole (`printed`).
   */
  static of(compiled: ApDashboard, blockOf: (id: string) => ApBlock | undefined, command: string, printed: ReadonlySet<string>): Dashboard {
    const reminders = compiled.reminders.flatMap(reminder => {
      const block = blockOf(reminder.block);
      if (!block || printed.has(reminder.key) || printed.has(reminder.block)) return [];
      if (reminder.when === undefined) return [{ ...reminder, title: block.described(block.name, ' '), command: block.opening(command) }];
      return [{ ...reminder, title: triggerTitle(reminder.when), command: fill(WORDS.triggerCommand, { command, key: reminder.key }) }];
    });
    return new Dashboard(compiled.settings, reminders, affinityOf(compiled.index));
  }

  /** What this call shows, after its answer. */
  show(call: CallText, shownAgo: ShownAgo): Reminded {
    const kept = this.kept(this.scored(call, shownAgo));
    if (kept.length === 0) return { lines: [], shown: [] };
    return { lines: this.printed(call, kept), shown: kept.map(({ reminder }) => reminder.key) };
  }

  /** Each reminder's score at this call: pertinence × weight, less the penalty of a showing lately. */
  private scored(call: CallText, shownAgo: ShownAgo): Scored[] {
    const next = call.next === null ? new Map<string, number>() : this.affinity(call.next);
    const work = this.affinity(call.work);
    return this.reminders.map(reminder => {
      const pertinence = Math.max(next.get(reminder.key) ?? 0, (work.get(reminder.key) ?? 0) * this.settings.contextWeight);
      return { reminder, score: pertinence * reminder.weight * this.shareKept(shownAgo(reminder.key)) };
    });
  }

  /** What a block shown `ago` calls ago keeps of its score: 1 − 1/(ago + 1) under `recall`, all of it after, or never shown. */
  private shareKept(ago: number | null): number {
    return ago === null || ago >= this.settings.recall ? 1 : 1 - 1 / (ago + 1);
  }

  /** Each kind's best, up to its own `max`, merged by score and cut at `maxEntries` — a score of zero is never kept. */
  private kept(scored: readonly Scored[]): Scored[] {
    const lit = scored.filter(entry => entry.score > 0);
    const best = Object.entries(this.settings.kinds).flatMap(([kind, limit]) => byScore(lit.filter(entry => entry.reminder.kind === kind)).slice(0, limit.max));
    return byScore(best).slice(0, this.settings.maxEntries);
  }

  /** The band a score falls in: the highest whose start it reaches. */
  private bandOf(score: number): Band {
    if (score >= this.settings.bands.high) return 'high';
    return score >= this.settings.bands.medium ? 'medium' : 'low';
  }

  /** The dashboard as it is printed: the separator, the opening from the agent's own words, then each band with its sentence and its blocks. */
  private printed(call: CallText, kept: readonly Scored[]): string[] {
    const lines = [WORDS.separator, call.next === null ? WORDS.current : fill(WORDS.next, { next: call.next })];
    const bands = BANDS.map(band => ({ band, entries: kept.filter(entry => this.bandOf(entry.score) === band) })).filter(({ entries }) => entries.length > 0);
    bands.forEach(({ band, entries }, position) => {
      const sentence = sentenceOf(band, entries.length);
      lines.push(...(position > 0 ? fill(WORDS.laterBand, { sentence: capitalized(sentence) }) : sentence).split('\n'));
      for (const { reminder } of entries) lines.push(...fill(WORDS.entry, { title: reminder.title, command: reminder.command }).split('\n'));
    });
    return lines;
  }
}

/** A sentence that opens a later band: no longer the opening's continuation, it starts with a capital. */
function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The sentence a band opens with — the high band's in the form for one block or for several. */
function sentenceOf(band: Band, count: number): string {
  const sentence = WORDS.bands[band];
  if (typeof sentence === 'string') return sentence;
  return count === 1 ? sentence.one : sentence.many;
}
