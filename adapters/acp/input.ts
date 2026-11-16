// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat screen's input box, as state and keys: a multi-line text and its
 * cursor, the lines sent before. Enter sends; Alt-Enter and Ctrl-J break the
 * line; a bracketed paste never sends; up and down recall the history only
 * from the first row. Pure: a key and a state in, a state and what to do out.
 */
import { graphemes } from './width.js';

export interface InputState {
  lines: string[];
  row: number;
  /** The cursor's column, in graphemes. */
  col: number;
  history: readonly string[];
  /** Which line of the history is shown — null: the one being written. */
  recall: number | null;
  /** The text being written, kept while the history is shown. */
  draft: string[] | null;
  /** Inside a bracketed paste: a line break breaks the line, never sends. */
  pasting: boolean;
}

/** A key, as `readline.emitKeypressEvents` reads it. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** What a scroll counts: pages of the conversation, or lines. */
export const SCROLL_UNIT = { page: 'page', line: 'line' } as const;

/** What a key asks of the chat, besides editing. */
export type InputAction =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'quit' }
  | { type: 'scroll'; by: number; unit: typeof SCROLL_UNIT[keyof typeof SCROLL_UNIT] }
  | null;

type Step = { state: InputState; action: InputAction };

export function emptyInput(history: readonly string[] = []): InputState {
  return { lines: [''], row: 0, col: 0, history, recall: null, draft: null, pasting: false };
}

/** Whether nothing is written. */
export const isEmpty = (s: InputState): boolean => s.lines.length === 1 && s.lines[0] === '';

const at = (s: InputState): string[] => graphemes(s.lines[s.row]);
const withLine = (s: InputState, row: number, text: string, col: number): InputState =>
  ({ ...s, lines: s.lines.map((l, k) => (k === row ? text : l)), row, col });

/** A text put in the box at the cursor. */
export function insert(s: InputState, text: string): InputState {
  const g = at(s);
  return withLine(s, s.row, [...g.slice(0, s.col), text, ...g.slice(s.col)].join(''), s.col + graphemes(text).length);
}

function newline(s: InputState): InputState {
  const g = at(s);
  const lines = [...s.lines.slice(0, s.row), g.slice(0, s.col).join(''), g.slice(s.col).join(''), ...s.lines.slice(s.row + 1)];
  return { ...s, lines, row: s.row + 1, col: 0 };
}

function backspace(s: InputState): InputState {
  if (s.col > 0) { const g = at(s); return withLine(s, s.row, [...g.slice(0, s.col - 1), ...g.slice(s.col)].join(''), s.col - 1); }
  if (s.row === 0) return s;
  const prev = graphemes(s.lines[s.row - 1]).length;
  const lines = [...s.lines.slice(0, s.row - 1), s.lines[s.row - 1] + s.lines[s.row], ...s.lines.slice(s.row + 1)];
  return { ...s, lines, row: s.row - 1, col: prev };
}

function del(s: InputState): InputState {
  const g = at(s);
  if (s.col < g.length) return withLine(s, s.row, [...g.slice(0, s.col), ...g.slice(s.col + 1)].join(''), s.col);
  if (s.row === s.lines.length - 1) return s;
  const [line, next, ...rest] = s.lines.slice(s.row);
  return { ...s, lines: [...s.lines.slice(0, s.row), line + next, ...rest] };
}

/** Ctrl-W: the word before the cursor, and the spaces after it, gone. */
function deleteWord(s: InputState): InputState {
  const before = at(s).slice(0, s.col).join('');
  const kept = before.replace(/\S+\s*$/, '');
  return withLine(s, s.row, kept + at(s).slice(s.col).join(''), graphemes(kept).length);
}

/** Up and down: on the first row, through the history; anywhere else, a row up or down. */
function vertical(s: InputState, by: -1 | 1): InputState {
  if (s.row === 0 && (by === -1 || s.recall !== null)) return recall(s, by);
  const row = Math.min(Math.max(0, s.row + by), s.lines.length - 1);
  return { ...s, row, col: Math.min(s.col, graphemes(s.lines[row]).length) };
}

