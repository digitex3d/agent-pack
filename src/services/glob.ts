// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Path globs, matched against a project-relative path written with `/`:
 * `**` any run of folders (none included), `*` any run of characters within
 * one name, `?` one character, `{a,b}` either, `[abc]` / `[!abc]` a class.
 * No imports: the apx engine bundles this module.
 */

/** A glob as an anchored RegExp over a `/`-separated relative path. */
export function globRegExp(glob: string): RegExp {
  const pattern = glob.replace(/^\.\//, '');
  let out = '';
  let braces = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index++;
      // `**/` — any folders, or none; a trailing `**` — anything below.
      if (pattern[index + 1] === '/') { index++; out += '(?:.*/)?'; } else out += '.*';
    } else if (character === '*') out += '[^/]*';
    else if (character === '?') out += '[^/]';
    else if (character === '{') { braces++; out += '(?:'; }
    else if (character === '}' && braces > 0) { braces--; out += ')'; }
    else if (character === ',' && braces > 0) out += '|';
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) { out += '\\['; continue; }
      const body = pattern.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      index = end;
    } else out += character.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a relative path matches one of the globs. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some(glob => globRegExp(glob).test(path));
}

/** A path as a glob that matches it alone — each glob character in a class of its own (`a[*].ts`). */
export function literalGlob(path: string): string {
  return path.replace(/[*?{}[]/g, character => `[${character}]`);
}
