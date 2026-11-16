// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat screen, as a frame: its rows top to bottom — a header and a rule,
 * the conversation (its own lines, stuck to the bottom unless scrolled; a
 * "jump to latest" strip when it is), the input box behind a bar in the
 * boss's accent (or, in its place, the permission the boss asks for), and a
 * status line — with where the cursor goes. Pure: state in, rows out.
 */
import type { Entry } from './conversation.js';
import type { InputState } from './input.js';
import { BAR, COLOR, paint } from './ansi.js';
import { conversationLines } from './lines.js';
import { besidePanel, panelOf, ruleOf } from './panel.js';
import { menuRows, type MenuState } from './menu.js';
import { launcherRows, type LauncherData, type LauncherState } from './launcher.js';
import { clockOf, cost, tokens } from './figures.js';
import { addUsage, type Usage } from './usage.js';
import { chop, fit, graphemes, textWidth } from './width.js';
import { FORMULAS } from '../../src/formulas.js';

export interface ViewState {
  width: number;
  height: number;
  color: boolean;
  boss: string;
  stamp: string;
  entries: readonly Entry[];
  /** How many lines the conversation is scrolled up from its latest. */
  scroll: number;
  spinner: number;
  busy: boolean;
  input: InputState;
  /** What the boss asks permission for — the box asks it in place of the input; null when nothing is asked. */
  asking: string | null;
  /** The tool call that permission is for. */
  waiting: string | null;
  /** The participants that joined, in the order they did — the list on the right shows them, with what each reports. */
  members: readonly string[];
  models?: ReadonlyMap<string, string>;
  usage?: ReadonlyMap<string, Usage>;
  pseudonyms?: ReadonlyMap<string, string>;
  /** The completion menu open over the conversation's last rows — none, closed. */
  menu?: MenuState | null;
  /** The launcher open over the whole conversation — none, closed. */
  launcher?: { state: LauncherState; data: LauncherData } | null;
  /** How long the turn has run, and the chat — in milliseconds; absent, not shown. */
  elapsed?: number;
  total?: number;
}

/** The status line: who, idle or working (and for how long), the chat's time, what it cost as reported, the keys. */
function statusOf(s: ViewState): string {
  const used = [...(s.usage?.values() ?? [])].reduce<Usage | undefined>((sum, more) => addUsage(sum, more), undefined);
  return [
    s.boss,
    s.busy ? ['working', ...(s.elapsed !== undefined ? [clockOf(s.elapsed)] : [])].join(' ') : 'idle',
    ...(s.total !== undefined ? [clockOf(s.total)] : []),
    ...(used ? [`${tokens(used.total)} tok`, ...(used.cost !== undefined ? [cost(used.cost, used.currency)] : [])] : []),
    'ctrl-c stop', 'ctrl-d quit',
  ].join(' · ');
}

export interface Frame {
  rows: string[];
  cursor: { row: number; col: number } | null;
  /** How far the conversation can scroll, and one page of it. */
  scrollMax: number;
  page: number;
}

/** Under this width, the sides are padded by one column, else by two. */
const NARROW = 44;
const PAD_NARROW = 1;
const PAD = 2;
/** The input box grows with its text up to this many rows. */
const BOX_MAX_ROWS = 6;
const HEADER_ROWS = 2;
/** The rows below the conversation besides the box: the gap above it, the status line under it. */
const FOOTER_ROWS = 2;

/** Where a column of a line falls among its pieces: past a piece's end, at the start of the next one. */
function cursorIn(pieces: string[], col: number, first: number): { row: number; col: number } {
  let left = col;
  let at = 0;
  while (at < pieces.length - 1 && left >= graphemes(pieces[at]).length) { left -= graphemes(pieces[at]).length; at++; }
  return { row: first + at, col: textWidth(graphemes(pieces[at]).slice(0, left).join('')) };
}