function recall(s: InputState, by: -1 | 1): InputState {
  if (s.history.length === 0) return s;
  const from = s.recall ?? s.history.length;
  const to = Math.max(0, from + by);
  if (to >= s.history.length) {
    const lines = s.draft ?? [''];
    return { ...s, lines, row: 0, col: graphemes(lines[0]).length, recall: null, draft: null };
  }
  const lines = s.history[to].split('\n');
  return { ...s, lines, row: 0, col: graphemes(lines[0]).length, recall: to, draft: s.draft ?? s.lines };
}

function send(s: InputState): Step {
  const text = s.lines.join('\n');
  if (text.trim() === '') return { state: s, action: null };
  return { state: emptyInput([...s.history, text]), action: { type: 'send', text } };
}

const edit = (f: (s: InputState) => InputState) => (s: InputState): Step => ({ state: f(s), action: null });
const act = (action: InputAction) => (s: InputState): Step => ({ state: s, action });

/** What each key does, by its name with its modifiers (`ctrl+a`, `meta+return`). */
const KEYS: Record<string, (s: InputState) => Step> = {
  return: s => (s.pasting ? { state: newline(s), action: null } : send(s)),
  'meta+return': edit(newline),
  enter: edit(newline),
  backspace: edit(backspace),
  delete: edit(del),
  left: edit(s => ({ ...s, col: Math.max(0, s.col - 1) })),
  right: edit(s => ({ ...s, col: Math.min(at(s).length, s.col + 1) })),
  home: edit(s => ({ ...s, col: 0 })),
  end: edit(s => ({ ...s, col: at(s).length })),
  'ctrl+a': edit(s => ({ ...s, col: 0 })),
  'ctrl+e': edit(s => ({ ...s, col: at(s).length })),
  'ctrl+u': edit(s => withLine(s, s.row, at(s).slice(s.col).join(''), 0)),
  'ctrl+w': edit(deleteWord),
  up: edit(s => vertical(s, -1)),
  down: edit(s => vertical(s, 1)),
  'ctrl+c': act({ type: 'interrupt' }),
  'ctrl+d': act({ type: 'quit' }),
  pageup: act({ type: 'scroll', by: 1, unit: SCROLL_UNIT.page }),
  pagedown: act({ type: 'scroll', by: -1, unit: SCROLL_UNIT.page }),
  'paste-start': edit(s => ({ ...s, pasting: true })),
  'paste-end': edit(s => ({ ...s, pasting: false })),
};

/** A key's name with its modifiers — how KEYS names it. */
const keyId = (key: Key): string => `${key.ctrl ? 'ctrl+' : ''}${key.meta ? 'meta+' : ''}${key.name ?? ''}`;

/** A printable text a key types — none for a control or an escape sequence. */
const typed = (str: string | undefined, key: Key): string | null =>
  (str && !key.ctrl && !key.meta && !/\p{Cc}/u.test(str) ? str : null);

/** A key pressed: the state it leaves, and what it asks of the chat. */
export function keyInput(s: InputState, str: string | undefined, key: Key): Step {
  const handle = KEYS[keyId(key)];
  if (handle) return handle(s);
  const text = typed(str, key);
  return { state: text ? insert(s, text) : s, action: null };
}

/** The wheel's events, out of the keys a mouse report is read as: `ESC[<b;x;yM`, one key a character. */
export class MouseFilter {
  private report: string | null = null;

  /** A key: null when it is no mouse's; else consumed — with the wheel's direction once a report is whole. */
  feed(str: string | undefined, key: Key): { wheel: -1 | 0 | 1 } | null {
    if (key.sequence === '\x1b[<') { this.report = ''; return { wheel: 0 }; }
    if (this.report === null) return null;
    if (key.name !== REPORT_END) { this.report += str ?? ''; return { wheel: 0 }; }
    const button = Number(this.report.split(';')[0]);
    this.report = null;
    return { wheel: button === WHEEL_UP ? 1 : button === WHEEL_DOWN ? -1 : 0 };
  }
}

/** The key name of a mouse report's last character (`M` or `m`). */
const REPORT_END = 'm';
/** The buttons an SGR mouse report gives the wheel. */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
