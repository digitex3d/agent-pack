// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { AdapterPlugin } from '../adapters/types.js';
import { resolveAdapter, resolveJudge } from './adapter-registry.js';
import type { JudgeConfig, JudgePlugin } from './judge/types.js';
import { defaultBundleConfig } from './bundleDefaults.js';

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

// dist/src/config.js -> package root is 2 levels up.
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The default library shipped inside the agent-pack package. Always reachable
 * from every project as the reserved `@builtin` alias — never copied into the
 * project, upgraded with the package.
 */
export const BUILTIN_LIBRARY_ROOT = resolve(PACKAGE_ROOT, 'templates/library');

/** Example agents `init` can copy into a new project. */
export const EXAMPLES_DIR = resolve(PACKAGE_ROOT, 'templates/examples');

/** Directory name of the user-level (system) agent-pack home, under $HOME. */
const USER_HOME_DIRNAME = '.agent-pack';

/** Filename of the user-level JSON config inside the user home. */
const USER_CONFIG_FILENAME = 'config.json';

/**
 * Resolve the user-level agent-pack home — the root of the global library and
 * agents, and the directory that holds the system `config.json`. Defaults to
 * `~/.agent-pack`; `AGENT_PACK_HOME` overrides it (git-config-like, and lets
 * tests isolate the user layer from the real home).
 */
export function userHomeDir(): string {
  const override = process.env.AGENT_PACK_HOME;
  if (override && override.trim() !== '') return resolve(expandHome(override));
  return resolve(homedir(), USER_HOME_DIRNAME);
}

