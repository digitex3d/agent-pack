// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat's full-screen front — a terminal on both sides: the conversation
 * read from the events (./conversation.ts), drawn as a frame (./view.ts) on
 * the screen (./screen.ts); the input box edited key by key (./input.ts); a
 * permission asked in the box's place, answered with one key.
 */
import { Conversation, ENTRY_KIND } from './conversation.js';
import { MouseFilter, SCROLL_UNIT, emptyInput, insert, isEmpty, ESCAPE, keyId, keyInput, type InputAction, type InputState, type Key } from './input.js';
import { frameOf, type Frame } from './view.js';
import { Screen } from './screen.js';
import type { ChatEvent } from './events.js';
import { ANSWER_KEY, type Front, type FrontHandlers } from './front.js';
import { accepted, menuOf, movedBy, type MenuSources, type MenuState } from './menu.js';
import { CATEGORIES, launcherKey, openLauncher, type LauncherAction, type LauncherData, type LauncherState } from './launcher.js';
import type { CatalogEntry } from './catalog.js';
import { ALL, COMMANDS } from './room.js';
import { withModel } from './figures.js';
import { FORMULAS } from '../../src/formulas.js';

type Action = NonNullable<InputAction>;

/** How often the spinner turns, and how many lines a turn of the wheel scrolls. */
const SPINNER_MS = 80;
const WHEEL_LINES = 3;
const TICK_MS = 1000;

export interface TuiOptions {
  boss: string;
  stamp: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  color: boolean;
  /** The project's blocks, as the launcher offers them. */
  catalog: () => readonly CatalogEntry[];
  /** What `/invite` can bring in: the harnesses, and each as an agent of the project — the menu offers them. */
  invitable: readonly string[];
}

/** The keys the open menu takes besides the moves: accept, close. */
type MenuAction = 'accept' | 'close';
/** The keys that open the launcher. */
const LAUNCHER_KEYS: ReadonlySet<string> = new Set(['ctrl+p', 'f2']);
const MENU_KEYS: Record<string, MenuAction> = { tab: 'accept', return: 'accept', [ESCAPE]: 'close' };

export class TuiFront implements Front {
  private readonly conversation: Conversation;
  private input: InputState = emptyInput();
  private scroll = 0;
  private spinner = 0;
  private working = false;
  private asking: { what: string; toolId: string | null; answer: (a: string | null) => void } | null = null;
  private readonly mouse = new MouseFilter();
  private readonly screen: Screen;
  private handlers: FrontHandlers | null = null;
  private turning: NodeJS.Timeout | undefined;
  private last: Frame | null = null;
  /** The completion menu, when open — and whether Esc closed it for the text as it is. */
  private menu: MenuState | null = null;
  /** The launcher, when open. */
  private launcher: LauncherState | null = null;
  private dismissed = false;
  private ticking: NodeJS.Timeout | undefined;
  /** When the chat began, and the turn running. */
  private readonly since = Date.now();
  private turnSince = Date.now();

  constructor(private readonly o: TuiOptions) {
    this.conversation = new Conversation(o.boss);
    this.screen = new Screen(o.output, o.input, () => this.frame(), () => this.handlers?.quit());
  }

  start(_intro: string, handlers: FrontHandlers): void {
    this.handlers = handlers;
    this.screen.open((str, key) => this.onKey(str, key));
    this.turning = setInterval(() => this.turn(), SPINNER_MS);
    // The clocks of the status line move once a second.
    this.ticking = setInterval(() => this.screen.schedule(), TICK_MS);
  }

  show(e: ChatEvent): void {
    this.conversation.apply(e);
    this.screen.schedule();
  }

  busy(on: boolean): void {
    if (on && !this.working) this.turnSince = Date.now();
    this.working = on;
    this.screen.schedule();
  }

  ask(what: string, toolId: string | null): Promise<string | null> {
    return new Promise(answer => { this.asking = { what, toolId, answer }; this.screen.schedule(); });
  }

  cancelAsk(): void {
    this.answer(null);
  }

  clearOrEmpty(): boolean {
    if (isEmpty(this.input)) return true;
    this.input = emptyInput(this.input.history);
    this.screen.schedule();
    return false;
  }

  stop(): void {
    clearInterval(this.turning);
    clearInterval(this.ticking);
    this.screen.close();
  }

  /** The frame at the screen's size, now. */
  private frame(): Frame {
    this.last = frameOf({
      ...this.screen.size(), color: this.o.color, boss: this.o.boss, stamp: this.o.stamp, entries: this.conversation.entries,
      scroll: this.scroll, spinner: this.spinner, busy: this.working, input: this.input,
      asking: this.asking?.what ?? null, waiting: this.asking?.toolId ?? null,
      menu: this.asking ? null : this.menu, launcher: this.launcher && !this.asking ? { state: this.launcher, data: this.launcherData() } : null, members: this.conversation.group.members, models: this.conversation.group.models, usage: this.conversation.group.usage, pseudonyms: this.conversation.group.pseudonyms,
      total: Date.now() - this.since, ...(this.working ? { elapsed: Date.now() - this.turnSince } : {}),
    });
    this.scroll = Math.min(this.scroll, this.last.scrollMax);
    return this.last;
  }

  /** The spinner turned, while a tool call runs. */
  private turn(): void {
    if (!this.conversation.entries.some(e => e.kind === ENTRY_KIND.tool && e.running)) return;
    this.spinner++;
    this.screen.schedule();
  }

