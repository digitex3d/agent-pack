// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The action verbs — who carries a line out: DO the agent, DELEGATE someone
 * else (src/delegation.ts), COMPUTE a program (src/executor.ts). Every list of
 * what a body admits spreads it. A leaf module: the lexer, the variables and
 * the lint all read it.
 */
export const ACTION_VERBS = ['DO', 'DELEGATE', 'COMPUTE'] as const;
