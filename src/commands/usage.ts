// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** A command's usage, printed on stderr the one way every command prints it: `Usage:`, then each form, indented. */
export function printUsage(...forms: string[]): void {
  console.error('Usage:');
  for (const form of forms) console.error(`  ${form}`);
}
