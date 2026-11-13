// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The arguments of an apx verb, read once: its flags by name, without their
 * dashes — `has('answer')` for `--answer`, `value('why')` for the text after
 * `--why`.
 */
export class ApxArgs {
  constructor(private readonly words: readonly string[]) {}

  /** Whether the flag is given: `has('answer')` for `--answer`. */
  has(flag: string): boolean {
    return this.words.includes(`--${flag}`);
  }

  /** The text after the flag, to the end of the line — undefined when the flag is absent or empty. */
  value(flag: string): string | undefined {
    const at = this.words.indexOf(`--${flag}`);
    return at >= 0 ? this.words.slice(at + 1).join(' ').trim() || undefined : undefined;
  }

  /** `--answer`: the piece ran on another harness, and its answer is the file its command wrote. */
  hasAnswer(): boolean {
    return this.has('answer');
  }

  /** `--why "<reason>"`: why what a delivery leaves out stays out. */
  why(): string | undefined {
    return this.value('why');
  }
}
