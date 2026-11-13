// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
export function numberSteps(body: string): string {
  const counters = new Map<string, number>();
  return body.split('\n').map(line => {
    const match = line.match(/^(\s*)STEP\s+(.+)$/);
    if (!match) return line;
    const indent = match[1];
    const stepNumber = (counters.get(indent) || 0) + 1;
    counters.set(indent, stepNumber);
    return `${indent}${stepNumber}. ${match[2]}`;
  }).join('\n');
}
