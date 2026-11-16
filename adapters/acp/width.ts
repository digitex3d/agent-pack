// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * How wide a text is on a terminal, and the text wrapped to a width — without
 * a dependency: graphemes from `Intl.Segmenter`, and a heuristic for their
 * width. Two columns: the Han, Hangul, Hiragana and Katakana scripts, CJK
 * punctuation and fullwidth forms, and emoji shown as emoji
 * (`Emoji_Presentation`); none: marks, controls and format characters (a
 * zero-width joiner, a variation selector); one: everything else.
 */
import { stripVTControlCharacters } from 'node:util';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WIDE_RE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Emoji_Presentation}　-〿！-｠￠-￦]/u;
const ZERO_RE = /^[\p{Mark}\p{Cc}\p{Cf}]+$/u;
const WIDE = 2;

/** A text's graphemes — what a cursor steps over, one at a time. */
export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map(s => s.segment);
}

/** The columns one grapheme takes. */
export function graphemeWidth(g: string): number {
  if (ZERO_RE.test(g)) return 0;
  return WIDE_RE.test(g) ? WIDE : 1;
}

/** The columns a text takes — no escape codes in it. */
export function textWidth(text: string): number {
  return graphemes(text).reduce((w, g) => w + graphemeWidth(g), 0);
}

/** A text cut into pieces of at most `width` columns, grapheme by grapheme. */
export function chop(text: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width && piece !== '') { pieces.push(piece); piece = ''; used = 0; }
    piece += g;
    used += w;
  }
  return [...pieces, piece];
}

/** One paragraph wrapped at its spaces; a word wider than the line is cut. */
function wrapParagraph(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(/(\s+)/).filter(Boolean)) {
    const next = `${line}${word}`;
    if (textWidth(next) <= width) { line = next; continue; }
    if (line.trim() !== '') lines.push(line.trimEnd());
    const pieces = /^\s+$/.test(word) ? [''] : chop(word, width);
    lines.push(...pieces.slice(0, -1));
    line = pieces[pieces.length - 1];
  }
  return [...lines, line];
}

/** A text wrapped to `width` columns: each of its lines, wrapped at spaces. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  return text.split('\n').flatMap(p => wrapParagraph(p, w));
}

/** A text made exactly `width` columns: cut, then padded with spaces. */
export function fit(text: string, width: number): string {
  const cut = chop(text, Math.max(0, width))[0];
  return `${cut}${' '.repeat(Math.max(0, width - textWidth(cut)))}`;
}

/** A painted text padded with spaces to `width` columns — its escape codes take none. */
export function padPainted(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - textWidth(stripVTControlCharacters(text))))}`;
}
