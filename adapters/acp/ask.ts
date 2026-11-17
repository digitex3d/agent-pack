// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * One task handed to a harness reached over ACP — `<harness>`, or
 * `<harness>:<agent>` to have it act as that agent of the project: its prompt
 * opens as the apx opens a delegation's, with the harness's intro naming the
 * agent's native file — the one its adapter wrote, found in the project root.
 * What `agent-pack ask` and the chat's `@<participant>` both run, through the
 * ACP client.
 */
import type { AdapterPlugin } from '../types.js';
import { acpHarnessNames, acpHarnessOf } from './index.js';
import { runAcp } from './client.js';
import { agentPromptHead, splitHarness, unnamedAgent, type HarnessInvocation } from '../../src/delegation.js';
import { harnessesOf } from '../../src/harnesses.js';
import { FORMULAS, fill } from '../../src/formulas.js';

const ASK = FORMULAS.messages.ask;

export interface Ask {
  adapters: readonly AdapterPlugin[];
  /** The folder the agent works in: its session's cwd and its perimeter. */
  root: string;
  /** `<harness>` or `<harness>:<agent>`. */
  target: string;
  task: string;
  report: (line: string) => void;
  /** The chat's events file, when the chat itself asks. */
  events?: string;
  signal?: AbortSignal;
}

/** A target read: its harness, and its agent — null when it names none. */
export function targetOf(target: string): { harness: string; agent: string | null } {
  return splitHarness(target) ?? { harness: target, agent: null };
}

/** The recipe of `harness` among the config's adapters — empty when it has none. */
function invocationOf(o: Ask, harness: string): Partial<HarnessInvocation> {
  return harnessesOf([...o.adapters]).find(row => row.name === harness)?.invocation ?? {};
}

/** The prompt that hands `task` to `agent` on `harness` — the task alone when no agent is named. */
function promptFor(o: Ask, harness: string, agent: string | null): string {
  return agent ? [...agentPromptHead(invocationOf(o, harness), agent), o.task].join('\n') : o.task;
}

/** One task, run: the answer — or an Error saying why there is none. */
export function askHarness(o: Ask): Promise<string> {
  const { harness, agent } = targetOf(o.target);
  const found = acpHarnessOf(o.adapters, harness);
  if (!found) {
    const names = acpHarnessNames(o.adapters);
    return Promise.reject(new Error(fill(ASK.unknown, { harness, configured: names.length ? fill(ASK.configured, { names: names.join(', ') }) : ASK.noneConfigured })));
  }
  const unnamed = agent ? unnamedAgent(invocationOf(o, harness), agent, harness) : null;
  if (unnamed) return Promise.reject(new Error(unnamed));
  return runAcp({ harness, agent, server: found.server, project: o.root, prompt: promptFor(o, harness, agent), model: null, report: o.report, events: o.events, signal: o.signal });
}
