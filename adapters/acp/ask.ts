// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * One task handed to a harness reached over ACP — `<harness>`, or
 * `<harness>:<agent>` to have it act as that agent of the project: its prompt
 * opens as the apx opens a delegation's (the compiled definition, or the
 * harness's intro naming the native file). What `agent-pack ask` and the
 * chat's `@<participant>` both run, through the ACP client.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterPlugin } from '../types.js';
import { acpHarnessNames, acpHarnessOf } from './index.js';
import { runAcp } from './client.js';
import { agentPromptHead, definitionPath, splitHarness } from '../../src/delegation.js';
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

/** The prompt that hands `task` to `agent` on `harness` — the task alone when no agent is named. */
function promptFor(o: Ask, harness: string, agent: string | null): string {
  if (!agent) return o.task;
  const inv = harnessesOf([...o.adapters]).find(row => row.name === harness)?.invocation;
  const path = inv ? definitionPath(inv, agent) : null;
  const file = path ? join(o.root, path) : null;
  if (file && !existsSync(file)) throw new Error(fill(ASK.noDefinition, { agent, file: path ?? '', harness }));
  return [...agentPromptHead(inv ?? {}, agent, file ? readFileSync(file, 'utf-8') : null), o.task].join('\n');
}

/** One task, run: the answer — or an Error saying why there is none. */
export function askHarness(o: Ask): Promise<string> {
  const { harness, agent } = targetOf(o.target);
  const found = acpHarnessOf(o.adapters, harness);
  if (!found) {
    const names = acpHarnessNames(o.adapters);
    return Promise.reject(new Error(fill(ASK.unknown, { harness, configured: names.length ? fill(ASK.configured, { names: names.join(', ') }) : ASK.noneConfigured })));
  }
  return runAcp({ harness, agent, server: found.server, project: o.root, prompt: promptFor(o, harness, agent), model: null, report: o.report, events: o.events, signal: o.signal });
}
