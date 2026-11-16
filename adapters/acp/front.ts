// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * What the chat shows itself through: the inline lines of a terminal or a
 * pipe (./inline.ts), or the full screen of a terminal on both sides
 * (./tui.ts). The chat owns the session and the turns; a front shows the
 * events, takes the lines typed, asks the permissions.
 */
import type { ChatEvent } from './events.js';
import type { CatalogEntry } from './catalog.js';

/** What a front hands back to the chat. */
export interface FrontHandlers {
  /** A line typed, to send. */
  line(text: string): void;
  /** Ctrl-C. */
  interrupt(): void;
  /** Ctrl-D, the input closed — or a signal. */
  quit(): void;
  /** The launcher's actions: a flow to run (a boss turn), a block to show (in the chat only). */
  run(entry: CatalogEntry): void;
  show(entry: CatalogEntry): void;
}

export interface Front {
  /** Shown, and listening: `intro` says what the chat is. */
  start(intro: string, handlers: FrontHandlers): void;
  /** One event, as the events file holds it. */
  show(e: ChatEvent): void;
  /** A turn running, or done — done, the front is ready for the next line. */
  busy(on: boolean): void;
  /** A permission the boss asks for: the answer typed (`o` allows once) — null when it is cancelled. */
  ask(what: string, toolId: string | null): Promise<string | null>;
  /** The permission being asked, cancelled. */
  cancelAsk(): void;
  /** Ctrl-C with no turn running: true when nothing is typed (the chat then quits), else what is typed is cleared. */
  clearOrEmpty(): boolean;
  /** Gone: the terminal given back. */
  stop(): void;
}

/** The single keys of the full screen's permission box: allow once, reject. */
export const ANSWER_KEY = { once: 'o', reject: 'r' } as const;

/** The answers to a permission question that allow it once — anything else rejects it. */
export const ALLOW_ONCE = new Set(['o', 'once', 'a', 'allow', 'y', 'yes']);
