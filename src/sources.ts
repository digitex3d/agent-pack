// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The source registry — the ONE place a compilation reads `.ap` files.
 *
 * One instance per compilation (`ctx.sources`): each path is read once, its
 * `parseBlocks` tree computed lazily once. Returned texts and trees are shared
 * and read-only — no caller mutates them.
 *
 * It also answers where a block was written: `span()` gives a block's header
 * line and its original lines, and `align()` maps each line of the block's
 * cleaned body back onto them. The transformations a body goes through before
 * the builder walks it (dedent, metadata strip, STEP numbering, `{{var}}`
 * substitution, IMPORT expansion) only delete lines or rewrite inside a line —
 * never reorder — so an in-order scan finds every surviving line.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseBlocks, ParseResult, Block } from './parseBlocks.js';
import type { ApPos } from './apdoc/types.js';

/** How a path becomes text — the file on disk by default, an editor's buffer tomorrow. */
export type SourceReader = (path: string) => string;

/** One line of a file, as written: its 1-based number and its original text. */
export interface SourceLine {
  line: number;
  text: string;
}

/**
 * Where a block was written: its file, its header line, and the file lines its
 * text was composed from, in order. A plain block is its consecutive lines from
 * the header on; a text composed from pieces of a file (an agent: the lines
 * outside its exported blocks, then the AGENT block) lists exactly those.
 */
export interface SourceSpan {
  file: string;
  /** 1-based line of the header (1 for a whole legacy file). */
  line: number;
  /** The file lines the block's text was composed from, in order. */
  lines: SourceLine[];
}

export class SourceRegistry {
  private texts = new Map<string, string>();
  private trees = new Map<string, ParseResult>();

  constructor(private readonly reader: SourceReader = path => readFileSync(path, 'utf-8')) {}

  /** The text of a file, read once. */
  read(path: string): string {
    const key = resolve(path);
    let text = this.texts.get(key);
    if (text === undefined) {
      text = this.reader(key);
      this.texts.set(key, text);
    }
    return text;
  }

  /** The parsed blocks of a file, parsed once. */
  tree(path: string): ParseResult {
    const key = resolve(path);
    let tree = this.trees.get(key);
    if (!tree) {
      tree = parseBlocks(this.read(key));
      this.trees.set(key, tree);
    }
    return tree;
  }

  /**
   * The top-level `<KIND> <name>` block of a file, from its header to the next
   * top-level block (or EOF). A legacy file without EXPORT blocks is one unit:
   * the whole file, from line 1. Null when the file or the block is not there.
   */
  span(path: string, kind: string, name: string): SourceSpan | null {
    let text: string;
    try {
      text = this.read(path);
    } catch {
      return null;
    }
    const blocks = this.tree(path).blocks;
    const key = kind.toUpperCase();
    const block = blocks.find(b => b.key === key && b.name === name);
    if (block) return this.blockSpan(path, block);
    if (blocks.some(b => b.exported)) return null;
    return { file: resolve(path), line: 1, lines: numbered(text.split(/\r?\n/), 1) };
  }

  /** One top-level block of a file: its header to the line before the next top-level block (any kind), or EOF. */
  blockSpan(path: string, block: Block): SourceSpan {
    const lines = this.read(path).split(/\r?\n/);
    const next = this.tree(path).blocks.find(b => b.startLine > block.startLine);
    const end = next ? next.startLine - 1 : lines.length;
    return { file: resolve(path), line: block.startLine, lines: numbered(lines.slice(block.startLine - 1, end), block.startLine) };
  }
}

/** Consecutive file lines, the first one numbered `from`. */
function numbered(lines: string[], from: number): SourceLine[] {
  return lines.map((text, i) => ({ line: from + i, text }));
}

/**
 * For each line of a cleaned body, the file line it came from. Scans the span
 * in order: a body line matches the first span line at or after the previous
 * match whose text is the same once trimmed — a `STEP` head may have become a
 * number (`1. …`), a `{{var}}` its value. A line with no match (blank, or
 * inserted by an IMPORT) takes the last matched line; before any match, the
 * block's header line.
 */
export function align(bodyLines: readonly string[], span: SourceSpan): number[] {
  const patterns = span.lines.map(l => linePattern(l.text));
  let cursor = 0;
  let last = span.line;
  return bodyLines.map(raw => {
    const text = raw.trim();
    if (text === '') return last;
    for (let j = cursor; j < patterns.length; j++) {
      if (patterns[j]?.test(text)) {
        cursor = j + 1;
        last = span.lines[j].line;
        return last;
      }
    }
    return last;
  });
}

/** The position of a file line of a span: the first non-blank column, and just past the last. */
export function positionOf(span: SourceSpan, line: number): ApPos {
  const text = span.lines.find(l => l.line === line)?.text ?? '';
  return { line, col: text.length - text.trimStart().length + 1, endCol: text.trimEnd().length + 1 };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a source line may have become in a cleaned body — null for a blank line. */
function linePattern(line: string): RegExp | null {
  const text = line.trim();
  if (text === '') return null;
  const step = /^STEP\s+/.exec(text);
  const head = step ? '(?:STEP\\s+|\\d+\\.\\s+)' : '';
  const rest = (step ? text.slice(step[0].length) : text)
    .split(/\{\{\w+\}\}/)
    .map(escape)
    .join('[\\s\\S]*?');
  return new RegExp(`^${head}${rest}$`);
}