  private answer(a: string | null): void {
    const asked = this.asking;
    this.asking = null;
    asked?.answer(a);
    this.screen.schedule();
  }

  private onKey(str: string | undefined, key: Key): void {
    const mouse = this.mouse.feed(str, key);
    if (mouse) { this.scrollBy(mouse.wheel * WHEEL_LINES); return; }
    if (this.asking && !key.ctrl) { if (str === ANSWER_KEY.once || str === ANSWER_KEY.reject) this.answer(str); return; }
    // The launcher, open or opening, then the menu, take a key first; whatever they leave edits the box.
    if (!this.launcherKey(str, key) && !this.menuKey(key)) this.editKey(str, key);
    this.screen.schedule();
  }

  /** A key that edits the box — the menu opens, filters or closes with what is typed. */
  private editKey(str: string | undefined, key: Key): void {
    const before = this.input.lines.join('\n');
    const step = keyInput(this.input, str, key);
    this.input = step.state;
    // A text changed lets the menu open again; Esc keeps it closed until then.
    if (this.input.lines.join('\n') !== before) this.dismissed = false;
    this.menu = this.dismissed ? null : menuOf(this.input, this.sources(), this.menu);
    this.act(step.action);
  }

  /** A key the open menu takes — true; any other goes on to the box (and filters the menu). The history never moves while it is open. */
  private menuKey(key: Key): boolean {
    if (!this.menu) return false;
    const id = keyId(key);
    const menu = movedBy(this.menu, id);
    if (menu) { this.menu = menu; return true; }
    const does = MENU_KEYS[id];
    if (!does) return false;
    this.menuActions[does](this.menu);
    return true;
  }

  /** What each key of the open menu does besides the moves (MOVES): accept the selection into the box, or close the menu. */
  private readonly menuActions: Record<MenuAction, (menu: MenuState) => void> = {
    accept: menu => { this.input = accepted(this.input, menu); this.menu = menuOf(this.input, this.sources(), null); },
    close: () => { this.menu = null; this.dismissed = true; },
  };

  /** A key in the open launcher: its state moved, its action done — then it closes. */
  private launcherKey(str: string | undefined, key: Key): boolean {
    if (!this.launcher) {
      if (!LAUNCHER_KEYS.has(keyId(key))) return false;
      this.launcher = openLauncher();
      this.menu = null;
      return true;
    }
    const { state, action } = launcherKey(this.launcher, this.launcherData(), str, key);
    this.launcher = action ? null : state;
    if (action) (this.launcherActions[action.type] as (a: NonNullable<LauncherAction>) => void)(action);
    return true;
  }

  /** What each action of the launcher does — it closes first. */
  private readonly launcherActions: { [T in NonNullable<LauncherAction>['type']]: (a: Extract<NonNullable<LauncherAction>, { type: T }>) => void } = {
    insert: a => { this.input = insert(this.input, a.text); },
    run: a => this.handlers?.run(a.entry),
    show: a => this.handlers?.show(a.entry),
    close: () => { /* closed already */ },
  };

  /** What the launcher offers now: the blocks by kind, the room, the commands. */
  private launcherData(): LauncherData {
    const data: LauncherData = {};
    for (const entry of this.o.catalog()) {
      const key = CATEGORIES.find(c => c.key === entry.kind)?.key;
      if (key) data[key] = [...(data[key] ?? []), { name: entry.name, about: entry.about, entry }];
    }
    const menu = this.sources();
    data.room = menu.removable.map(m => ({ name: m.label, about: m.detail ?? '', insert: `@${m.insert} ` }));
    data.command = COMMANDS.map(c => ({ name: `${c.word} ${c.args}`, about: c.about, insert: `${c.word} ` }));
    return data;
  }

  /** What the menu offers now: the commands, the room, the invitable. */
  private sources(): MenuSources {
    const group = this.conversation.group;
    const member = (prefix: string) => (id: string) => {
      const name = group.pseudonyms.get(id) ?? id;
      return { insert: `${prefix}${name}`, label: `${prefix}${name}`, detail: withModel(id, group.models.get(id)) };
    };
    const room = group.room();
    return {
      commands: COMMANDS,
      mentions: [{ insert: `@${ALL}`, label: `@${ALL}`, detail: FORMULAS.messages.chat.aboutAll }, ...room.map(member('@'))],
      invitable: this.o.invitable,
      removable: room.map(member('')),
    };
  }

  /** What each action of the input does. */
  private readonly actions: { [T in Action['type']]: (a: Extract<Action, { type: T }>) => void } = {
    send: a => { this.scroll = 0; this.handlers?.line(a.text); },
    scroll: a => this.scrollBy(a.by * (a.unit === SCROLL_UNIT.page ? this.last?.page ?? 1 : 1)),
    interrupt: () => this.handlers?.interrupt(),
    quit: () => this.handlers?.quit(),
  };

  private act(action: InputAction): void {
    // Each handler takes the action of its own type: the table is keyed by it.
    if (action) (this.actions[action.type] as (a: Action) => void)(action);
  }

  private scrollBy(lines: number): void {
    this.scroll = Math.max(0, Math.min(this.scroll + lines, this.last?.scrollMax ?? 0));
    this.screen.schedule();
  }
}
