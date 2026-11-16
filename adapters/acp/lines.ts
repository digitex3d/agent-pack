// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The conversation as the screen's lines, in the WeeChat/irssi layout: each
 * line its time, then its sender's name right-aligned in a column as wide as
 * the longest name, then ` │ `, then its text — wrapped under the text
 * column; the lines after the first of one sender's run leave the time and
 * the name blank. The user is `you`, the boss and each delegated harness their own
 * name, each in its accent; notices and turn endings are dim `--` lines. A
 * tool call is one line: its icon, its title, a spinner while it runs, ✓ or ✗
 * once settled. Narrow, the time goes first, then the name column shrinks.
 * Pure: entries in, painted lines out.
 */
import { ENTRY_KIND, type Entry } from './conversation.js';
import { BOSS_SOURCE } from './events.js';
import { TOOL_KIND, TOOL_STATUS } from './protocol.js';
import { COLOR, accentOf, paint, type Style } from './ansi.js';
import { chop, fit, textWidth, wrap } from './width.js';
import { duration, withModel } from './figures.js';
import { FORMULAS, fill } from '../../src/formulas.js';

export interface LineCtx {
  width: number;
  color: boolean;
  /** The spinner's frame, for the tool calls still running. */
  spinner: number;
  /** The tool call a permission is asked for — shown in the warning colour. */
  waiting: string | null;
  /** The boss's name, as its lines show it. */
  boss: string;
  /** Each participant's pseudonym — its lines show it instead of its id. */
  pseudonyms?: ReadonlyMap<string, string>;
}

/** One line of an entry before it is wrapped: its text and look, and a mark at its end (a tool call's ✓, ✗ or spinner). */
interface Item { text: string; style: Style; mark?: string }
/** An entry as lines: who said it, in what look, when. */
interface Said { nick: string; nickStyle: Style; time: string; items: Item[]; model?: string }

const CHAT = FORMULAS.messages.chat;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const ICONS: Record<string, string> = {
  [TOOL_KIND.read]: '→', [TOOL_KIND.edit]: '←', [TOOL_KIND.delete]: '←', [TOOL_KIND.move]: '←', [TOOL_KIND.search]: '✱', [TOOL_KIND.fetch]: '%',
};
/** The name the user's lines carry, and the markers of the notices', the joins' and the leaves' — WeeChat's `--`, `-->`, `<--`. */
export const YOU = 'you';
const NOTICE = '--';
const JOINED = '-->';
const LEFT = '<--';
/** The markers that stand in the name column for no one: a line of theirs never continues a run. */
const MARKERS: ReadonlySet<string> = new Set([NOTICE, JOINED, LEFT]);
/** The name column: as wide as the longest name, up to this — and, on a narrow screen, up to the narrow cap. */
const NICK_MAX = 16;
const NICK_NARROW_MAX = 8;
/** Under these widths the time is left out, and the name column shrinks. */
const NO_TIME_UNDER = 50;
const NARROW_NICK_UNDER = 30;
const SEPARATOR = ' │ ';
/** What leads the user's own text when there is no colour to raise it. */
const OWN_MARK = '▌ ';
const TIME_DIGITS = 2;
const TIME_WIDTH = 6;

/** An ISO time as the local hour and minute — blank when it is none. */
function clock(time: string): string {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return '     ';
  return [at.getHours(), at.getMinutes()].map(n => String(n).padStart(TIME_DIGITS, '0')).join(':');
}

type ToolEntry = Extract<Entry, { kind: typeof ENTRY_KIND.tool }>;

/** A tool call's mark: ✓ or ✗ once settled, the spinner while it runs, – when its turn ended first. */
function toolMark(e: ToolEntry, ctx: LineCtx): string {
  if (e.status === TOOL_STATUS.completed) return '✓';
  if (e.status === TOOL_STATUS.failed) return '✗';
  return e.running ? SPINNER[ctx.spinner % SPINNER.length] : '–';
}

