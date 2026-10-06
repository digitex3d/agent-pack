// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The judge lock (`agent-pack.judge.lock`, project root, meant for git): the
 * decisions a build depends on and no machine takes — which judge, its pinned
 * model, and the verdicts a human wrote.
 *
 *   { "version": 1, "judge": "jev", "model": "<pinned>",
 *     "decisions": { "<key>": { "p": 1, "by": "human" } } }
 *
 * A key is a short hash of the check (id + statement) and the line text — the
 * file never reveals either, and editing the rule or the line invalidates it.
 * The judge writes the lock only to pin the model from its first answer; after
 * that only humans edit it. A decision wins over any machine verdict.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { JudgeCheck } from './types.js';
import { sha256Hex } from '../apdoc/ids.js';

/** A human decision on one check of one line text. */
export interface Decision {
  p: number;
  by?: 'human';
}

interface LockData {
  version: 1;
  judge: string;
  model: string | null;
  decisions: Record<string, Decision>;
}

/** The key of one check on one line text. */
export function verdictKey(check: JudgeCheck, text: string): string {
  return sha256Hex(`${check.id}\n${check.statement}\n${text}`).slice(0, 16);
}

/** Whether `p` is a probability. */
export function isProbability(p: unknown): p is number {
  return typeof p === 'number' && p >= 0 && p <= 1;
}

export class JudgeLock {
  private constructor(private readonly path: string, private readonly data: LockData, private readonly pinnedOnLoad: boolean) {}

  /** Read the lock — no model and no decision when it does not exist yet. */
  static load(path: string, judge: string): JudgeLock {
    if (!existsSync(path)) return new JudgeLock(path, { version: 1, judge, model: null, decisions: {} }, false);
    let data: LockData;
    try {
      data = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new Error(`Invalid JSON in the judge lock ${path}: ${(err as Error).message}`);
    }
    if (data?.version !== 1 || typeof data.decisions !== 'object' || data.decisions === null) {
      throw new Error(`The judge lock ${path} is not a version 1 judge lock`);
    }
    for (const [key, v] of Object.entries(data.decisions)) {
      if (!isProbability((v as Decision | null)?.p)) {
        throw new Error(`The judge lock ${path}: the decision "${key}" has no p between 0 and 1`);
      }
    }
    // Another judge's pinned model is not this judge's: it is pinned again.
    const model = data.judge === judge && typeof data.model === 'string' ? data.model : null;
    return new JudgeLock(path, { version: 1, judge, model, decisions: data.decisions }, model !== null);
  }

  /** The pinned model, or null until the first answer. */
  get model(): string | null {
    return this.data.model;
  }

  get judge(): string {
    return this.data.judge;
  }

  /** Every decision, read-only. */
  get decisions(): Readonly<Record<string, Decision>> {
    return this.data.decisions;
  }

  /** Pin the model, once. */
  pin(model: string): void {
    this.data.model ??= model;
  }

  /** The human decision for a key, or null. */
  decision(key: string): Decision | null {
    return this.data.decisions[key] ?? null;
  }

  /** Write the lock when this run pinned its model — the only write the judge ever makes to it. */
  save(): void {
    if (this.pinnedOnLoad || this.data.model === null) return;
    const keys = Object.keys(this.data.decisions).sort();
    const out = {
      version: 1,
      judge: this.data.judge,
      model: this.data.model,
      decisions: Object.fromEntries(keys.map(k => [k, this.data.decisions[k]])),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  }
}