/** The input's rows, each logical line cut to the box's width — and the row and column of the cursor among them. */
function inputRows(input: InputState, width: number): { rows: string[]; cursor: { row: number; col: number } } {
  const rows: string[] = [];
  let cursor = { row: 0, col: 0 };
  input.lines.forEach((line, k) => {
    const pieces = chop(line, width);
    if (k === input.row) {
      cursor = cursorIn(pieces, input.col, rows.length);
    }
    rows.push(...pieces);
  });
  return { rows, cursor };
}

/** The box: the input (a window of it around the cursor), or the permission asked. */
function box(s: ViewState, width: number): { rows: string[]; cursor: { row: number; col: number } | null } {
  const bar = (style: { fg: string }) => paint(BAR.heavy, style, s.color);
  if (s.asking !== null) {
    const ask = chop(`${s.boss} asks to ${s.asking}`, width - BAR.width)[0];
    return { rows: [bar({ fg: COLOR.warn }) + paint(ask, { fg: COLOR.warn }, s.color), `${bar({ fg: COLOR.warn })}[o] allow once  [r] reject`], cursor: null };
  }
  const { rows, cursor } = inputRows(s.input, width - BAR.width);
  const top = Math.max(0, Math.min(cursor.row - BOX_MAX_ROWS + 1, rows.length - BOX_MAX_ROWS));
  return { rows: rows.slice(top, top + BOX_MAX_ROWS).map(r => bar({ fg: COLOR.boss }) + r), cursor: { row: cursor.row - top, col: cursor.col + BAR.width } };
}

/** The frame of the screen at its size. */
export function frameOf(s: ViewState): Frame {
  const pad = s.width < NARROW ? PAD_NARROW : PAD;
  // Padded on both sides.
  const inner = Math.max(1, s.width - pad - pad);
  const side = ' '.repeat(pad);
  const panel = panelOf(s);
  // The conversation's room: the line less its sides — and, with the list, less the list, its bar and a space before it.
  const room = panel ? Math.max(1, s.width - pad - 1 - 1 - panel.width) : inner;
  const header = [paint(fit(` agent-pack · boss ${s.boss} · chat ${s.stamp}`, s.width), { bold: true }, s.color), ruleOf(s.width, panel, s.color)];
  const footer = box(s, inner);
  const status = paint(fit(statusOf(s), inner), { fg: COLOR.muted }, s.color);
  const area = Math.max(0, s.height - HEADER_ROWS - FOOTER_ROWS - footer.rows.length);
  const lines = conversationLines(s.entries, { width: room, color: s.color, spinner: s.spinner, waiting: s.waiting, boss: s.boss, pseudonyms: s.pseudonyms });
  const scrollMax = Math.max(0, lines.length - area);
  const scroll = Math.min(s.scroll, scrollMax);
  const shown = scroll > 0 ? area - 1 : area;
  const end = lines.length - scroll;
  const visible = lines.slice(Math.max(0, end - shown), end);
  const strip = scroll > 0 ? [paint(fit(FORMULAS.messages.chat.jumpToLatest, room), { fg: COLOR.muted }, s.color)] : [];
  const sided = (r: string) => (r === '' ? '' : side + r);
  const lines_ = [...visible, ...Array<string>(Math.max(0, shown - visible.length)).fill(''), ...strip];
  // The launcher, over the whole conversation: the box and the status line stay.
  const rows_ = s.launcher ? launcherRows(s.launcher.state, s.launcher.data, { width: room, height: lines_.length }, s.color) : lines_;
  // The menu, over the conversation's last rows: it pops up above the box, and moves nothing.
  const menu = s.menu ? menuRows(s.menu, room, s.color).slice(-rows_.length) : [];
  const conversation = [...rows_.slice(0, rows_.length - menu.length), ...menu].map(sided);
  const beside = panel ? besidePanel(conversation, panel, s.width, s.color) : conversation;
  const rows = [...header, ...beside, ...['', ...footer.rows, status].map(sided)].slice(0, s.height);
  const cursor = footer.cursor && { row: HEADER_ROWS + area + 1 + footer.cursor.row, col: pad + footer.cursor.col };
  return { rows, cursor, scrollMax, page: Math.max(1, shown) };
}
