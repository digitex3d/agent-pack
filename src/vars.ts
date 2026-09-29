// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
export function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
