// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat screen's launcher (Ctrl-P, F2): everything the project offers by
 * category — its flows, teams, agents, skills, procedures, policies,
 * templates and variables (from the apx files), the room, the commands — a
 * search across them all, and what each can do: run a flow, show a block,
 * cite it, insert a name or a command. Pure: state and keys in, state, an
 * action and rows out.
 */
import { COLOR, paint } from './ansi.js';
import { chop, fit, padPainted, textWidth } from './width.js';
import { filtered } from './menu.js';
import type { CatalogEntry } from './catalog.js';
import type { Key } from './input.js';
import { FORMULAS, fill } from '../../src/formulas.js';

const SAY = FORMULAS.messages.launcher;

/** The categories, in order: each one's key — a block kind, or the room, or the commands — and its icon. */
export const CATEGORIES = [
  { key: 'flow', icon: '▶' }, { key: 'team', icon: '⚑' }, { key: 'agent', icon: '●' }, { key: 'skill', icon: '✦' },
  { key: 'procedure', icon: '⚙' }, { key: 'policy', icon: '§' }, { key: 'template', icon: '✎' }, { key: 'var', icon: '◆' },
  { key: 'room', icon: '☺' }, { key: 'command', icon: '/' },
] as const;
type CategoryKey = typeof CATEGORIES[number]['key'];
const FLOW: CategoryKey = 'flow';

/** One thing offered: its name, what it says of itself, and what it is — a block of the project, or a text to insert. */
interface LauncherItem {
  name: string;
  about: string;
  entry?: CatalogEntry;
  insert?: string;
}

/** What the launcher offers, by category. */
export type LauncherData = Partial<Record<CategoryKey, LauncherItem[]>>;

/** The panes the arrows move in. */
const PANE = { categories: 'categories', items: 'items' } as const;
type Pane = typeof PANE[keyof typeof PANE];

export interface LauncherState {
  search: string;
  /** The category selected, among those shown; the item selected, in it; the pane the arrows move in. */
  category: number;
  item: number;
  pane: Pane;
}

/** What a key asks the chat: run a flow, show a block, put a text in the box — or close. */
export type LauncherAction =
  | { type: 'run'; entry: CatalogEntry }
  | { type: 'show'; entry: CatalogEntry }
  | { type: 'insert'; text: string }
  | { type: 'close' }
  | null;

type Step = { state: LauncherState; action: LauncherAction };
type Shown = { key: CategoryKey; icon: string; items: LauncherItem[] };

export const openLauncher = (): LauncherState => ({ search: '', category: 0, item: 0, pane: PANE.categories });

/** The categories shown — those with something in them, after the search — each with its items. */
export function shownOf(data: LauncherData, search: string): Shown[] {
  return CATEGORIES.flatMap(c => {
    const all = data[c.key] ?? [];
    const items = search ? filtered(all.map(item => ({ insert: item.name, label: item.about, item })), search).map(m => m.item) : all;
    return items.length ? [{ ...c, items }] : [];
  });
}

/** The category and the item selected, as shown. */
function selection(s: LauncherState, shown: Shown[]): { category: Shown | undefined; item: LauncherItem | undefined } {
  const category = shown[Math.min(s.category, shown.length - 1)];
  return { category, item: category?.items[Math.min(s.item, category.items.length - 1)] };
}

/** An item's primary action: run a flow, show a block, insert a text. */
function primary(item: LauncherItem | undefined, category: Shown | undefined): LauncherAction {
  if (!item || !category) return null;
  if (item.entry) return category.key === FLOW ? { type: 'run', entry: item.entry } : { type: 'show', entry: item.entry };
  return item.insert ? { type: 'insert', text: item.insert } : null;
}

/** The arrows: through the categories or through the items of the one selected. */
function moveIn(s: LauncherState, shown: Shown[], by: number): LauncherState {
  const { category } = selection(s, shown);
  if (s.pane === PANE.categories) return { ...s, category: Math.max(0, Math.min(shown.length - 1, s.category + by)), item: 0 };
  return { ...s, item: Math.max(0, Math.min((category?.items.length ?? 1) - 1, s.item + by)) };
}

/** What each named key does. */
const NAMED: Record<string, (s: LauncherState, shown: Shown[]) => Step> = {
  escape: s => ({ state: s, action: { type: 'close' } }),
  left: s => ({ state: { ...s, pane: PANE.categories }, action: null }),
  right: s => ({ state: { ...s, pane: PANE.items }, action: null }),
  up: (s, shown) => ({ state: moveIn(s, shown, -1), action: null }),
  down: (s, shown) => ({ state: moveIn(s, shown, 1), action: null }),
  return: (s, shown) => { const { category, item } = selection(s, shown); return { state: s, action: primary(item, category) }; },
  backspace: s => ({ state: { ...s, search: s.search.slice(0, -1), category: 0, item: 0 }, action: null }),
};

/** The keys that act on the selection while the search is empty — `s` show, `#` cite; once it has text, they are typed. */
const ON_SELECTION: Record<string, (entry: CatalogEntry) => LauncherAction> = {
  s: entry => ({ type: 'show', entry }),
  '#': entry => ({ type: 'insert', text: `#${entry.name} ` }),
};

/** A key: the launcher's next state, and what it asks. */
export function launcherKey(s: LauncherState, data: LauncherData, str: string | undefined, key: Key): Step {
  const shown = shownOf(data, s.search);
  const named = key.name ? NAMED[key.name] : undefined;
  if (named) return named(s, shown);
  if (!str || key.ctrl || key.meta || /\p{Cc}/u.test(str)) return { state: s, action: null };
  return typed(s, shown, str);
}

