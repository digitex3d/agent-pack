// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { loadPlugins } from './pluginLoader.js';
import type { PluginSpec } from './plugins.js';
import { loadDrivers, type DriverEntry } from './storeDrivers/registry.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AdapterPlugin } from '../adapters/types.js';
import { resolveAdapter, resolveJudge, checkHarnessNames } from './adapter-registry.js';
import type { ChecksConfig, JudgeConfig, JudgePlugin } from './judge/types.js';
import { defaultBundleConfig } from './bundleDefaults.js';
import { DEFAULT_MAX_LINE_LENGTH } from './lint.js';
import { parseDuration, DURATION_FORM } from './delegation.js';
import { DEFAULT_DOMAIN_THRESHOLDS, type DomainThresholds } from './domains.js';
import { isProbability } from './judge/lock.js';
import { FORMULAS, fill } from './formulas.js';
import { isCount, isFiniteNumber, isPositive, isRecord } from './guards.js';

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return resolve(homedir(), filePath.slice(2));
  return filePath;
}

// dist/src/config.js -> package root is 2 levels up.
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** What agent-pack says about itself — its package.json, the one place each is written. */
export interface PackageInfo {
  version: string;
  description: string;
  /** The author's name, without the address. */
  author: string;
  license: string;
  /** The site. */
  homepage: string;
  /** The repository's web address. */
  repository: string;
  /** Where issues are reported. */
  issues: string;
}

let info: PackageInfo | null = null;

/** agent-pack's package.json, as the CLI shows it — read once. */
export function packageInfo(): PackageInfo {
  if (!info) {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
      version: string; description: string; author: string; license: string; homepage: string;
      repository: { url: string }; bugs: { url: string };
    };
    info = {
      version: pkg.version,
      description: pkg.description,
      author: pkg.author.replace(/\s*<[^>]*>\s*/, '').trim(),
      license: pkg.license,
      homepage: pkg.homepage,
      repository: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
      issues: pkg.bugs.url,
    };
  }
  return info;
}

/** agent-pack's own version. */
export function packageVersion(): string {
  return packageInfo().version;
}

/**
 * The tabeli engine that ships with agent-pack — `npm run build` compiles it
 * from `tabeli/tabeli.c` with tabeli's own Makefile. `bundle all` records its
 * absolute path in every `.apx`, which runs from the project, not from here.
 */
export const TABELI_ENGINE = resolve(PACKAGE_ROOT, 'tabeli/tabeli');

/** The project-level instructions file every harness reads: the open AGENTS.md standard. */
export const AGENTS_MD = 'AGENTS.md';

/** The file a project once had in place of its main (src/services/mainMetadata.ts): refused, with the rewrite. */
export const PROJECT_SOURCE = 'PROJECT.ap';

/**
 * The default library shipped inside the agent-pack package. Always reachable
 * from every project as the reserved `@builtin` alias — never copied into the
 * project, upgraded with the package.
 */
export const BUILTIN_LIBRARY_ROOT = resolve(PACKAGE_ROOT, 'templates/library');

/**
 * The agents shipped inside the package — the default delegate (`quick`) among
 * them. Found after the project's and the user's, so either shadows one by name.
 */
