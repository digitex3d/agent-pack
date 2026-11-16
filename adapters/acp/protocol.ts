// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** The literal values of the Agent Client Protocol the client and the chat read and write — one source each. */

/** Why a turn ended (`session/prompt`'s `stopReason`). */
export const STOP_REASON = {
  endTurn: 'end_turn',
  maxTokens: 'max_tokens',
  maxTurnRequests: 'max_turn_requests',
  refusal: 'refusal',
  cancelled: 'cancelled',
} as const;

/** How a turn's end is recorded when no stop reason says it — agent-pack's own, beside `STOP_REASON`'s. */
export const TURN_END = { none: 'none', error: 'error' } as const;

/** How a permission request is answered (`session/request_permission`'s `outcome`). */
export const PERMISSION_OUTCOME = { selected: 'selected', cancelled: 'cancelled' } as const;

/** The methods of the client's that only notify, and the kinds of update they carry (`session/update`). */
export const SESSION_UPDATE = {
  method: 'session/update', agentMessageChunk: 'agent_message_chunk', toolCall: 'tool_call', toolCallUpdate: 'tool_call_update',
  configOptions: 'config_option_update', usage: 'usage_update',
} as const;

/** The type of a piece of content that is text. */
export const TEXT_CONTENT = 'text';

/** The category, and the id, a session's config option that picks the model has. */
export const MODEL_OPTION = 'model';

/** Where a tool call is (`tool_call` / `tool_call_update`'s `status`). */
export const TOOL_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed', failed: 'failed' } as const;

/** What a tool call does (`tool_call`'s `kind`). */
export const TOOL_KIND = {
  read: 'read', edit: 'edit', delete: 'delete', move: 'move', search: 'search',
  execute: 'execute', think: 'think', fetch: 'fetch', other: 'other',
} as const;

/** A tool call's statuses once it settled. */
export const SETTLED_STATUSES: ReadonlySet<string> = new Set([TOOL_STATUS.completed, TOOL_STATUS.failed]);

/** The kinds of option a permission request offers (`session/request_permission`). */
export const OPTION_KIND = { allowOnce: 'allow_once', allowAlways: 'allow_always', rejectOnce: 'reject_once', rejectAlways: 'reject_always' } as const;
