// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The action verbs — who carries a line out: DO the agent, ASK a delegate a
 * question (an agent's), DELEGATE someone else the work (a flow's, a unit's —
 * src/delegation.ts), COMPUTE a program (src/executor.ts). Every list of
 * what a body admits spreads it. A leaf module: the lexer, the variables and
 * the lint all read it.
 */
export const ACTION_VERBS = ['DO', 'ASK', 'DELEGATE', 'COMPUTE'] as const;