export const BUILTIN_AGENTS_DIR = resolve(PACKAGE_ROOT, 'templates/agents');

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
      if (isRecord(lib) && typeof lib.alias === 'string') {
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
  return mergeSharedLibrariesWithOrigin(base, override).map(entry => entry.def);
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
    merged[key] = isRecord(value) && isRecord(current)
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

  if (!isRecord(parsed)) {
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
export const BUILTIN_ALIAS = '@builtin';

/** The reserved alias of the library shipped inside the package, with its path. */
function builtinAliasMap(): Record<string, string> {
  return { [BUILTIN_ALIAS]: BUILTIN_LIBRARY_ROOT };
}

export function librariesAliasMap(config: Config): Record<string, string> {
  const map: Record<string, string> = { '@main': config.libraryRoot };
  for (const lib of config.sharedLibraries ?? []) {
    map[normalizeAlias(lib.alias)] = lib.path;
  }
  if (config.userRoot) map['@user'] = config.userRoot;
  return { ...map, ...builtinAliasMap() };
}

export interface Config {
  agentsDir: string;
  /** Root directory that contains team sub-directories. Default: `agents/teams`. */
  teamsDir: string;
  outputDir: string;
  /**
   * The project library root. Single source of truth for project-local
   * .ap files (policies, skills, procedures, templates, roles).
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
  /** The judge of checked conditions while the agent works — null (no `checks` key): none. */
  checks?: ChecksConfig | null;
  /** The thresholds that turn a domain formula's probabilities into files (src/domains.ts) — `{ in: 0.8, out: 0.2 }` by default. */
  domains?: DomainThresholds;
  /** How long an `apx wait` waits at most, when its WAIT names no `MAX` — `{ max: '30m' }` by default (src/delegation.ts). */
  wait?: WaitConfig;
  /** How many zones a MARK binds at most, when its line names no `MAX` — `{ max: 20 }` by default (src/delegation.ts). */
  mark?: MarkConfig;
  /** Who an ASK without BY is handed to, and the models delegates run on (src/executor.ts). */
  delegate?: DelegateConfig;
  /** The plugins the project activates (`plugins: ['./plugins/checklist']`), installed — src/plugins.ts. */
  plugins?: PluginSpec[];
  /** `agent-pack chat`: the ACP server the chat talks to — null (no `chat` key): no chat. */
  chat?: ChatConfig | null;
  /** The store drivers the project adds to files and tabeli (`drivers: ['agent-pack-driver-sqlite']`), installed — src/storeDrivers/. */
  drivers?: DriverEntry[];
  /** What the apx shows after a command's answer, and how a block is weighed for it — the defaults when absent. */
  dashboard?: DashboardConfig;
}

/**
 * The `delegate` key: `default` is the agent a `DELEGATE` line without `BY` is
 * handed to (`quick`, shipped with the package, unless the project names its
 * own); `models` sets an agent's model, by name — the source never does.
 */
export interface DelegateConfig {
  default: string;
  models: Record<string, string>;
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
  return config.adapters.map(adapter => adapter.name);
}

const OUTPUT_DIR = '.agent-pack/compiled';

const LINT_DEFAULTS: LintConfig = {
  maxLineLength: DEFAULT_MAX_LINE_LENGTH,
};

/** The judge lock's default path, from the project root. */
export const JUDGE_LOCK_DEFAULT = 'agent-pack.judge.lock';

const JUDGE_DEFAULTS = {
  adapter: 'jev',
  threshold: 0.5,
  offline: 'warn',
  lock: JUDGE_LOCK_DEFAULT,
  concurrency: 8,
} as const;

const CHECKS_DEFAULTS = {
  adapter: 'jev',
  threshold: 0.7,
} as const;

/** `margin` decided the judge's choices — a file's domain; a domain's files are its DOMAIN block's FOR now. */
function noMargin(key: string, raw: Record<string, unknown>): void {
  if (raw.margin !== undefined) throw new Error(`${key}.margin was removed — the judge no longer picks a file's domain: an \`EXPORT DOMAIN <name>:\` block says its files with FOR`);
}

/** A config key's judge entry resolved — a built-in judge by name, or a judge object — and its threshold checked. */
function judgeOf(key: string, entry: unknown, threshold: unknown): JudgePlugin {
  const adapter = resolveJudge(entry as JudgePlugin | string);
  if (!isRecord(adapter) || adapter.type !== 'judge' || typeof adapter.ask !== 'function') {
    throw new Error(`${key}.adapter must be a built-in judge name or an object { type: 'judge', name, ask }`);
  }
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) throw new Error(`${key}.threshold must be a number between 0 and 1`);
  return adapter;
}

/** What a config number must be — each rule's words are `FORMULAS.messages.numbers`. */
const NUMBER = {
  count: isCount,
  positive: isPositive,
  nonNegative: (value: unknown) => isFiniteNumber(value) && value >= 0,
} as const;

/** What a config number must be, by name. */
type NumberRule = keyof typeof NUMBER;

/** One number of a config key, checked against what it must be. */
function configNumber(key: string, value: unknown, rule: NumberRule): number {
  if (!NUMBER[rule](value)) throw new Error(fill(FORMULAS.messages.config.mustBe, { key, rule: FORMULAS.messages.numbers[rule] }));
  return value as number;
}

/** A config value as an author writes it: `{ max: 20 }`, `{ boss: 'claude-code' }`. */
function writtenValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (isRecord(value)) return `{ ${Object.entries(value).map(([name, item]) => `${name}: ${writtenValue(item)}`).join(', ')} }`;
  return String(value);
}