function toolItem(e: ToolEntry, ctx: LineCtx): Item {
  const mark = toolMark(e, ctx);
  const style: Style = e.status === TOOL_STATUS.failed ? { fg: COLOR.red } : ctx.waiting === e.id && e.running ? { fg: COLOR.warn } : e.running ? {} : { fg: COLOR.muted };
  // How long it ran, once settled — after its mark, tersely.
  const took = !e.running && e.ms !== undefined ? ` ${duration(e.ms)}` : '';
  return { text: `${ICONS[e.toolKind] ?? '⚙'} ${e.title}`, style, mark: `${mark}${took}` };
}

/** A line of no one's — a notice, a turn's end, a join, a leave: its marker in the name column, and its text. */
/** A participant as its join line names it: its pseudonym, its id and model after it — or its id and model alone. */
function joinedName(id: string, model: string | undefined, pseudonym: string | undefined): string {
  return pseudonym ? `${pseudonym} (${[id, ...(model ? [model] : [])].join(', ')})` : withModel(id, model);
}

function markedLine(e: Entry, ctx: LineCtx): { marker: string; text: string } | null {
  switch (e.kind) {
    case ENTRY_KIND.notice: return { marker: NOTICE, text: e.text };
    case ENTRY_KIND.turn: return { marker: NOTICE, text: `turn ${e.status}` };
    case ENTRY_KIND.join: return { marker: JOINED, text: fill(CHAT.joined, { name: joinedName(e.source, e.model, ctx.pseudonyms?.get(e.source)) }) };
    case ENTRY_KIND.leave: return { marker: LEFT, text: fill(CHAT.removed, { name: e.source }) };
    default: return null;
  }
}

/** The name a source's lines carry: the boss's own, a participant's pseudonym, else its id. */
function nickOf(source: string, ctx: LineCtx): string {
  if (source === BOSS_SOURCE) return ctx.boss;
  return ctx.pseudonyms?.get(source) ?? source;
}

/** The model an entry was said with — none when unknown. */
function modelIn(e: Entry): { model?: string } {
  return 'model' in e && e.model ? { model: e.model } : {};
}

/** An entry's sender and its lines, not wrapped yet. */
function said(e: Entry, ctx: LineCtx): Said {
  const time = clock(e.time);
  const lines = (text: string, style: Style = {}) => text.replace(/\n+$/, '').split('\n').map(line => ({ text: line, style }));
  const marked = markedLine(e, ctx);
  if (marked) return { nick: marked.marker, nickStyle: { fg: COLOR.muted }, time, items: lines(marked.text, { fg: COLOR.muted }) };
  if (e.kind === ENTRY_KIND.user) return { nick: YOU, nickStyle: { fg: COLOR.user, bold: true }, time, items: lines(e.text) };
  const boss = e.source === BOSS_SOURCE;
  const nick = nickOf(e.source, ctx);
  // The model in effect when it said it: shown under its name, on its run's second row.
  const from = { nick, nickStyle: { fg: accentOf(e.source, boss), bold: true }, time, ...modelIn(e) };
  if (e.kind === ENTRY_KIND.tool) return { ...from, items: [toolItem(e, ctx)] };
  if (e.kind === ENTRY_KIND.verdict) return { ...from, items: lines(`${e.allowed ? '✓ allowed' : '✗ refused'}: ${e.text}`, { fg: e.allowed ? COLOR.muted : COLOR.red }) };
  // Every other kind is a marked line, above: what is left is text.
  return { ...from, items: e.kind === ENTRY_KIND.text ? lines(e.text) : [] };
}

/**
 * Whether an entry goes on the run of the one before it, as WeeChat's hidden
 * `prefix_same_nick`: the same sender — never a notice, never a new turn of
 * the user's. Scrolled into the middle of a run, the name is not shown again.
 */
function continues(before: Said | undefined, s: Said): boolean {
  return before !== undefined && before.nick === s.nick && !MARKERS.has(s.nick) && s.nick !== YOU;
}

