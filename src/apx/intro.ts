// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * An introduction: how to use one thing an agent meets — a block kind, or
 * calling the apx itself — its text, compiled into the document's intros, and
 * the quiz questions that tell whether the agent already knows it. One rule
 * for every introduction: it is printed to an agent that missed one of its
 * questions, or that was asked none.
 */
import type { ApDocument } from '../apdoc/document.js';
import { FORMULAS, type QuizQuestion } from '../formulas.js';
import { CALL_TEMPLATE, callFraming } from './call.js';

/** The quiz questions of an introduction, by its name: a block kind's, or calling the apx's. */
function quizOf(name: string): readonly QuizQuestion[] {
  if (name === CALL_TEMPLATE) return FORMULAS.apx.call.quiz;
  const guides = FORMULAS.blocks as unknown as Record<string, { quiz?: QuizQuestion[] }>;
  return guides[name]?.quiz ?? [];
}

export class Intro {
  private constructor(readonly name: string, private readonly text: string, readonly quiz: readonly QuizQuestion[]) {}

  /**
   * The introductions of `names` a document gives, in order: a block kind's,
   * its text as compiled in; and how to call the apx — run as `cmd` — when the
   * document carries it, its framing line before the compiled template.
   */
  static of(doc: ApDocument, names: readonly string[], cmd: string): Intro[] {
    const texts = doc.mdSource?.intros ?? {};
    return names.flatMap(name => {
      if (name !== CALL_TEMPLATE) return [new Intro(name, texts[name] ?? '', quizOf(name))];
      const call = texts[CALL_TEMPLATE];
      return call ? [new Intro(name, `${callFraming(cmd)}\n${call}`, quizOf(name))] : [];
    });
  }

  /** Its text as the apx prints it: a heading with its name, then the text. */
  get printed(): string {
    return `\n## ${this.name}\n\n${this.text}\n`;
  }
}
