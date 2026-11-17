// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A picker, as state and keys: a list to choose from — one item, or several
 * ticked (multi) — the arrows moving the selection, space ticking it, Enter
 * confirming, Esc or Ctrl-C giving up. Its rows are the menu's own (menu.ts),
 * under a title and above a hint. Pure: a key and a state in, a state and
 * what to do out.
 */
import { COLOR, paint, type Style } from './ansi.js';
import { menuRows, movedBy, type MenuItem, type MenuState } from './menu.js';
import { ESCAPE, keyId, type Key } from './input.js';
import { chop } from './width.js';

export interface PickerState {
  menu: MenuState;
  /** Which items are ticked — null for a picker of one item. */
  ticked: boolean[] | null;
}

/** The kinds of a picker's answer: the items picked, or nothing picked at all. */
export const PICKED = 'done';
const CANCELLED = 'cancel';

/** What a key asks: the items picked, by index — or nothing picked at all. */
type PickerAction = { type: typeof PICKED; picked: number[] } | { type: typeof CANCELLED } | null;

type Step = { state: PickerState; action: PickerAction };

/** The marks before an item of a multi picker. */
const TICK = { on: '[✔]', off: '[ ]' } as const;

/** A picker over `items`: the first selected; `multi` with every item ticked as `ticked` says. */
export function picker(items: MenuItem[], multi: boolean, ticked: boolean[] = items.map(() => false)): PickerState {
  return { menu: { items, selected: 0, start: 0 }, ticked: multi ? ticked : null };
}

/** The items Enter picks: the ticked ones, or the selected one of a single picker — none when nothing is ticked. */
function confirmed(state: PickerState): number[] {
  if (!state.ticked) return [state.menu.selected];
  return state.ticked.flatMap((on, index) => (on ? [index] : []));
}

const step = (state: PickerState, action: PickerAction = null): Step => ({ state, action });

/** What each key does besides the moves (MOVES), by its name with its modifiers, as input.ts names them. */
const KEYS: Record<string, (state: PickerState) => Step> = {
  space: state => step(state.ticked ? { ...state, ticked: state.ticked.map((on, index) => (index === state.menu.selected ? !on : on)) } : state),
  return: state => {
    const picked = confirmed(state);
    return step(state, picked.length > 0 ? { type: PICKED, picked } : null);
  },
  [ESCAPE]: state => step(state, { type: CANCELLED }),
  'ctrl+c': state => step(state, { type: CANCELLED }),
};

/** A key pressed: the state it leaves, and what it asks. */
export function keyPicker(state: PickerState, key: Key): Step {
  const id = keyId(key);
  const menu = movedBy(state.menu, id);
  if (menu) return step({ ...state, menu });
  return KEYS[id]?.(state) ?? step(state);
}

/** The picker's rows, `width` columns each: the title, a blank, the menu's rows — each item behind its tick in a multi picker — a blank, the hint. */
export function pickerRows(state: PickerState, title: string, hint: string, width: number, color: boolean): string[] {
  const { menu, ticked } = state;
  const items = ticked ? menu.items.map((item, index) => ({ ...item, label: `${ticked[index] ? TICK.on : TICK.off} ${item.label}` })) : menu.items;
  const line = (text: string, style: Style): string => paint(chop(` ${text}`, width)[0], style, color);
  return [
    line(title, { bold: true }),
    '',
    ...menuRows({ ...menu, items }, width, color),
    '',
    line(hint, { fg: COLOR.muted }),
  ];
}
