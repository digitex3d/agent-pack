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
  const g = glob.replace(/^\.\//, '');
  let out = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      // `**/` — any folders, or none; a trailing `**` — anything below.
      if (g[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { braces++; out += '(?:'; }
    else if (c === '}' && braces > 0) { braces--; out += ')'; }
    else if (c === ',' && braces > 0) out += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end < 0) { out += '\\['; continue; }
      const body = g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      out += `[${body}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a relative path matches one of the globs. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some(glob => globRegExp(glob).test(path));
}
