// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The start quiz: the questions of the introductions an agent still reads on
 * demand — a block kind's, how to call the apx — asked as numbered lines,
 * answered `<n>=<letter>`, and graded into the introductions the agent missed,
 * each to be printed once.
 */
import { FORMULAS, fill, type QuizQuestion } from '../formulas.js';
import type { Intro } from './intro.js';

const WORDS = FORMULAS.apx.start;

/** An answer as it is given: `<n>=<letter>`. */
const ANSWER_RE = /^(\d+)=(.*)$/;

/** The letter of an option's position: a, b, c … */
const FIRST_LETTER = 'a'.charCodeAt(0);

/** The letters of a question's options, in order. */
function letters(options: readonly string[]): string[] {
  return options.map((_option, index) => String.fromCharCode(FIRST_LETTER + index));
}

/** One question of the quiz, with the introduction it tells about. */
interface QuizItem {
  intro: Intro;
  question: QuizQuestion;
}

/** What the answers earned: the line that says it, and the introductions to print — those missed, each once. */
interface Graded {
  line: string;
  missed: Intro[];
}

export class Quiz {
  private readonly items: QuizItem[];

  /** The questions of `intros`, in their order — asked of an apx run as `cmd`. */
  constructor(intros: readonly Intro[], private readonly cmd: string) {
    this.items = intros.flatMap(intro => intro.quiz.map(question => ({ intro, question })));
  }

  /** How many questions it asks. */
  get size(): number {
    return this.items.length;
  }

  /** The quiz as it is asked: how to answer it, what `?` means, then each question with its options. */
  asked(): string[] {
    return [fill(WORDS.quiz, { cmd: this.cmd, form: this.form }), fill(WORDS.unsure, { cmd: this.cmd }), ...this.lines()];
  }

  /** What the answers earned: all correct, or which ones were missed — and their introductions. */
  graded(given: ReadonlyMap<number, string>): Graded {
    const missed = this.missed(given);
    const line = missed.length === 0
      ? fill(WORDS.allCorrect, { cmd: this.cmd, count: this.size })
      : fill(WORDS.missed, { cmd: this.cmd, kinds: missed.map(intro => intro.name).join(', ') });
    return { line, missed };
  }

  /** How to answer it: `1=<a|b|c> 2=<a|b|c> …`. */
  private get form(): string {
    return this.items.map(({ question }, index) => `${index + 1}=<${letters(question.options).join('|')}>`).join(' ');
  }

  /** Each question, numbered, with what it is about, then its options on a line of their own. */
  private lines(): string[] {
    return this.items.flatMap(({ intro, question }, index) => {
      const keys = letters(question.options);
      return [
        `${index + 1}. [${intro.name}] ${question.ask}`,
        `   ${question.options.map((option, optionIndex) => `${keys[optionIndex]}) ${option}`).join('   ')}`,
      ];
    });
  }

  /** The answers given as `<n>=<letter>`, by question number — or the first argument that is none. */
  answers(args: readonly string[]): Map<number, string> | { bad: string } {
    const given = new Map<number, string>();
    for (const arg of args) {
      const match = ANSWER_RE.exec(arg);
      const questionNumber = match ? Number(match[1]) : 0;
      if (!match || questionNumber < 1 || questionNumber > this.size) return { bad: arg };
      given.set(questionNumber, match[2].trim().toLowerCase());
    }
    return given;
  }

  /** The introductions of the questions answered wrong or not at all — each once, in the quiz's order. */
  private missed(given: ReadonlyMap<number, string>): Intro[] {
    const wrong = this.items.filter(({ question }, index) => given.get(index + 1) !== question.right).map(({ intro }) => intro);
    return [...new Set(wrong)];
  }
}
