// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Git as the workspace engine — the only place that knows git.
 *
 * Nothing the developer sees changes: no branch, no commit on a branch, no
 * touch to the index. A session lives in hidden refs under
 * `refs/agent-pack/<session>/`:
 *
 *   base     the working folder at the latest round, uncommitted changes
 *            included (a temporary index, `write-tree`, `commit-tree`) — each
 *            round's base the child of the one before
 *   merged   the round's result: its base, then each merged delivery
 *   <ctr>    an instance's delivery — its copy's base plus what it kept
 *
 * A copy is a detached worktree at `.agent-pack/work/<ctr>`, with a sparse
 * checkout of its reads. What git ignores (node_modules…) never reaches a copy
 * through git: a path its reads cover is linked from the project root — and,
 * in a copy that reads every tracked file, the dependency folders, so the
 * project's own checks run there (`npx tsc`, `vitest`…). The
 * runtime folder (`.agent-pack`, the apx and the session state) is linked in
 * every copy, so an assignee runs its apx from there.
 *
 * `merge` is `merge-tree --write-tree`, which touches no folder; `land` merges
 * the result into a snapshot of the working folder as it is now, and writes
 * only the files that change — through a temporary index, never the real one.
 * A delivery limited to lines keeps only the hunks inside them (`diff -U0`,
 * `apply --cached`); the others are left out.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RUNTIME_DIR, WORK_DIR } from '../../src/apx/paths.js';
import { globRegExp, matchesAnyGlob } from '../../src/services/glob.js';
import type { Allowed, Delivery, LandResult, MergeResult, Perimeter, Prefer, WorkspaceEngine, WorkspaceSession } from '../../src/workspace/types.js';

/** The oldest git with `merge-tree --write-tree`. */
const MIN_GIT: [number, number] = [2, 38];

/** Who signs the commits of the hidden refs — never the developer. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'agent-pack', GIT_AUTHOR_EMAIL: 'agent-pack@localhost',
  GIT_COMMITTER_NAME: 'agent-pack', GIT_COMMITTER_EMAIL: 'agent-pack@localhost',
};

/** The folders git ignores that a copy reading every tracked file still links: what the project's tools need to run. */
const DEPENDENCY_FOLDERS = new Set(['node_modules', 'vendor', '.venv']);

/** A name that becomes part of a ref and of a folder: a session id, an instance id. */
const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** What a copy keeps about itself, in its own git folder. */
interface CopyState {
  session: string;
  /** The base the copy opened from. */
  base: string;
  /** The paths of the copy that are links to the project root — never delivered, never left out. */
  links: string[];
}

interface Run { code: number; out: string; err: string }

