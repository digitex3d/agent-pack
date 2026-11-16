// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The input box's completion menu, as data: what the text before the cursor
 * asks to complete — a command after `/`, a participant after `@`, an
 * invitable after `/invite `, a participant after `/remove ` — the items
 * that fit what is typed (by prefix first, then anywhere; case aside), the
 * one selected; drawn as rows above the box. Pure: text in, menu out.
 */
import { COLOR, paint } from './ansi.js';
import { chop, graphemes, textWidth } from './width.js';
import type { InputState } from './input.js';

/** One choice: what it puts in the box, what it shows, and — dim — what it says of itself. */
interface MenuItem {
  insert: string;
  label: string;
  detail?: string;
}

/** An open menu: its choices, the one selected, and the grapheme column where the word it completes starts. */
export interface MenuState {
  items: MenuItem[];
  selected: number;
  start: number;
}

/** Where the choices come from. */
export interface MenuSources {
  commands: readonly { word: string; args: string; about: string }[];
  /** `@all`, then each one in the room. */
  mentions: MenuItem[];
  invitable: readonly string[];
  /** Who `/remove` can take off. */
  removable: MenuItem[];
}

/** The most rows the menu takes; past them it scrolls. */
export const MENU_ROWS = 8;
const COMMAND_PREFIX = '/';
/** The words of a command being given its argument: the command, the argument. */
const COMMAND_AND_ARGUMENT = 2;
const MENTION_PREFIX = '@';
/** The commands whose argument the menu completes, and from which source. */
const ARGUMENTS: Record<string, (s: MenuSources) => MenuItem[]> = {
  '/invite': s => s.invitable.map(name => ({ insert: name, label: name })),
  '/remove': s => s.removable,
};

/** The items whose insert fits what is typed: starting with it first, then holding it — case aside. */
export function filtered<T extends { insert: string; label: string }>(items: readonly T[], typed: string): T[] {
  const want = typed.toLowerCase();
  const key = (item: T) => `${item.insert} ${item.label}`.toLowerCase();
  return [...items.filter(i => key(i).startsWith(want)), ...items.filter(i => !key(i).startsWith(want) && key(i).includes(want))];
}

/** What the text before the cursor asks to complete: the choices and where the word starts — null when nothing. */
function choicesFor(before: string, s: MenuSources): { items: MenuItem[]; start: number; typed: string } | null {
  const words = before.split(' ');
  const last = words[words.length - 1];
  const start = graphemes(before).length - graphemes(last).length;
  if (words.length === 1 && last.startsWith(COMMAND_PREFIX)) {
    return { items: s.commands.map(c => ({ insert: c.word, label: `${c.word} ${c.args}`, detail: c.about })), start, typed: last };
  }
  const argument = words.length === COMMAND_AND_ARGUMENT ? ARGUMENTS[words[0]] : undefined;
  if (argument) return { items: argument(s), start, typed: last };
  if (last.startsWith(MENTION_PREFIX)) return { items: s.mentions, start, typed: last };
  return null;
}

/** The menu for the box as it is — null when it asks for none, or nothing fits; the selection kept when it still can be. */
export function menuOf(input: InputState, s: MenuSources, before: MenuState | null): MenuState | null {
  const text = graphemes(input.lines[input.row]).slice(0, input.col).join('');
  const choices = choicesFor(text, s);
  if (!choices) return null;
  const items = filtered(choices.items, choices.typed);
  if (items.length === 0) return null;
  const selected = before ? Math.min(before.selected, items.length - 1) : 0;
  return { items, selected, start: choices.start };
}

/** The selection moved by `by`, wrapping round. */
export function moved(menu: MenuState, by: number): MenuState {
  const count = menu.items.length;
  return { ...menu, selected: (menu.selected + by + count) % count };
}

/** The selected choice put in the box in place of the word typed, and a space after it. */
export function accepted(input: InputState, menu: MenuState): InputState {
  const line = graphemes(input.lines[input.row]);
  const insert = `${menu.items[menu.selected].insert} `;
  const text = [...line.slice(0, menu.start), insert, ...line.slice(input.col)].join('');
  return { ...input, lines: input.lines.map((l, k) => (k === input.row ? text : l)), col: menu.start + graphemes(insert).length };
}

/** The menu's rows, `width` columns each: a window of at most MENU_ROWS around the selection; the selected one raised — or behind `>` without colour. */
export function menuRows(menu: MenuState, width: number, color: boolean): string[] {
  const top = Math.max(0, Math.min(menu.selected - MENU_ROWS + 1, menu.items.length - MENU_ROWS));
  return menu.items.slice(top, top + MENU_ROWS).map((item, k) => {
    const chosen = top + k === menu.selected;
    const mark = color ? ' ' : chosen ? '>' : ' ';
    const label = chop(`${mark} ${item.label}`, width)[0];
    const detail = item.detail ? chop(`  ${item.detail}`, Math.max(0, width - textWidth(label)))[0] : '';
    const raise = chosen ? { bg: COLOR.raised } : {};
    const rest = ' '.repeat(Math.max(0, width - textWidth(label) - textWidth(detail)));
    return `${paint(label, { ...raise, bold: chosen }, color)}${paint(detail, { fg: COLOR.muted, ...raise }, color)}${paint(rest, raise, color)}`;
  });
}