/**
 * Whether a blank row goes before an entry: it starts a run of a sender
 * other than the last one who spoke — never before the first, never inside a
 * run, never around a `--`, `-->` or `<--` line.
 */
function separates(all: readonly Said[], at: number): boolean {
  const s = all[at];
  if (MARKERS.has(s.nick) || continues(all[at - 1], s)) return false;
  const last = all.slice(0, at).reverse().find(before => !MARKERS.has(before.nick));
  return last !== undefined && last.nick !== s.nick;
}

/** A name fitted to the column: cut with `…` when longer, padded on the left when shorter. */
function nickCell(nick: string, width: number): string {
  const cut = textWidth(nick) > width ? `${chop(nick, width - 1)[0]}…` : nick;
  return `${' '.repeat(Math.max(0, width - textWidth(cut)))}${cut}`;
}

/** The conversation's lines, at the context's width. */
export function conversationLines(entries: readonly Entry[], ctx: LineCtx): string[] {
  const all = entries.map(e => said(e, ctx));
  const cap = ctx.width < NARROW_NICK_UNDER ? NICK_NARROW_MAX : NICK_MAX;
  const nickWidth = Math.min(cap, Math.max(...[...MARKERS].map(m => m.length), ...all.map(s => textWidth(s.nick))));
  const timeWidth = ctx.width < NO_TIME_UNDER ? 0 : TIME_WIDTH;
  const layout = { timeWidth, nickWidth, text: Math.max(1, ctx.width - timeWidth - nickWidth - SEPARATOR.length) };
  const out: string[] = [];
  for (let at = 0; at < all.length; at++) {
    // A blank row between two senders' runs — a whole row, no time, no name, no │.
    if (separates(all, at)) out.push('');
    // One run, one name: its first row shows the time and the name, its second the model, the rest leave both blank.
    const run = [all[at]];
    while (at + 1 < all.length && continues(all[at], all[at + 1])) run.push(all[++at]);
    out.push(...runRows(run, layout, ctx));
  }
  return out;
}

/** One sender's run, as rows: the lead of each — the head, the model, then blank — the separator, the text. */
function runRows(run: Said[], layout: { timeWidth: number; nickWidth: number; text: number }, ctx: LineCtx): string[] {
  const first = run[0];
  // The user's own rows stand out: raised across the whole width, the text bright — without colour, behind a `▌`.
  const own = first.nick === YOU;
  const raise: Style = own ? { bg: COLOR.raised } : {};
  const mark = own && !ctx.color ? OWN_MARK : '';
  const rule = paint(SEPARATOR, { fg: COLOR.muted, ...raise }, ctx.color);
  const time = layout.timeWidth ? paint(`${first.time} `, { dim: true, ...raise }, ctx.color) : '';
  const blank = ' '.repeat(layout.timeWidth);
  const leads = [
    `${time}${paint(nickCell(first.nick, layout.nickWidth), { ...first.nickStyle, ...raise }, ctx.color)}`,
    ...(first.model && !own && !MARKERS.has(first.nick) ? [`${blank}${paint(nickCell(first.model, layout.nickWidth), { dim: true }, ctx.color)}`] : []),
  ];
  const texts = run.flatMap(s => s.items.flatMap(item => {
    const room = layout.text - mark.length;
    const pieces = item.mark ? [`${chop(item.text, room - textWidth(item.mark) - 1)[0]} ${item.mark}`] : wrap(item.text, room);
    return pieces.map(piece => paint(own ? fit(`${mark}${piece}`, layout.text) : piece, { ...item.style, ...(own ? { ...raise, bold: true } : {}) }, ctx.color));
  }));
  // A run of one row still shows the model: a row of its own, the text column empty.
  while (texts.length < leads.length) texts.push('');
  const hanging = paint(' '.repeat(layout.timeWidth + layout.nickWidth), raise, ctx.color);
  return texts.map((text, k) => `${leads[k] ?? hanging}${rule}${text}`);
}