/**
 * A config key's object: refused when it is none, or when it holds a key
 * `shape` does not — `shape` being its defaults, or an example of it, which
 * the refusal shows.
 */
function configObject(key: string, raw: unknown, shape: Record<string, unknown>): Record<string, unknown> {
  const SAY = FORMULAS.messages.config;
  if (!isRecord(raw)) throw new Error(fill(SAY.object, { key, example: writtenValue(shape) }));
  const keys = Object.keys(shape);
  const unknown = Object.keys(raw).filter(name => !keys.includes(name));
  const quoted = (names: string[]) => names.map(name => `\`${name}\``).join(', ');
  if (unknown.length) throw new Error(fill(SAY.unknownKey, { key, unknown: quoted(unknown), keys: quoted(keys) }));
  return raw;
}

/**
 * The `judge` key resolved: a built-in judge by name or a judge object, the
 * defaults filled in, the lock anchored to the project root. Absent →
 * null (the phase is off). A value the phase cannot use is an error, never a guess.
 */
function resolveJudgeConfig(raw: unknown, projectRoot: string): JudgeConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isRecord(raw)) throw new Error("judge must be an object, e.g. { adapter: 'jev' }");
  const judge = { ...JUDGE_DEFAULTS, ...raw } as Record<string, unknown>;
  const { threshold, offline, lock, concurrency } = judge;
  const adapter = judgeOf('judge', judge.adapter, threshold);
  noMargin('judge', judge);
  if (offline !== 'warn' && offline !== 'error') throw new Error("judge.offline must be 'warn' or 'error'");
  if (typeof lock !== 'string' || lock.trim() === '') throw new Error('judge.lock must be a file path');
  return { adapter, threshold: threshold as number, offline, lock: resolve(projectRoot, expandHome(lock)), concurrency: configNumber('judge.concurrency', concurrency, 'count') };
}

/**
 * The `domains` key resolved: the probabilities that split a domain formula's
 * files — at or above `in` within, at or below `out` outside (D44). Both
 * between 0 and 1, `out` below `in`; absent, the defaults.
 */
function resolveDomainThresholds(raw: unknown): DomainThresholds {
  if (raw === undefined || raw === null) return { ...DEFAULT_DOMAIN_THRESHOLDS };
  const thresholds = { ...DEFAULT_DOMAIN_THRESHOLDS, ...configObject('domains', raw, { ...DEFAULT_DOMAIN_THRESHOLDS }) } as Record<string, unknown>;
  for (const key of ['in', 'out']) if (!isProbability(thresholds[key])) throw new Error(`domains.${key} must be a number between 0 and 1`);
  if ((thresholds.out as number) >= (thresholds.in as number)) throw new Error('domains.out must be below domains.in — between them the agent decides');
  return { in: thresholds.in as number, out: thresholds.out as number };
}

/** The `mark` key: how many zones a MARK binds at most, when its line names no `MAX`. */
export interface MarkConfig {
  max: number;
}

export const MARK_DEFAULTS: MarkConfig = { max: 20 };

/** The `mark` key resolved: `max` a whole number ≥ 1 — absent, the default. */
function resolveMarkConfig(raw: unknown): MarkConfig {
  if (raw === undefined || raw === null) return { ...MARK_DEFAULTS };
  const mark = configObject('mark', raw, { ...MARK_DEFAULTS });
  return { max: configNumber('mark.max', mark.max ?? MARK_DEFAULTS.max, 'count') };
}

/** The two kinds the dashboard ranks apart, each by the name of its section in the `dashboard` config. */
export const DASHBOARD_KIND = { rules: 'rules', triggers: 'triggers' } as const;
export type DashboardKind = typeof DASHBOARD_KIND[keyof typeof DASHBOARD_KIND];

/**
 * The `dashboard` key: what the apx shows after a command's answer
 * (src/apx/dashboard.ts) and how a block is weighed for it (src/dashboard.ts).
 * `manyRules`, `recall` and the bands are provisional — never measured, to be
 * tuned on the call log.
 */
