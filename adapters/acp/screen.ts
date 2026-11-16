// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat's terminal, full screen: the alternate screen, raw keys (read by
 * `readline.emitKeypressEvents`), bracketed paste, the mouse wheel; a frame
 * drawn in one synchronized write, only its changed rows, at most one draw a
 * frame time; a resize redrawn once it settles. Whatever ends the process —
 * a quit, a signal, an error — leaves the terminal as it found it.
 */
import { emitKeypressEvents } from 'node:readline';
import { TERM, moveTo } from './ansi.js';
import type { Frame } from './view.js';
import type { Key } from './input.js';
import { errorMessage } from '../../src/errors.js';

/** The shortest time between two draws (about 60 a second), and how long a resize must settle before the redraw. */
const FRAME_MS = 16;
const RESIZE_SETTLE_MS = 100;
const DEFAULT_SIZE = { width: 80, height: 24 };
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGABRT'] as const;

type TtyIn = NodeJS.ReadStream & { setRawMode?: (raw: boolean) => unknown };

export class Screen {
  private shown: string[] = [];
  private open_ = false;
  private pending: NodeJS.Timeout | null = null;
  private resizing: NodeJS.Timeout | null = null;
  /** A signal: the chat ends as on a quit — the boss stopped, then the terminal given back. */
  private readonly onSignal = (): void => this.bail();
  /** An error nobody caught: the terminal given back first, then the error said, then the chat ended. */
  private readonly onCrash = (e: unknown): void => { this.close(); process.stderr.write(`agent-pack chat: ${errorMessage(e)}\n`); this.bail(); };
  private readonly onExit = (): void => this.close();
  private onKey: ((str: string | undefined, key: Key) => void) | null = null;

  constructor(private readonly out: NodeJS.WriteStream, private readonly inp: TtyIn, private readonly frame: () => Frame, private readonly bail: () => void) {}

  size(): { width: number; height: number } {
    return { width: this.out.columns || DEFAULT_SIZE.width, height: this.out.rows || DEFAULT_SIZE.height };
  }

  /** The screen taken: its modes on, keys to `onKey`, a resize redrawn. */
  open(onKey: (str: string | undefined, key: Key) => void): void {
    this.open_ = true;
    for (const s of SIGNALS) process.on(s, this.onSignal);
    process.on('uncaughtException', this.onCrash);
    process.on('unhandledRejection', this.onCrash);
    process.on('exit', this.onExit);
    emitKeypressEvents(this.inp);
    this.inp.setRawMode?.(true);
    this.onKey = onKey;
    this.inp.on('keypress', onKey);
    this.inp.resume();
    this.out.on('resize', this.onResize);
    this.out.write(`${TERM.altOn}${TERM.hide}${TERM.pasteOn}${TERM.mouseOn}${TERM.clear}`);
    this.draw();
  }

  /** A draw asked for: done at the next frame time, however many are asked meanwhile. */
  schedule(): void {
    if (!this.open_ || this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; this.draw(); }, FRAME_MS);
  }

  /** The terminal given back: every mode off, the main screen, the cursor shown. Safe to call more than once. */
  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    for (const t of [this.pending, this.resizing]) if (t) clearTimeout(t);
    for (const s of SIGNALS) process.removeListener(s, this.onSignal);
    process.removeListener('uncaughtException', this.onCrash);
    process.removeListener('unhandledRejection', this.onCrash);
    process.removeListener('exit', this.onExit);
    this.out.removeListener('resize', this.onResize);
    if (this.onKey) this.inp.removeListener('keypress', this.onKey);
    this.onKey = null;
    this.inp.setRawMode?.(false);
    this.inp.pause();
    this.out.write(`${TERM.mouseOff}${TERM.pasteOff}${TERM.show}${TERM.altOff}`);
  }

  private readonly onResize = (): void => {
    if (this.resizing) clearTimeout(this.resizing);
    this.resizing = setTimeout(() => { this.resizing = null; this.shown = []; this.out.write(TERM.clear); this.draw(); }, RESIZE_SETTLE_MS);
  };

  /** The frame drawn: its changed rows only, in one synchronized write, then the cursor where the input is. */
  private draw(): void {
    if (!this.open_) return;
    const { rows, cursor } = this.frame();
    const changed = rows.flatMap((row, k) => (this.shown[k] === row ? [] : [`${moveTo(k, 0)}${row}${TERM.clearLine}`]));
    const cleared = this.shown.slice(rows.length).map((_, k) => `${moveTo(rows.length + k, 0)}${TERM.clearLine}`);
    this.shown = rows;
    const tail = cursor ? `${moveTo(cursor.row, cursor.col)}${TERM.show}` : '';
    this.out.write(`${TERM.syncOn}${TERM.hide}${changed.join('')}${cleared.join('')}${tail}${TERM.syncOff}`);
  }
}
