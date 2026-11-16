// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico

/** What a caught value says went wrong: an Error's message, anything else as text. */
export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