export interface DashboardConfig {
  /** Blocks shown at most, every kind together. */
  maxEntries: number;
  /** Each kind's own limit, before the lists merge. */
  kinds: Record<DashboardKind, { max: number }>;
  /** What goal and context weigh, against next. */
  contextWeight: number;
  /** An agent with more rule lines than this adds 1 to the risk of each of its blocks. */
  manyRules: number;
  /** Calls after which a block shown has no penalty left. */
  recall: number;
  /** The score where each band starts. */
  bands: { medium: number; high: number };
  /** What a word weighs by the field of a block it stands in — the strongest counting: its name and tags (a WHEN's condition), its ABOUT, its lines. */
  fields: { name: number; about: number; lines: number };
}

export const DASHBOARD_DEFAULTS: DashboardConfig = {
  maxEntries: 6,
  kinds: { [DASHBOARD_KIND.rules]: { max: 4 }, [DASHBOARD_KIND.triggers]: { max: 3 } },
  contextWeight: 0.5,
  manyRules: 20,
  recall: 8,
  bands: { medium: 5, high: 12 },
  fields: { name: 3, about: 2, lines: 1 },
};

/** The `dashboard` key resolved over its defaults, every number checked — absent, the defaults. */
function resolveDashboardConfig(raw: unknown): DashboardConfig {
  if (raw === undefined || raw === null) return structuredClone(DASHBOARD_DEFAULTS);
  const given = configObject('dashboard', raw, { ...DASHBOARD_DEFAULTS });
  const { kinds: kindDefaults, bands: bandDefaults, fields: fieldDefaults, ...topDefaults } = DASHBOARD_DEFAULTS;
  const section = <Names extends string>(name: string, defaults: Record<Names, number>, rules: Record<Names, NumberRule>) =>
    numbersOf(`dashboard.${name}`, configObject(`dashboard.${name}`, given[name] ?? {}, defaults), defaults, rules);
  const kindsGiven = configObject('dashboard.kinds', given.kinds ?? {}, kindDefaults);
  const kinds = Object.fromEntries(Object.values(DASHBOARD_KIND).map(kind => {
    const key = `dashboard.kinds.${kind}`;
    return [kind, numbersOf(key, configObject(key, kindsGiven[kind] ?? {}, kindDefaults[kind]), kindDefaults[kind], { max: 'count' })];
  })) as DashboardConfig['kinds'];
  const bands = section('bands', bandDefaults, { medium: 'positive', high: 'positive' });
  if (bands.medium >= bands.high) throw new Error(FORMULAS.messages.config.dashboardBands);
  return {
    ...numbersOf('dashboard', given, topDefaults, { maxEntries: 'count', contextWeight: 'positive', manyRules: 'nonNegative', recall: 'count' }),
    kinds,
    bands,
    fields: section('fields', fieldDefaults, { name: 'positive', about: 'positive', lines: 'positive' }),
  };
}

/** The numbers of a config section, each given or its default, checked against its rule. */
function numbersOf<Names extends string>(key: string, given: Record<string, unknown>, defaults: Record<Names, number>, rules: Record<Names, NumberRule>): Record<Names, number> {
  return Object.fromEntries((Object.keys(defaults) as Names[]).map(name => [name, configNumber(`${key}.${name}`, given[name] ?? defaults[name], rules[name])])) as Record<Names, number>;
}

/** The `chat` key: `boss` the harness `agent-pack chat` talks to — an acp server, or a harness with the acp option. */
interface ChatConfig {
  boss: string;
}

/** The `chat` key as an author writes it — its keys, and the example a refusal shows. */
const CHAT_EXAMPLE: ChatConfig = { boss: 'claude-code' };

/** The `chat` key resolved: `boss` a harness name — absent, no chat. Whether it names an ACP server is the chat's to check. */
function resolveChatConfig(raw: unknown): ChatConfig | null {
  if (raw === undefined || raw === null) return null;
  const boss = configObject('chat', raw, { ...CHAT_EXAMPLE }).boss;
  if (typeof boss !== 'string' || boss.trim() === '') throw new Error(FORMULAS.messages.config.chatBoss);
  return { boss };
}

/** The `wait` key: how long a WAIT waits at most, as a duration. */
export interface WaitConfig {
  max: string;
}

