// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
export function numberSteps(body: string): string {
  const counters = new Map<string, number>();
  return body.split('\n').map(line => {
    const m = line.match(/^(\s*)STEP\s+(.+)$/);
    if (!m) return line;
    const indent = m[1];
    const n = (counters.get(indent) || 0) + 1;
    counters.set(indent, n);
    return `${indent}${n}. ${m[2]}`;
  }).join('\n');
}
