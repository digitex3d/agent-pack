// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat screen's participants list, on the right of the conversation —
 * WeeChat's nicklist: how many there are, the boss first with `@`, then the
 * participants in the order they joined, the user last; each name in its
 * accent, with the model it runs on and, under it, what its turns cost —
 * as it reports them. As wide as the longest and four columns more, at most 32 (cut with `…`);
 * left out on a screen under 70 columns. Pure: state in, rows out.
 */
import { BOSS_SOURCE } from './events.js';
import { COLOR, accentOf, paint } from './ansi.js';
import { YOU } from './lines.js';
import { chop, fit, padPainted, textWidth } from './width.js';
import { cost, tokens, withModel } from './figures.js';
import type { Usage } from './usage.js';
import { FORMULAS, fill } from '../../src/formulas.js';

/** The narrowest screen with the list, its widest, and what it adds to the longest name: `@`, the spaces around it, a margin. */
const PANEL_FROM = 70;
const PANEL_MAX = 32;
const PANEL_EXTRA = 4;
/** Where a participant's usage starts, under its name. */
const USAGE_INDENT = '   ';

export interface Panel {
  width: number;
  /** Its rows, top to bottom, each `width` columns. */
  rows: string[];
}

/** Who the list shows, and what each reports — the boss's model and usage under its source. */
export interface PanelState {
  width: number;
  boss: string;
  members: readonly string[];
  models?: ReadonlyMap<string, string>;
  usage?: ReadonlyMap<string, Usage>;
  pseudonyms?: ReadonlyMap<string, string>;
  color: boolean;
}

/** A text cut to `width` columns with `…` when longer, padded when shorter. */
function clipped(text: string, width: number): string {
  return fit(textWidth(text) > width ? `${chop(text, width - 1)[0]}…` : text, width);
}

/** What a participant's turns cost, tersely — null when it reports nothing. */
function spent(usage: Usage | undefined): string | null {
  if (!usage) return null;
  return [`${tokens(usage.total)} tok`, ...(usage.cost !== undefined ? [cost(usage.cost, usage.currency)] : [])].join(' · ');
}

/** The list, at the screen's width — null when the screen is too narrow for it. */
export function panelOf(o: PanelState): Panel | null {
  if (o.width < PANEL_FROM) return null;
  const who = [{ mark: '@', source: BOSS_SOURCE, name: o.boss, fg: accentOf(BOSS_SOURCE, true) },
    ...o.members.map(name => ({ mark: ' ', source: name, name, fg: accentOf(name, false) })), { mark: ' ', source: YOU, name: YOU, fg: COLOR.user }];
  // A participant with a pseudonym: the pseudonym, then — dim — its id and model; anyone else: the name and model.
  const labels = who.map(w => {
    const real = withModel(w.name, o.models?.get(w.source));
    const pseudonym = o.pseudonyms?.get(w.source);
    return pseudonym ? { name: ` ${w.mark} ${pseudonym}`, detail: `  ${real}` } : { name: ` ${w.mark} ${real}`, detail: '' };
  });
  const header = ` ${fill(FORMULAS.messages.chat.participants, { count: who.length })}`;
  const width = Math.min(PANEL_MAX, Math.max(...labels.map(l => textWidth(l.name + l.detail)), textWidth(header)) + PANEL_EXTRA);
  const rows = who.flatMap((w, k) => {
    const used = spent(o.usage?.get(w.source));
    const row = clipped(labels[k].name + labels[k].detail, width);
    const cut = Math.min(row.length, labels[k].name.length);
    const named = `${paint(row.slice(0, cut), { fg: w.fg }, o.color)}${paint(row.slice(cut), { fg: COLOR.muted }, o.color)}`;
    return [named, ...(used ? [paint(clipped(`${USAGE_INDENT}${used}`, width), { fg: COLOR.muted }, o.color)] : [])];
  });
  return { width, rows: [paint(clipped(header, width), { fg: COLOR.muted }, o.color), ...rows] };
}

/** The conversation's rows with the list on their right, behind a `│`: each row padded to the room left. */
export function besidePanel(rows: readonly string[], panel: Panel, width: number, color: boolean): string[] {
  const left = width - 1 - panel.width;
  const bar = paint('│', { fg: COLOR.muted }, color);
  return rows.map((row, k) => `${padPainted(row, left)}${bar}${panel.rows[k] ?? ''}`);
}

/** The rule under the header: a `┬` where the list's bar starts. */
export function ruleOf(width: number, panel: Panel | null, color: boolean): string {
  const rule = panel ? `${'─'.repeat(width - 1 - panel.width)}┬${'─'.repeat(panel.width)}` : '─'.repeat(width);
  return paint(rule, { fg: COLOR.muted }, color);
}