/** Normalize a library alias to its canonical `@`-prefixed form. */
export function normalizeAlias(alias: string): string {
  return alias.startsWith('@') ? alias : `@${alias}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The config layer a `sharedLibrary` entry was declared in. */
type LibraryOrigin = 'user' | 'project';

/** A raw `sharedLibrary` entry paired with the layer that supplied it. */
interface OriginatedLibrary {
  def: Record<string, unknown>;
  origin: LibraryOrigin;
}

/**
 * Merge `sharedLibraries` from the user and project layers by alias, tagging
 * each surviving entry with the layer it came from. The project layer wins per
 * alias key (so a project may redefine a single inherited user alias or add its
 * own); the origin lets path resolution anchor a user-declared relative path to
 * the user home rather than the project cwd.
 */
function mergeSharedLibrariesWithOrigin(base: unknown, override: unknown): OriginatedLibrary[] {
  const byAlias = new Map<string, OriginatedLibrary>();
  for (const [layer, origin] of [[base, 'user'], [override, 'project']] as const) {
    for (const lib of Array.isArray(layer) ? layer : []) {
      if (isPlainObject(lib) && typeof lib.alias === 'string') {
        byAlias.set(normalizeAlias(lib.alias), { def: lib, origin });
      }
    }
  }
  return [...byAlias.values()];
}

/**
 * Merge `sharedLibraries` from two config layers by alias. The override layer
 * (project) wins per alias key, so a project may redefine a single inherited
 * user alias or add its own, while leaving the rest of the user aliases intact.
 */
function mergeSharedLibrariesByAlias(base: unknown, override: unknown): unknown[] {
  return mergeSharedLibrariesWithOrigin(base, override).map(o => o.def);
}

/**
 * Merge two raw config layers into one. The override layer (project) wins per
 * key, matching `git config` precedence (local over global): default → user →
 * project. Nested plain objects deep-merge so a project that sets one nested
 * field does not drop the user's siblings; `sharedLibraries` merges by alias.
 */
function mergeConfigLayers(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || key === 'sharedLibraries') continue;
    const current = merged[key];
    merged[key] = isPlainObject(value) && isPlainObject(current)
      ? mergeConfigLayers(current, value)
      : value;
  }
  merged.sharedLibraries = mergeSharedLibrariesByAlias(base.sharedLibraries, override.sharedLibraries);
  return merged;
}

/**
 * Read and parse the user-level JSON config when present. Returns an empty
 * layer when the file is absent (preserving the project-only behaviour).
 * Raises an explicit error on an unreadable or malformed file — never silent.
 */
function readUserConfigLayer(): Record<string, unknown> {
  const path = resolve(userHomeDir(), USER_CONFIG_FILENAME);
  if (!existsSync(path)) return {};

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read user config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in user config at ${path}: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`User config at ${path} must be a JSON object`);
  }
  return parsed;
}

export type BundleConfig = Record<string, boolean>;

export interface LintConfig {
  maxLineLength: number;
}

/** A shared library: an alias pointing at a folder on disk. */
export interface LibraryDef {
  alias: string;
  path: string;
  watch?: boolean;
}

/**
 * Build the runtime alias→path map: `@main` (the project library) always
 * present, plus declared sharedLibraries, plus the reserved `@user` and
 * `@builtin` aliases (the user-level agent-pack home and the library shipped
 * inside the package). The reserved aliases are set last so they can never be
 * shadowed by a declared library of the same alias.
 */
export function librariesAliasMap(config: Config): Record<string, string> {
  const map: Record<string, string> = { '@main': config.libraryRoot };
  for (const lib of config.sharedLibraries ?? []) {
    map[normalizeAlias(lib.alias)] = lib.path;
  }
  if (config.userRoot) map['@user'] = config.userRoot;
  map['@builtin'] = BUILTIN_LIBRARY_ROOT;
  return map;
}

export interface Config {
  agentsDir: string;
  /** Root directory that contains team sub-directories. Default: `agents/teams`. */
  teamsDir: string;
  outputDir: string;
  /**
   * The project library root. Single source of truth for project-local
   * .ap files (policies, playbooks, procedures, templates, roles).
   * Default: 'library'. Override only when a different layout is required.
   */
  libraryRoot: string;
  /**
   * The user-level agent-pack home — root of the global library and agents,
   * exposed to every project as the reserved `@user` alias. Defaults to
   * `~/.agent-pack` (override via `AGENT_PACK_HOME`).
   */
  userRoot: string;
  /**
   * Shared libraries reachable from this project via module-style imports
   * (`IMPORT x FROM @<alias>.policies.coding.general`).
   *
   * The project's own libraryRoot is always available as `@main` (implicit,
   * not declared here). Add entries here only for additional shared libraries.
   *
   * Each entry:
   *   alias: string  — used as `@<alias>` in IMPORT FROM directives
   *   path:  string  — absolute or relative path to the library root
   *   watch: boolean — include the library in `bundle all --watch` chokidar
   */
  sharedLibraries?: LibraryDef[];
  bundle: BundleConfig;
  lint: LintConfig;
  adapters: AdapterPlugin[];
  /** The judge phase — null (no `judge` key) turns it off. */
  judge?: JudgeConfig | null;
}

/** Library roots searched by `IMPORT … FROM library.<kind>` (unqualified path).
 *  Only the main project root — shared libraries are reachable exclusively via
 *  `IMPORT … FROM @<alias>.…`. */
export function libraryRoots(config: Config): string[] {
  return [config.libraryRoot];
}

/** Whether the project has any adapter registered in `adapters: [...]`. */
export function hasAdapters(config: Config): boolean {
  return config.adapters.length > 0;
}

/** Names of every registered adapter, in config order. */
export function adapterNames(config: Config): string[] {
  return config.adapters.map(a => a.name);
}

const OUTPUT_DIR = '.agent-pack/compiled';

const LINT_DEFAULTS: LintConfig = {
  maxLineLength: 120,
};

const JUDGE_DEFAULTS = {
  adapter: 'jev',
  threshold: 0.5,
  offline: 'warn',
  lock: 'agent-pack.judge.lock',
  concurrency: 8,
} as const;

/**
 * The `judge` key resolved: a built-in judge by name or a judge object, the
 * defaults filled in, the lock anchored to the project root. Absent →
 * null (the phase is off). A value the phase cannot use is an error, never a guess.
 */
function resolveJudgeConfig(raw: unknown, projectRoot: string): JudgeConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isPlainObject(raw)) throw new Error("judge must be an object, e.g. { adapter: 'jev' }");
  const j = { ...JUDGE_DEFAULTS, ...raw } as Record<string, unknown>;
  const adapter = resolveJudge(j.adapter as JudgePlugin | string);
  if (!isPlainObject(adapter) || adapter.type !== 'judge' || typeof adapter.ask !== 'function') {
    throw new Error("judge.adapter must be a built-in judge name or an object { type: 'judge', name, ask }");
  }
  const { threshold, offline, lock, concurrency } = j;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) throw new Error('judge.threshold must be a number between 0 and 1');
  if (offline !== 'warn' && offline !== 'error') throw new Error("judge.offline must be 'warn' or 'error'");
  if (typeof lock !== 'string' || lock.trim() === '') throw new Error('judge.lock must be a file path');
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1) throw new Error('judge.concurrency must be a whole number ≥ 1');
  return { adapter, threshold, offline, lock: resolve(projectRoot, expandHome(lock)), concurrency: concurrency as number };
}

const DEFAULTS: Omit<Config, 'bundle' | 'lint' | 'adapters' | 'userRoot' | 'judge'> = {
  agentsDir: 'agents',
  teamsDir: 'agents/teams',
  outputDir: OUTPUT_DIR,
  libraryRoot: 'library',
};

export async function loadConfig(args: string[]): Promise<Config> {
  let configPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = resolve(args[++i]);
      break;
    }
  }

  const defaultPath = resolve(process.cwd(), 'agent-pack.config.mjs');
  const finalPath = configPath || (existsSync(defaultPath) ? defaultPath : null);

  let projectConfig: Record<string, unknown> = {};
  if (finalPath && existsSync(finalPath)) {
    const mod = await import(finalPath);
    projectConfig = mod.default;
  } else if (configPath) {
    throw new Error(`Config not found: ${configPath}`);
  }

  // Cascade: default → user → project. The project layer overrides the
  // user-level config per key (git-config-like local-over-global precedence).
  const userLayer = readUserConfigLayer();
  const userConfig: any = mergeConfigLayers(userLayer, projectConfig);

  const userBundle = userConfig.bundle || {};
  const userLint = userConfig.lint || {};

  const agentsDir = resolve(userConfig.agentsDir || DEFAULTS.agentsDir);
  const teamsDir = resolve(userConfig.teamsDir || DEFAULTS.teamsDir);

  const libraryRoot = resolve(expandHome(userConfig.libraryRoot || DEFAULTS.libraryRoot));

  // Normalize `sharedLibraries` to absolute paths. A user-declared library
  // anchors its relative paths to the user home; a project-declared one to the
  // project cwd — so a global library resolves the same from every project.
  // Absolute and `~/…` paths are unaffected.
  const originatedLibraries = mergeSharedLibrariesWithOrigin(
    userLayer.sharedLibraries,
    projectConfig.sharedLibraries,
  );
  const projectRoot = process.cwd();
  const sharedLibraries: LibraryDef[] = [];
  for (const { def: raw, origin } of originatedLibraries) {
    if (typeof raw.alias !== 'string') continue;
    const base = origin === 'user' ? userHomeDir() : projectRoot;
    if (typeof raw.path === 'string') {
      sharedLibraries.push({
        alias: raw.alias,
        path: resolve(base, expandHome(raw.path)),
        watch: raw.watch === true,
      });
    }
  }

  return {
    agentsDir,
    teamsDir,
    outputDir: resolve(OUTPUT_DIR),
    libraryRoot,
    userRoot: userHomeDir(),
    sharedLibraries,
    bundle: { ...defaultBundleConfig(), ...userBundle },
    lint: {
      maxLineLength: userLint.maxLineLength ?? LINT_DEFAULTS.maxLineLength,
    },
    adapters: (userConfig.adapters || []).map(resolveAdapter),
    judge: resolveJudgeConfig(userConfig.judge, projectRoot),
  };
}
