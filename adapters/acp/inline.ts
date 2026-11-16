// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat's inline front — a pipe, or a terminal on one side only: the
 * boss's message streamed, one line per tool call once it settled, a
 * permission asked as a question, a delegated harness's lines indented under
 * `[harness]`; readline reads the lines typed.
 */
import { createInterface, type Interface } from 'node:readline';
import { BOSS_SOURCE, type ChatEvent } from './events.js';
import { Conversation, ENTRY_KIND, type Entry } from './conversation.js';
import { paint } from './ansi.js';
import { withModel } from './figures.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import type { Front, FrontHandlers } from './front.js';

/** What a delegated harness's lines start with. */
const INDENT = '    ';

/** The line an entry is shown as, once — none for a line the user typed (it is on the terminal already), or a text, streamed. */
function lineOf(e: Entry): string | null {
  switch (e.kind) {
    case ENTRY_KIND.tool: return `• ${e.title} — ${e.status}`;
    case ENTRY_KIND.verdict: return `• ${e.allowed ? 'allowed' : 'refused'}: ${e.text}`;
    case ENTRY_KIND.notice: return `• ${e.text}`;
    case ENTRY_KIND.turn: return `(turn ${e.status})`;
    case ENTRY_KIND.join: return `--> ${fill(FORMULAS.messages.chat.joined, { name: withModel(e.source, e.model) })}`;
    case ENTRY_KIND.leave: return `<-- ${fill(FORMULAS.messages.chat.removed, { name: e.source })}`;
    default: return null;
  }
}

/** The conversation as lines, as it grows: each text streamed, each other entry one line once it is done — a tool call once it settled. */
class Renderer {
  private owner: string | null = null;
  private atStart = true;
  private readonly conversation: Conversation;
  /** How much of each entry is printed: a text's characters; 1, any other's line. */
  private readonly printed = new Map<Entry, number>();

  constructor(private readonly out: (text: string) => void, private readonly dim: boolean, boss: string) {
    this.conversation = new Conversation(boss);
  }

  render(e: ChatEvent): void {
    this.conversation.apply(e);
    for (const entry of this.conversation.entries) this.print(entry);
  }

  /** Whatever line is open, closed — before a prompt or a question. */
  endLine(): void {
    if (!this.atStart) this.out('\n');
    this.atStart = true;
  }

  private print(entry: Entry): void {
    const done = this.printed.get(entry) ?? 0;
    if (entry.kind === ENTRY_KIND.text) {
      if (entry.text.length > done) this.write(entry.source, entry.text.slice(done));
      this.printed.set(entry, entry.text.length);
      return;
    }
    if (done || (entry.kind === ENTRY_KIND.tool && entry.running)) return;
    const line = lineOf(entry);
    this.printed.set(entry, 1);
    if (line && entry.kind !== ENTRY_KIND.user) this.line(entry.source, line);
  }

  private line(source: string, text: string): void {
    this.endLine();
    this.write(source, `${text}\n`);
  }

  private write(source: string, text: string): void {
    if (this.owner !== source) this.endLine();
    this.owner = source;
    const prefix = source === BOSS_SOURCE ? '' : `${INDENT}[${source}] `;
    for (const [k, piece] of text.split('\n').entries()) {
      if (k > 0) { this.out('\n'); this.atStart = true; }
      if (piece === '') continue;
      this.out(`${this.atStart && prefix ? this.paint(prefix) : ''}${source === BOSS_SOURCE ? piece : this.paint(piece)}`);
      this.atStart = false;
    }
  }

  private paint(text: string): string {
    return paint(text, { dim: true }, this.dim);
  }
}

export class InlineFront implements Front {
  private readonly renderer: Renderer;
  private readonly rl: Interface;
  private question: ((answer: string | null) => void) | null = null;
  private handlers: FrontHandlers | null = null;
  private readonly onSigint = (): void => this.handlers?.interrupt();

  constructor(private readonly o: { boss: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream & { isTTY?: boolean }; tty: boolean }) {
    this.renderer = new Renderer(text => o.output.write(text), o.output.isTTY === true, o.boss);
    this.rl = createInterface({ input: o.input, output: o.output, terminal: o.tty, prompt: '> ' });
  }

  start(intro: string, handlers: FrontHandlers): void {
    this.handlers = handlers;
    this.o.output.write(`${intro}\n`);
    this.rl.on('line', line => {
      if (!this.question) { handlers.line(line); return; }
      const answer = this.question;
      this.question = null;
      answer(line.trim().toLowerCase());
    });
    // One source of Ctrl-C: readline's on a terminal, the signal through a pipe.
    if (this.o.tty) this.rl.on('SIGINT', this.onSigint);
    else process.on('SIGINT', this.onSigint);
    this.rl.on('close', () => handlers.quit());
    this.rl.prompt();
  }

  show(e: ChatEvent): void {
    this.renderer.render(e);
  }

  busy(on: boolean): void {
    if (on) return;
    this.renderer.endLine();
    this.rl.prompt();
  }

  ask(what: string): Promise<string | null> {
    this.renderer.endLine();
    this.o.output.write(`? ${this.o.boss} asks to ${what} — allow [o]nce or [r]eject: `);
    return new Promise(resolve => { this.question = resolve; });
  }

  cancelAsk(): void {
    const answer = this.question;
    this.question = null;
    answer?.(null);
  }

  clearOrEmpty(): boolean {
    if (this.rl.line === '') return true;
    this.rl.write(null, { ctrl: true, name: 'u' });
    return false;
  }

  stop(): void {
    process.removeListener('SIGINT', this.onSigint);
    this.renderer.endLine();
    this.rl.removeAllListeners('close');
    this.rl.close();
  }
}