/** A character typed: an action on the selection while the search is empty, else the search grows. */
function typed(s: LauncherState, shown: Shown[], str: string): Step {
  const entry = selection(s, shown).item?.entry;
  const act = s.search === '' && entry ? ON_SELECTION[str] : undefined;
  if (act && entry) return { state: s, action: act(entry) };
  return { state: { ...s, search: s.search + str, category: 0, item: 0 }, action: null };
}

/** Under this width, one pane at a time; the categories pane's width; the rows the frame takes besides the panes. */
const TWO_PANES_FROM = 60;
const CATEGORY_WIDTH = 18;
const FRAME_ROWS = 6;
/** What a box takes on its sides (`│` and `│`), a count's width, the title's border beyond its text (`╭─ ` and ` ╮`). */
const SIDES = 2;
const COUNT_WIDTH = 2;
const TITLE_BORDER = 5;

/** The detail of the selected item: its summary, and its actions. */
function detailOf(item: LauncherItem | undefined, category: CategoryKey | undefined): [string, string] {
  if (!item) return [SAY.nothing, ''];
  const e = item.entry;
  if (!e) return [`${item.name} — ${item.about}`, SAY.actionsInsert];
  const summary = fill(SAY.detail, { name: e.name, kind: e.kind, of: e.unit ? fill(SAY.of, { unit: e.unit }) : '', uses: e.uses.length ? fill(SAY.uses, { names: e.uses.join(', ') }) : '' });
  return [summary, category === FLOW ? SAY.actionsFlow : SAY.actionsBlock];
}

interface Layout { two: boolean; catW: number; itemW: number; body: number; color: boolean }

function layoutOf(size: { width: number; height: number }, color: boolean): Layout {
  const two = size.width >= TWO_PANES_FROM;
  const catW = two ? CATEGORY_WIDTH : size.width - SIDES;
  // Two panes: three bars — the sides and the one between them.
  return { two, catW, itemW: two ? size.width - catW - SIDES - 1 : catW, body: Math.max(0, size.height - FRAME_ROWS), color };
}

/** The categories pane's rows: icon, label, count — the selected raised, or behind `>` without colour. */
function categoryRows(s: LauncherState, shown: Shown[], l: Layout): string[] {
  const ci = Math.min(s.category, Math.max(0, shown.length - 1));
  return shown.map((c, k) => {
    const mark = k === ci && !l.color ? '>' : ' ';
    const text = `${mark} ${c.icon} ${SAY[c.key]}`.padEnd(l.catW - COUNT_WIDTH - 1) + String(c.items.length).padStart(COUNT_WIDTH);
    return paint(fit(text, l.catW), k === ci && s.pane === PANE.categories ? { bg: COLOR.raised, bold: true } : {}, l.color);
  });
}

/** The items pane's rows: a window around the selection — `▶` before it, the unit on the right. */
function itemRows(s: LauncherState, items: LauncherItem[], l: Layout): string[] {
  const ii = Math.min(s.item, Math.max(0, items.length - 1));
  const top = Math.max(0, Math.min(ii - l.body + 1, items.length - l.body));
  return items.slice(top, top + l.body).map((item, k) => {
    const on = top + k === ii;
    const unit = item.entry?.unit ?? '';
    const name = chop(`${on ? '▶' : ' '} ${item.name}`, Math.max(1, l.itemW - textWidth(unit) - 1))[0];
    const gap = ' '.repeat(Math.max(1, l.itemW - textWidth(name) - textWidth(unit)));
    return paint(`${name}${gap}${unit}`, on && s.pane === PANE.items ? { bg: COLOR.raised, bold: true } : {}, l.color);
  });
}

/** The launcher's rows: `height` rows of `width` columns — a box, the search, the panes, the detail. */
export function launcherRows(s: LauncherState, data: LauncherData, size: { width: number; height: number }, color: boolean): string[] {
  const { width, height } = size;
  const l = layoutOf(size, color);
  const shown = shownOf(data, s.search);
  const { category, item } = selection(s, shown);
  const cats = categoryRows(s, shown, l);
  const items = itemRows(s, category?.items ?? [], l);
  const muted = (t: string) => paint(t, { fg: COLOR.muted }, color);
  const pane = (k: number) => (l.two ? `│${padPainted(cats[k] ?? '', l.catW)}│${padPainted(items[k] ?? '', l.itemW)}│` : `│${padPainted((s.pane === PANE.categories ? cats : items)[k] ?? '', l.catW)}│`);
  const [summary, actions] = detailOf(item, category?.key);
  const inner = width - SIDES;
  const split = (left: string, mid: string, right: string) => (l.two ? `${left}${'─'.repeat(l.catW)}${mid}${'─'.repeat(l.itemW)}${right}` : `${left}${'─'.repeat(inner)}${right}`);
  return [
    muted(`╭─ ${SAY.title} ${'─'.repeat(Math.max(0, width - textWidth(SAY.title) - TITLE_BORDER))}╮`),
    `│${padPainted(` 🔍 ${s.search || muted(SAY.search)}`, inner)}│`,
    muted(split('├', '┬', '┤')),
    ...Array.from({ length: l.body }, (_, k) => pane(k)),
    muted(split('├', '┴', '┤')),
    `│${padPainted(` ${chop(summary, inner - 1)[0]}`, inner)}│`,
    `│${padPainted(` ${muted(actions)}`, inner)}│`,
    muted(`╰${'─'.repeat(inner)}╯`),
  ].slice(0, height);
}
