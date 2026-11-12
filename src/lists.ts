// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The one list syntax of the language: wherever a line takes several items —
 * IMPORT, MEMBER, BY, a decorator's, a DOMAIN line's IN, FOR, EXPERTISE, APPLIES, ENUM[…] —
 * they are separated by commas. A comma inside `{…}` belongs to a glob
 * (`src/{api,db}/**`). Every reader of a list asks this module; none splits on
 * its own. No imports: the apx engine bundles this module.
 */

/** The lines whose list holds single words — a glob, a name, a tag: an item with a space is the old space-separated form. */
export const WORD_LIST_LINES: readonly string[] = ['FOR', 'EXPERTISE', 'APPLIES', 'MEMBER', 'TEAMS'];

/** The items of a list, trimmed, empty ones dropped. */
export function splitList(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let item = '';
  for (const c of text) {
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    if (c === ',' && depth === 0) { items.push(item); item = ''; }
    else item += c;
  }
  items.push(item);
  return items.map(s => s.trim()).filter(Boolean);
}

/**
 * Why a list of single words is not written as one — an item holding a space,
 * the old space-separated form — with the line to write instead; null when it
 * is a list. `head` is how the line opens (`FOR`, `ENUM[`), `tail` how it closes.
 */
export function spacedListError(head: string, text: string, tail = ''): string | null {
  const items = splitList(text);
  if (!items.some(item => /\s/.test(item))) return null;
  const words = items.flatMap(item => item.split(/\s+/));
  return `\`${head}${head.endsWith('[') ? '' : ' '}${text.trim()}${tail}\`: separate the items with commas — \`${head}${head.endsWith('[') ? '' : ' '}${words.join(', ')}${tail}\``;
}
