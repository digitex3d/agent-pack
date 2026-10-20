// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * agent-pack's logo as agent-pack.org draws it, in its own pixels: the mascot
 * (`.mascot`, 16 × 14) and the wordmark (`.pixel-wordmark`, 76 × 11) with
 * the site's colours. On a terminal two pixel rows make one line: filled cells
 * as backgrounds, half cells as half blocks (▀ ▄); without colour, the half
 * blocks alone (▀ ▄ █).
 */
import type { PackageInfo } from '../../src/config.js';

type Rgb = [number, number, number];

/** The wordmark's pixels, row by row: 0 empty, 1–5 the tone. */
const WORDMARK: readonly string[] = [
  '00000000000000000000000000000000011000000000000000000000000000000000011',
  '00000000000000000000000000000000011000000000000000000000000000000000011',
  '0111110001111110011111001111110011111100000001111110001111100011111001100011',
  '000002202200022022000220220002200220000000000220002200000022022000220220022',
  '00000220220002202200022022000220022000000000022000220000002202200000022022',
  '0333333033000330333333303300033003300000333303300033003333330330000003333',
  '44000440440004404400000044000440044000000000044000440440004404400000044044',
  '440004400444444044000440440004400440000000000440004404400044044000440440044',
  '0555555000000550055555005500055000555500000005555550005555550055555005500055',
  '00000000000005500000000000000000000000000000055',
  '00000000555555000000000000000000000000000000055',
];

/** The mascot's pixels, row by row: 0 empty, f fur, p plate, a accent, v visor. */
const MASCOT: readonly string[] = [
  '0000000a',
  '0000000p',
  '00f000000000f',
  '0fff00ppp00fff',
  '0fffffffffffff',
  'fffffffffffffff',
  'ffvvavfffvvavff',
  'fffffffppffffff',
  '0ffffffppfffff',
  '00fffffffffff0ff',
  '00pfffffffffpfff',
  '00pffpppppffpff',
  '00fffffffffffff',
  '00ff00ff00ff',
];

/**
 * The site's colours: the wordmark's tones top to bottom (`--color-wordmark-1`
 * … `-5`), and the mascot's parts. The visor (`--color-bg-deep`, the page's
 * own black) is no colour here: the terminal's background shows through.
 */
const COLORS: Record<string, Rgb | null> = {
  1: [0xee, 0xf2, 0xfc],
  2: [0xc0, 0xc6, 0xd2],
  3: [0x97, 0xa1, 0xb4],
  4: [0x73, 0x81, 0x9a],
  5: [0x58, 0x63, 0x79],
  f: [0xee, 0xf2, 0xfc],
  p: [0x3b, 0x45, 0x58],
  a: [0x3f, 0x9c, 0xf6],
  v: null,
};

const RESET = '\x1b[0m';
const fg = (c: Rgb) => `\x1b[38;2;${c.join(';')}m`;
const bg = (c: Rgb) => `\x1b[48;2;${c.join(';')}m`;
const sgr = (ink: Rgb | null, paper: Rgb | null) => `${RESET}${ink ? fg(ink) : ''}${paper ? bg(paper) : ''}`;

/**
 * A picture as lines of text, two pixel rows a line — `width` columns, padded.
 * A cell filled with one colour is a background — no glyph narrower than the
 * cell to leave a stripe; a half-filled or two-colour cell is a half block on
 * it (▀ ▄). A run of cells of the same colours is written as one piece of
 * text, so a terminal draws it as one rectangle, with no seam inside.
 */
function draw(pixels: readonly string[], color: boolean): string[] {
  const width = Math.max(...pixels.map(r => r.length));
  const at = (row: number, col: number): Rgb | null => COLORS[pixels[row]?.[col] ?? '0'] ?? null;
  const lines: string[] = [];
  for (let row = 0; row < pixels.length; row += 2) {
    let line = '';
    let style = '';
    for (let col = 0; col < width; col++) {
      const t = at(row, col), b = at(row + 1, col);
      if (!color) { line += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; continue; }
      // [glyph, its colour, the cell's background]
      const [glyph, ink, paper]: [string, Rgb | null, Rgb | null] =
        t && b ? (t === b ? [' ', null, t] : ['▀', t, b]) : t ? ['▀', t, null] : b ? ['▄', b, null] : [' ', null, null];
      const next = ink || paper ? sgr(ink, paper) : RESET;
      if (next !== style) { line += next === RESET && !style ? '' : next; style = next === RESET ? '' : next; }
      line += glyph;
    }
    lines.push(style ? `${line}${RESET}` : line);
  }
  return lines;
}

/** The wordmark as lines of text. */
export function logo({ color = true }: { color?: boolean } = {}): string[] {
  return draw(WORDMARK, color);
}

/** The mascot as lines of text. */
export function mascot({ color = true }: { color?: boolean } = {}): string[] {
  return draw(MASCOT, color);
}

/**
 * A pre-release until 1.0, or while the version carries a pre-release tag
 * (`1.2.0-beta.1`) — semver's own reading: 0.x is initial development.
 */
export function isPreRelease(version: string): boolean {
  return /^0\./.test(version) || /-/.test(version);
}

export interface BannerOptions {
  color?: boolean;
  /** The terminal's width: the mascot sits beside the wordmark when both fit. */
  columns?: number;
  /** Where to read more and report issues — the help's; the build shows the rest only. */
  links?: boolean;
}

/**
 * The mascot and the wordmark — side by side when `columns` leave room for
 * both, the mascot above otherwise — then what agent-pack is: its version,
 * marked pre-release while it is one, what it does, who made it under which
 * licence and its site; with `links`, its docs and where to report issues.
 */
export function banner(info: PackageInfo, { color = true, columns = 80, links = false }: BannerOptions = {}): string[] {
  const paint = (rgb: Rgb, text: string) => (color ? `${fg(rgb)}${text}${RESET}` : text);
  const muted = (text: string) => paint(COLORS[3]!, text);
  const strong = (text: string) => paint(COLORS[1]!, text);
  const accent = (text: string) => paint(COLORS.a!, text);
  const pre = isPreRelease(info.version) ? ` ${muted('· pre-release')}` : '';
  // The description's first sentence beside the version, the rest beneath it.
  const [what, ...more] = info.description.split(/(?<=\.) /);
  const about = [
    ` ${strong(`v${info.version}`)}${pre}  ${what}`,
    ...(more.length ? [` ${muted(more.join(' '))}`] : []),
    ` ${muted('by')} ${info.author} ${muted('·')} ${info.license} ${muted('·')} ${accent(info.homepage)}`,
    ...(links ? ['', ` ${muted('docs  ')} ${accent(`${info.repository}/tree/main/docs`)}`, ` ${muted('issues')} ${accent(info.issues)}`] : []),
  ];
  const pet = mascot({ color }), word = logo({ color });
  const petWidth = Math.max(...MASCOT.map(r => r.length));
  if (columns < petWidth + 3 + Math.max(...WORDMARK.map(r => r.length))) {
    return [...pet, '', ...word.map(l => l.replace(/ +$/, '')), '', ...about];
  }
  // The wordmark sits level with the mascot's body, one line below its antenna.
  const art = pet.map((line, i) => `${line}   ${word[i - 1] ?? ''}`.replace(/ +$/, ''));
  return [...art, '', ...about];
}