export const WAIT_DEFAULTS: WaitConfig = { max: '30m' };

/** The `wait` key resolved: `max` a duration (`90s`, `30m`, `2h`) — absent, the default. */
function resolveWaitConfig(raw: unknown): WaitConfig {
  if (raw === undefined || raw === null) return { ...WAIT_DEFAULTS };
  const max = configObject('wait', raw, { ...WAIT_DEFAULTS }).max ?? WAIT_DEFAULTS.max;
  if (typeof max !== 'string' || parseDuration(max) === null) throw new Error(`wait.max must be a duration — ${DURATION_FORM}`);
  return { max };
}

/**
 * The `checks` key resolved — the judge of checked conditions while the agent
 * works (`IF!`, `IF!!`), apart from `judge`: a built-in judge by name or a
 * judge object, threshold 0.7 by default. Absent → null. A loop's round limit
 * is no config: each `UNTIL` someone else ends writes its own `MAX <n>`.
 */
function resolveChecksConfig(raw: unknown): ChecksConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (!isRecord(raw)) throw new Error("checks must be an object, e.g. { adapter: 'jev' }");
  const checks = { ...CHECKS_DEFAULTS, ...raw } as Record<string, unknown>;
  if (checks.rounds !== undefined) throw new Error('checks.rounds was removed — write the limit on each loop: `UNTIL!! <condition> MAX <n>:` (UNTIL!, UNTIL*, UNTIL** alike)');
  noMargin('checks', checks);
  const adapter = judgeOf('checks', checks.adapter, checks.threshold);
  return { adapter, threshold: checks.threshold as number };
}

/** The delegate shipped with the package (templates/agents/quick.ap): an ASK without BY goes to it, unless `delegate.default` names another. */
export const DEFAULT_DELEGATE = 'quick';

/** The `delegate` key resolved: the default delegate and the models, both checked. Absent: the shipped delegate, no model set. */
export function resolveDelegateConfig(raw: unknown): DelegateConfig {
  if (raw === undefined || raw === null) return { default: DEFAULT_DELEGATE, models: {} };
  if (!isRecord(raw)) throw new Error(`delegate must be an object, e.g. { default: '${DEFAULT_DELEGATE}', models: { ${DEFAULT_DELEGATE}: 'haiku' } }`);
  const delegate = raw as Record<string, unknown>;
  const name = delegate.default ?? DEFAULT_DELEGATE;
  if (typeof name !== 'string' || name.trim() === '') throw new Error('delegate.default must be an agent name');
  const models = delegate.models ?? {};
  if (!isRecord(models) || Object.values(models).some(model => typeof model !== 'string')) throw new Error('delegate.models must map agent names to model names');
  return { default: name, models: models as Record<string, string> };
}

const DEFAULTS: Omit<Config, 'bundle' | 'lint' | 'adapters' | 'userRoot' | 'judge' | 'checks' | 'delegate'> = {
  agentsDir: 'agents',
  teamsDir: 'agents/teams',
  outputDir: OUTPUT_DIR,
  libraryRoot: 'library',
};

export async function loadConfig(args: string[]): Promise<Config> {
  let configPath: string | null = null;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--config' && args[index + 1]) {
      configPath = resolve(args[++index]);
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
    adapters: checkHarnessNames((userConfig.adapters || []).map(resolveAdapter)),
    judge: resolveJudgeConfig(userConfig.judge, projectRoot),
    checks: resolveChecksConfig(userConfig.checks),
    domains: resolveDomainThresholds(userConfig.domains),
    wait: resolveWaitConfig(userConfig.wait),
    mark: resolveMarkConfig(userConfig.mark),
    chat: resolveChatConfig(userConfig.chat),
    delegate: resolveDelegateConfig(userConfig.delegate),
    dashboard: resolveDashboardConfig(userConfig.dashboard),
    // Each plugin folder, from the project root — loaded and installed before any agent compiles.
    plugins: await loadPlugins(((userConfig.plugins ?? []) as string[]).map(dir => resolve(projectRoot, expandHome(dir)))),
    // Each driver module, from the project root — installed before any store compiles, recorded for the apx.
    drivers: await loadDrivers((userConfig.drivers ?? []) as unknown[], projectRoot),
  };
}
