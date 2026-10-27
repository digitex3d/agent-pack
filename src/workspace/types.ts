// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The workspace engine — where the instances of a team's contracts do their
 * work. Each instance works in a copy of its own: the copy shows what the
 * assignee reads, `deliver` keeps what the contract lets it write (and says
 * what it left out), `merge` folds a delivery into the session's result,
 * `land` brings the result back to the working folder as uncommitted changes.
 * What the engine does underneath (git today) is the adapter's alone.
 *
 * A session runs in rounds: each `dispatch` of the lead opens copies from a
 * base — the working folder as it is then, uncommitted changes included —
 * and before a new base is taken, what was merged since the last one lands.
 *
 * Paths and globs are written from the project root with `/`, as a DOMAIN's
 * FOR writes them. No imports: the apx engine bundles this module.
 */

/** What a copy shows: what its assignee reads and writes. */
export interface Perimeter {
  /** The globs the copy shows — null: every tracked file, and nothing git ignores. */
  reads: string[] | null;
  /** The globs the assignee writes; the copy shows them too. */
  writes: string[];
}

/**
 * What a delivery may keep — the contract's WITHIN: the files its globs admit.
 * `marks` delimit the zones: lines holding `open` and `close` around each one,
 * in `files`. They never reach the result — the delivery drops them — and
 * with `only`, the delivery keeps of those files the zones alone: the copy's
 * text between the marks, the base's everywhere else.
 */
export interface Allowed {
  globs: string[];
  marks?: { open: string; close: string; files: string[]; only: boolean };
}

/** What a delivery kept, what it left out, and what changed in the working folder instead of the copy. */
export interface Delivery {
  committed: string[];
  /** A path, or a path and why part of it stayed out: `src/a.ts (outside its zones)`. */
  leftOut: string[];
  /** Files the allowed globs admit that changed in the working folder since the base — work done outside the copy. */
  strayed: string[];
  /** Zoned files whose marks the copy no longer holds as the base did — and why: nothing of them can be delivered. */
  lostZones: string[];
}

/** A merge folded in, or the files that conflict. */
export type MergeResult = { merged: true } | { merged: false; conflicts: string[] };

/** The files the working folder took, or the files that conflict with what changed there meanwhile — nothing is written then. */
export type LandResult = { landed: string[] } | { conflicts: string[] };

/** Who wins a conflict: the result merged so far, or the delivery being merged. */
export type Prefer = 'ours' | 'theirs';

/** The workspaces of one session of one project. */
export interface WorkspaceSession {
  /** Where an instance's copy is, from the project root. */
  path(ctr: string): string;
  /** Open an instance's copy from the session's base — the first open takes it. */
  open(ctr: string, perimeter: Perimeter): void;
  /** Keep what the copy changed inside `allowed`; `dryRun` says what it would keep and commits nothing. */
  deliver(ctr: string, allowed: Allowed, opts?: { dryRun?: boolean }): Delivery;
  /** Fold a delivery into the session's result. */
  merge(ctr: string, prefer?: Prefer): MergeResult;
  /**
   * Bring what was merged since the base to the working folder as uncommitted
   * changes; the working folder then is the next base. `close`: the session
   * ends — every copy goes.
   */
  land(opts?: { close?: boolean }): LandResult;
}

export interface WorkspaceEngine {
  type: 'workspace';
  name: string;
  session(projectRoot: string, sessionId: string): WorkspaceSession;
}