function run(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Run {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', input, env: { ...process.env, ...IDENTITY, ...env }, maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`git cannot be run: ${r.error.message}`);
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  const r = run(cwd, args, env, input);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

function lines(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

let gitChecked = false;
function checkGit(): void {
  if (gitChecked) return;
  const m = /(\d+)\.(\d+)/.exec(git(process.cwd(), ['--version']));
  const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new Error(`the git workspace needs git ${MIN_GIT.join('.')} or later — found ${m ? m[0] : 'an unknown version'}`);
  }
  gitChecked = true;
}

/** `{a,b}` expanded — neither sparse patterns nor pathspecs know braces. */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1].split(',').flatMap(alt => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

function clean(glob: string): string {
  return glob.replace(/^\.?\//, '');
}

/** The folders of a glob before its first wildcard: `node_modules/react/**` → `node_modules/react`. */
function literalPrefix(glob: string): string {
  const parts = clean(glob).split('/');
  const at = parts.findIndex(p => /[*?[{]/.test(p));
  return (at < 0 ? parts : parts.slice(0, at)).join('/');
}

/** The zones of a text: the lines between each `open` mark and the `close` that follows — or why they cannot be read. */
function regions(text: string[], marks: { open: string; close: string }): [number, number][] | string {
  const out: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i].includes(marks.close)) {
      if (open < 0) return `a closing mark at line ${i + 1} with no opening one before it`;
      out.push([open, i]);
      open = -1;
    } else if (text[i].includes(marks.open)) {
      if (open >= 0) return `two opening marks, lines ${open + 1} and ${i + 1}`;
      open = i;
    }
  }
  return open >= 0 ? `an opening mark at line ${open + 1} with no closing one` : out;
}

/**
 * A zoned file as delivered: the marks dropped; with `only`, the copy's text
 * between them and the base's everywhere else (`outside`: the copy changed
 * that too). `gone`: the copy's marks no longer match the base's.
 */
function zoneText(baseText: string, copyText: string, marks: { open: string; close: string; only: boolean }): { text: string; outside: boolean } | { gone: string } {
  const strip = (lines: string[]) => lines.filter(l => !l.includes(marks.open) && !l.includes(marks.close));
  const copy = copyText.split('\n');
  if (!marks.only) return { text: strip(copy).join('\n'), outside: false };
  const base = baseText.replace(/\n$/, '').split('\n');
  const inBase = regions(base, marks);
  const inCopy = regions(copy, marks);
  if (typeof inCopy === 'string') return { gone: `its marks: ${inCopy}` };
  if (typeof inBase === 'string' || inBase.length !== inCopy.length) return { gone: `${inCopy.length} of its ${inBase.length} zone${inBase.length === 1 ? '' : 's'} left` };
  const pieces = (text: string[], zones: [number, number][]) => {
    const outside: string[][] = [];
    const inside: string[][] = [];
    let from = 0;
    for (const [open, close] of zones) { outside.push(text.slice(from, open)); inside.push(text.slice(open + 1, close)); from = close + 1; }
    outside.push(text.slice(from));
    return { outside, inside };
  };
  const b = pieces(base, inBase);
  const c = pieces(copy, inCopy);
  const same = (x: string[], y: string[]) => x.join('\n').replace(/\n+$/, '') === y.join('\n').replace(/\n+$/, '');
  const outside = b.outside.some((piece, i) => !same(piece, c.outside[i]));
  const text = b.outside.flatMap((piece, i) => [...piece, ...(i < c.inside.length ? c.inside[i] : [])]);
  return { text: `${text.join('\n')}\n`, outside };
}

class GitSession implements WorkspaceSession {
  private readonly root: string;
  private readonly ns: string;

  constructor(projectRoot: string, private readonly session: string) {
    if (!SAFE_NAME.test(session)) throw new Error(`"${session}" is no session id`);
    checkGit();
    this.root = realpathSync(projectRoot);
    const top = run(this.root, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) throw new Error(`${this.root} is not a git repository — the copies of the contracts need one: git init`);
    if (realpathSync(top.out.trim()) !== this.root) throw new Error(`the project root ${this.root} is not the root of its git repository (${top.out.trim()})`);
    this.ns = `refs/agent-pack/${session}`;
  }

  path(ctr: string): string {
    if (!SAFE_NAME.test(ctr)) throw new Error(`"${ctr}" is no instance id`);
    return `${WORK_DIR}/${ctr}`;
  }

  open(ctr: string, perimeter: Perimeter): void {
    const dir = join(this.root, this.path(ctr));
    if (existsSync(dir)) throw new Error(`${ctr} has a copy already: ${this.path(ctr)}`);
    const base = this.base();
    const reads = perimeter.reads === null ? null : [...perimeter.reads, ...perimeter.writes].flatMap(expandBraces).map(clean);
    git(this.root, ['worktree', 'add', '--no-checkout', '--detach', dir, base]);
    // No pattern at all would show everything: a copy that reads nothing shows nothing.
    if (reads) git(dir, ['sparse-checkout', 'set', '--no-cone', ...(reads.length ? reads.map(g => `/${g}`) : ['/.agent-pack-reads-nothing'])]);
    git(dir, ['checkout', '-q', '--detach', base]);
    const links = this.link(dir, reads);
    this.writeState(dir, { session: this.session, base, links });
  }

  deliver(ctr: string, allowed: Allowed, opts: { dryRun?: boolean } = {}): Delivery {
    const dir = this.copy(ctr);
    const { base, links } = this.readState(dir);
    const globs = allowed.globs.map(clean);
    // What the copy changed since its base — whatever wrote it — split by agent-pack's own globs, then handed to git path by path.
    const skip = [...links, ...(allowed.exclude ?? []).map(clean)].map(l => `:(top,exclude,literal)${l}`);
    const changed = [...new Set([
      ...lines(git(dir, ['diff', '--name-only', '--no-renames', 'HEAD', '--', '.', ...skip])),
      ...lines(git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ...skip])),
    ])];
    // A file the copy created is the work's own, when the contract admits new files: the base holds none of it.
    const inBase = allowed.created ? new Set(lines(git(dir, ['ls-tree', '-r', '--name-only', base]))) : null;
    const kept = changed.filter(p => matchesAnyGlob(p, globs) || (inBase !== null && !inBase.has(p)));
    const leftOut = changed.filter(p => !kept.includes(p));
    const whole: string[] = [];
    const zoned: { file: string; text: string }[] = [];
    const lostZones: string[] = [];
    const marks = allowed.marks;
    for (const file of kept) {
      if (!marks?.files.includes(file)) { whole.push(file); continue; }
      const z = zoneText(run(dir, ['show', `${base}:${file}`]).out, readFileSync(join(dir, file), 'utf-8'), marks);
      if ('gone' in z) { lostZones.push(`${file} (${z.gone})`); continue; }
      if (z.outside) leftOut.push(`${file} (outside its zones)`);
      zoned.push({ file, text: z.text });
    }
    const strayed = this.strayed(base, globs);
    if (opts.dryRun) return { committed: [...whole, ...zoned.map(z => z.file)], leftOut, strayed, lostZones };
    git(dir, ['reset', '-q']);
    if (whole.length) git(dir, ['add', '-A', '--', ...whole.map(p => `:(top,literal)${p}`)]);
    for (const { file, text } of zoned) {
      const mode = git(dir, ['ls-files', '-s', '--', file]).split(/\s+/)[0] || '100644';
      const blob = git(dir, ['hash-object', '-w', '--stdin'], {}, text);
      git(dir, ['update-index', '--cacheinfo', `${mode},${blob},${file}`]);
    }
    const commit = git(dir, ['commit-tree', git(dir, ['write-tree']), '-p', base, '-m', `agent-pack ${ctr}`]);
    git(this.root, ['update-ref', this.ref(ctr), commit]);
    return { committed: lines(git(this.root, ['diff', '--name-only', '--no-renames', base, commit])), leftOut, strayed, lostZones };
  }

  merge(ctr: string, prefer?: Prefer): MergeResult {
    if (!this.has(ctr)) throw new Error(`${ctr} was not delivered`);
    const ours = this.rev('merged');
    const theirs = this.rev(ctr);
    const r = run(this.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ...(prefer ? ['-X', prefer] : []), ours, theirs]);
    const [tree, ...conflicts] = lines(r.out);
    if (r.code === 1) return { merged: false, conflicts: [...new Set(conflicts)] };
    if (r.code !== 0) throw new Error(`git merge-tree: ${(r.err || r.out).trim()}`);
    const commit = git(this.root, ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', `agent-pack merge ${ctr}`]);
    // Compare-and-swap: two merges at once never lose one another.
    if (run(this.root, ['update-ref', this.ref('merged'), commit, ours]).code !== 0) throw new Error(`the session's result changed while ${ctr} was merged — merge it again`);
    return { merged: true };
  }

  land(opts: { close?: boolean } = {}): LandResult {
    let landed: string[] = [];
    if (this.has('base')) {
      const base = this.rev('base');
      const merged = this.rev('merged');
      if (merged !== base) {
        // The working folder as it is now: the developer — or the lead — may have changed it while the copies worked.
        const now = git(this.root, ['commit-tree', this.snapshot(), '-m', 'agent-pack now']);
        const r = run(this.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base', base, now, merged]);
        const [tree, ...conflicts] = lines(r.out);
        if (r.code === 1) return { conflicts: [...new Set(conflicts)] };
        if (r.code !== 0) throw new Error(`git merge-tree: ${(r.err || r.out).trim()}`);
        landed = this.write(now, tree);
      }
    }
    if (opts.close) this.close();
    else this.rebase();
    return { landed };
  }

  /** Write into the working folder what differs from `now` in `tree` — through a temporary index, never the real one. The paths written. */
  private write(now: string, tree: string): string[] {
    const changes = git(this.root, ['diff', '--name-status', '-z', '--no-renames', now, tree]).split('\0').filter(Boolean);
    const written: string[] = [];
    const landed: string[] = [];
    for (let i = 0; i + 1 < changes.length; i += 2) {
      const [status, path] = [changes[i], changes[i + 1]];
      landed.push(path);
      if (status === 'D') rmSync(join(this.root, path), { force: true });
      else written.push(path);
    }
    if (written.length) this.withIndex(env => {
      git(this.root, ['read-tree', tree], env);
      git(this.root, ['checkout-index', '-f', '-u', '--', ...written], env);
    });
    return landed;
  }

  /** The next round's base: the working folder as it is now, the child of the last base — so a copy of an earlier round still merges. */
  private rebase(): void {
    const parent = this.has('base') ? this.rev('base') : run(this.root, ['rev-parse', '--verify', '-q', 'HEAD']).out.trim();
    const commit = git(this.root, ['commit-tree', this.snapshot(), ...(parent ? ['-p', parent] : []), '-m', `agent-pack base ${this.session}`]);
    git(this.root, ['update-ref', this.ref('base'), commit]);
    git(this.root, ['update-ref', this.ref('merged'), commit]);
  }

  /** The files `globs` admit that changed in the working folder since `base` — work done outside the copy. */
  private strayed(base: string, globs: string[]): string[] {
    // A snapshot, not the status: what the base took uncommitted or untracked is no change.
    const changed = lines(git(this.root, ['diff', '--name-only', '--no-renames', base, this.snapshot()]));
    return changed.filter(p => !p.startsWith(`${WORK_DIR}/`) && matchesAnyGlob(p, globs));
  }

  // ------------------------------------------------------------------ helpers

  private ref(name: string): string {
    return `${this.ns}/${name}`;
  }

  private has(name: string): boolean {
    return run(this.root, ['rev-parse', '--verify', '-q', this.ref(name)]).code === 0;
  }

  private rev(name: string): string {
    if (!this.has(name)) throw new Error(`no ${name} in the session ${this.session} — open a copy first`);
    return git(this.root, ['rev-parse', this.ref(name)]);
  }

  private copy(ctr: string): string {
    const dir = join(this.root, this.path(ctr));
    if (!existsSync(dir)) throw new Error(`${ctr} has no copy — open it first`);
    return dir;
  }

  /** The base of the session, taken once: two agents opening at once agree on one. */
  private base(): string {
    if (this.has('base')) return this.rev('base');
    const head = run(this.root, ['rev-parse', '--verify', '-q', 'HEAD']);
    const commit = git(this.root, ['commit-tree', this.snapshot(), ...(head.code === 0 ? ['-p', head.out.trim()] : []), '-m', `agent-pack base ${this.session}`]);
    if (run(this.root, ['update-ref', this.ref('base'), commit, '']).code !== 0) return this.rev('base');
    git(this.root, ['update-ref', this.ref('merged'), commit, '']);
    return commit;
  }

  /** The working folder as a tree, uncommitted and untracked files included, the copies left out (they are ignored). */
  private snapshot(): string {
    this.ignoreCopies();
    return this.withIndex(env => {
      git(this.root, ['add', '-A'], env);
      return git(this.root, ['write-tree'], env);
    });
  }

  /** Run with a temporary index — a copy of the real one, so unchanged files are not hashed again; the real one is never touched. */
  private withIndex<T>(body: (env: Record<string, string>) => T): T {
    const index = resolve(this.root, git(this.root, ['rev-parse', '--git-path', `agent-pack-${process.pid}-${Date.now()}.index`]));
    const real = resolve(this.root, git(this.root, ['rev-parse', '--git-path', 'index']));
    if (existsSync(real)) copyFileSync(real, index);
    try {
      return body({ GIT_INDEX_FILE: index });
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** Keep the copies out of the developer's `git status`: a local exclude, never a versioned file. */
  private ignoreCopies(): void {
    if (run(this.root, ['check-ignore', '-q', `${WORK_DIR}/x`]).code === 0) return;
    const exclude = resolve(this.root, git(this.root, ['rev-parse', '--git-path', 'info/exclude']));
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `\n/${WORK_DIR}/\n`);
  }

  /**
   * Link into a copy what git cannot bring: the runtime folder always (but its
   * copies), and each ignored path the reads cover — with no reads, each
   * ignored dependency folder. Returns the linked paths.
   */
  private link(dir: string, reads: string[] | null): string[] {
    const links: string[] = [];
    const runtime = join(this.root, RUNTIME_DIR);
    if (existsSync(runtime)) {
      mkdirSync(join(dir, RUNTIME_DIR), { recursive: true });
      for (const name of readdirSync(runtime)) {
        const rel = `${RUNTIME_DIR}/${name}`;
        if (rel === WORK_DIR || existsSync(join(dir, rel))) continue;
        symlinkSync(join(runtime, name), join(dir, rel));
        links.push(rel);
      }
    }
    const ignored = lines(git(this.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']))
      .map(p => p.replace(/\/$/, ''))
      .filter(p => p !== RUNTIME_DIR && !p.startsWith(`${RUNTIME_DIR}/`));
    const targets = new Set<string>();
    for (const entry of ignored) {
      if (!reads) {
        if (DEPENDENCY_FOLDERS.has(entry.split('/').pop() ?? '')) targets.add(entry);
        continue;
      }
      for (const glob of reads) {
        const prefix = literalPrefix(glob);
        if (prefix === entry || prefix.startsWith(`${entry}/`)) targets.add(prefix);
        else if (prefix === '' || entry.startsWith(`${prefix}/`)) {
          const re = globRegExp(glob);
          if (re.test(entry) || re.test(`${entry}/x`)) targets.add(entry);
        }
      }
    }
    for (const rel of [...targets].sort()) {
      if ([...targets].some(t => t !== rel && rel.startsWith(`${t}/`))) continue;
      if (!existsSync(join(this.root, rel)) || existsSync(join(dir, rel))) continue;
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      symlinkSync(join(this.root, rel), join(dir, rel));
      links.push(rel);
    }
    return links;
  }

  private statePath(dir: string): string {
    return join(git(dir, ['rev-parse', '--absolute-git-dir']), 'agent-pack.json');
  }

  private writeState(dir: string, state: CopyState): void {
    writeFileSync(this.statePath(dir), `${JSON.stringify(state, null, 1)}\n`);
  }

  private readState(dir: string): CopyState {
    return JSON.parse(readFileSync(this.statePath(dir), 'utf-8')) as CopyState;
  }

  /** Remove every copy of the session and its refs. */
  private close(): void {
    const work = join(this.root, WORK_DIR);
    for (const name of existsSync(work) ? readdirSync(work) : []) {
      const dir = join(work, name);
      const mine = run(dir, ['rev-parse', '--absolute-git-dir']);
      if (mine.code !== 0) continue;
      const state = join(mine.out.trim(), 'agent-pack.json');
      if (!existsSync(state) || (JSON.parse(readFileSync(state, 'utf-8')) as CopyState).session !== this.session) continue;
      git(this.root, ['worktree', 'remove', '--force', dir]);
    }
    git(this.root, ['worktree', 'prune']);
    for (const ref of lines(git(this.root, ['for-each-ref', '--format=%(refname)', `${this.ns}/`]))) git(this.root, ['update-ref', '-d', ref]);
  }
}

export default function gitWorkspace(): WorkspaceEngine {
  return { type: 'workspace', name: 'git', session: (root, session) => new GitSession(root, session) };
}
