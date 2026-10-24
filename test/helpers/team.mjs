// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The team file as the tests write it: `EXPORT TEAM <name>:` with its MEMBER
 * line, the body lines indented one step beneath it; IMPORT lines stay in the
 * prologue, before the block. The counterpart of the old `flows.ap` lines.
 */

/** The lines of `<name>.ap` for a team of `members`, from the lines a `flows.ap` used to hold. */
export function teamSource(name, members, lines) {
  const imports = lines.filter(l => /^IMPORT\s/.test(l));
  const body = lines.filter(l => !/^IMPORT\s/.test(l));
  return [
    ...imports,
    ...(imports.length ? [''] : []),
    `EXPORT TEAM ${name}:`,
    `    MEMBER  ${members.join(', ')}`,
    ...body.map(l => (l.trim() === '' ? '' : `    ${l}`)),
  ];
}

/** The file name of a team's file. */
export const teamFileName = name => `${name}.ap`;
