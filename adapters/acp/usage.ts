// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * What an agent reports of itself over ACP, read one way: the model it runs
 * on (`session/new`'s `models.currentModelId`, or its model config option's
 * current value — and a `config_option_update` later), and what a turn cost
 * (`session/prompt`'s `usage`: its tokens; `usage_update`'s `cost`, the
 * session's spend so far). An agent that reports nothing has nothing here —
 * never a zero standing in for it.
 */
import { list, obj, str, type Params } from './rpc.js';
import { MODEL_OPTION } from './protocol.js';

/** One turn's usage, as a `usage` event holds it (its text, as JSON): tokens, and the cost when one was reported. */
export interface Usage {
  input: number;
  output: number;
  total: number;
  cost?: number;
  currency?: string;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The model an agent says it runs on — in a `session/new` answer or a config update — null when it says none. */
export function reportedModel(said: Params): string | null {
  const option = list(said.configOptions).map(obj).find(entry => entry.category === MODEL_OPTION || entry.id === MODEL_OPTION);
  return str(option?.currentValue) ?? str(obj(said.models).currentModelId);
}

/** The tokens of a `session/prompt` answer's `usage` — null when it reports none. */
export function promptUsage(answer: Params): Usage | null {
  const usage = obj(answer.usage);
  if (Object.keys(usage).length === 0) return null;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  return { input, output, total: count(usage.totalTokens) || input + output };
}

/** A `usage` event's text, read — null when it is none. */
export function usageOf(text: string): Usage | null {
  let value: unknown;
  // A text that is no JSON is no usage: nothing to add.
  try { value = JSON.parse(text); } catch { return null; }
  const read = obj(value);
  const spent = typeof read.cost === 'number' ? { cost: read.cost, currency: str(read.currency) ?? 'USD' } : {};
  return { input: count(read.input), output: count(read.output), total: count(read.total), ...spent };
}

/** Two usages, added. */
export function addUsage(before: Usage | undefined, more: Usage): Usage {
  if (!before) return more;
  const spent = before.cost !== undefined || more.cost !== undefined
    ? { cost: (before.cost ?? 0) + (more.cost ?? 0), currency: more.currency ?? before.currency }
    : {};
  return { input: before.input + more.input, output: before.output + more.output, total: before.total + more.total, ...spent };
}
