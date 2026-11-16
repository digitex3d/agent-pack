// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The terminal's escape codes the chat's screen uses, and its colours: one
 * accent per source — the boss's own, a harness's taken from a small palette
 * by its name, the same every time. With colour off (NO_COLOR), no code at all.
 */
const CSI = '\x1b[';

/** The modes the screen turns on, and off again when it ends. */
export const TERM = {
  altOn: `${CSI}?1049h`, altOff: `${CSI}?1049l`,
  hide: `${CSI}?25l`, show: `${CSI}?25h`,
  syncOn: `${CSI}?2026h`, syncOff: `${CSI}?2026l`,
  pasteOn: `${CSI}?2004h`, pasteOff: `${CSI}?2004l`,
  mouseOn: `${CSI}?1000h${CSI}?1006h`, mouseOff: `${CSI}?1006l${CSI}?1000l`,
  clearLine: `${CSI}K`, clear: `${CSI}2J`,
} as const;

/** The bars the screen draws — a message's, the input box's, a delegation's — each followed by a space: the columns they take. */
export const BAR = { heavy: '┃ ', light: '│ ', width: 2 } as const;

/** The cursor moved to a row and a column, both from 0. */
export const moveTo = (row: number, col: number): string => `${CSI}${row + 1};${col + 1}H`;

/** The colours, as SGR parameters. */
export const COLOR = {
  boss: '38;5;141', user: '38;5;252', red: '38;5;203', warn: '38;5;214', muted: '38;5;245', raised: '48;5;236',
} as const;
/** The base of the name's hash that picks a harness's accent. */
const HASH_BASE = 31;
const ACCENTS = ['38;5;75', '38;5;114', '38;5;215', '38;5;80', '38;5;176', '38;5;221'] as const;

/** How a piece of text looks. */
export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

/** A text painted — or as it is, with colour off. */
export function paint(text: string, style: Style, color: boolean): string {
  const codes = [style.bold ? '1' : '', style.dim ? '2' : '', style.fg ?? '', style.bg ?? ''].filter(Boolean);
  if (!color || codes.length === 0 || text === '') return text;
  return `${CSI}${codes.join(';')}m${text}${CSI}0m`;
}

/** A source's accent: the boss's own, a harness's from the palette, by its name. */
export function accentOf(source: string, boss: boolean): string {
  if (boss) return COLOR.boss;
  const hash = [...source].reduce((h, c) => (h * HASH_BASE + c.charCodeAt(0)) % ACCENTS.length, 0);
  return ACCENTS[hash];
}
