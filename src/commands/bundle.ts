// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, relative, sep } from 'path';
import { loadConfig, Config, libraryRoots as libraryRootsOf, librariesAliasMap, BUILTIN_LIBRARY_ROOT, packageInfo } from '../config.js';
import { AdapterRegistry } from '../adapter-registry.js';
import { AdapterCtx, AdapterPlugin, EmittedFile } from '../../adapters/types.js';
import { bundleAndEmit } from '../bundlers/run.js';
import { orphanPrograms } from '../executor.js';
import { emitProjectContext, ensureProjectPointers, AGENTS_MD, PROJECT_SOURCE } from '../projectContext.js';
import { ensureOrchestrationSection } from '../orchestrationSection.js';
import { discoverAgentsByWalk } from '../agentDiscovery.js';
import { standaloneDir } from '../services/teamMetadata.js';
import { openJudgeRun, finishJudgeRun, type JudgeRun } from '../judge/phase.js';
import { documentDefHashes, removeStaleCaches } from '../apx/dimensions.js';
import { reporter, useReporter, plainReporter } from '../report.js';
import { prettyReporter } from '../../reporters/pretty/index.js';
import { banner } from '../../reporters/pretty/logo.js';

/**
 * CLI command: parse args, build a bundle (agent or skill), optionally
 * apply an adapter, then materialize via the bundle's emitter. The compilation
 * itself lives in `src/compiler` — this is the thin CLI wrapper over it.
 */
export async function bundle(args: string[]): Promise<void> {
  const config = await loadConfig(args);

  let source: string | null = null;
  let adapterName: string | null = null;
  let outputDir: string | null = null;
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--adapter' && args[i + 1]) adapterName = args[++i];
    else if (args[i] === '--out' && args[i + 1]) outputDir = args[++i];
    else if (args[i] === '--watch') watch = true;
    else if (args[i] === '--apx-compress') config.bundle.apxCompress = true;
    else if (args[i] === '--no-apx-compress') config.bundle.apxCompress = false;
    else if (args[i] === '--no-judge') config.judge = null;
    else if (args[i] === '--judge-strict') { if (config.judge) config.judge.offline = 'error'; }
    else if (args[i] === '--config') i++;
    else if (!args[i].startsWith('--') && !source) source = args[i];
  }
  useReporter(chooseReporter(args));
  const report = reporter();

  if (!source) {
    report.note('Usage:');
    report.note('  agent-pack bundle <name|path> [--adapter <name>] [--out <dir>] [--apx-compress|--no-apx-compress] [--no-judge|--judge-strict] [--plain] [--verbose]');
    report.note('  agent-pack bundle all       [--adapter <name>] [--out <dir>] [--watch] [--apx-compress|--no-apx-compress] [--no-judge|--judge-strict] [--plain] [--verbose]');
    process.exit(1);
  }

  if (watch && source !== 'all') {
    report.note('--watch is only supported with `bundle all`.');
    process.exit(1);
  }


  const ctx: AdapterCtx = {
    projectRoot: process.cwd(),
    outputDir: outputDir ?? config.outputDir,
  };

  if (source === 'all') {
    await runBundleAll(config, adapterName, ctx, watch);
    return;
  }

  let adapter: AdapterPlugin | undefined;
  if (adapterName) {
    try {
      adapter = AdapterRegistry.fromConfig(config).get(adapterName);
    } catch (err) {
      report.failed(err);
      process.exit(1);
    }
  }

  let judge: JudgeRun | null = null;
  let failed = false;
  try {
    judge = openJudgeRun(config, ctx.projectRoot);
    const { bundle: built, files } = await bundleAndEmit(source, config, adapter, ctx, { judge });
    writeFiles(files);
    const suffix = adapterName ? ` (adapter: ${adapterName})` : '';
    report.info(`${built.name} bundled${suffix}`);
  } catch (err) {
    report.failed(err);
    failed = true;
  } finally {
    if (judge) finishJudgeRun(judge, { prune: false });
  }
  if (failed) process.exit(1);
}

async function runBundleAll(
  config: Config,
  adapterName: string | null,
  ctx: AdapterCtx,
  watch = false,
): Promise<void> {
  let adapters: AdapterPlugin[];
  try {
    const registry = AdapterRegistry.fromConfig(config);
    adapters = adapterName ? [registry.get(adapterName)] : config.adapters;
  } catch (err) {
    reporter().failed(err);
    process.exit(1);
  }
  if (adapters.length === 0) {
    reporter().note('No adapters registered. Configure `adapters: [...]` in agent-pack.config.mjs or pass --adapter <name>.');
    process.exit(1);
  }
  const ok = await bundleAllOnce(config, adapters, ctx);
  if (!watch) {
    if (!ok) process.exit(1);
    return;
  }

  await runWatchLoop(config, adapters, ctx);
}

export async function bundleAllOnce(
  config: Config,
  adapters: AdapterPlugin[],
  ctx: AdapterCtx,
): Promise<boolean> {
  const report = reporter();
  // Per S7/S8: agents come exclusively from a filesystem walk.
  const agents = discoverAgentsByWalk(config);
  if (agents.length === 0) {
    report.info(`no agents found under ${relative(ctx.projectRoot, config.agentsDir) || '.'}/ — write a .ap file there, or run \`agent-pack init\` to add the examples`);
  }

  let totalErrors = 0;
  // The judge run of this build — shared by every agent and adapter, closed once at the end.
  let judge: JudgeRun | null = null;
  try {
    judge = openJudgeRun(config, ctx.projectRoot);
  } catch (err) {
    report.info(`judge: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  const programIds = new Set<string>();
  /** Whether some agent works under a perimeter — the harness then keeps it (D65). */
  let guarded = false;
  /** The defhash of every dimension the build compiles — the cache folders still in use. */
  const defhashes = new Set<string>();
  /** path → the adapter that wrote it and what: each file is written and listed once. */
  const written = new Map<string, { adapter: string; content: string }>();
  // The agent's own artifacts (.apx, compiled document) are one per agent: the
  // first adapter in the config writes them; a harness file two adapters both
  // claim is a configuration error.
  const shared = resolve(ctx.projectRoot, '.agent-pack') + sep;

  // The default delegate joins the build when some agent hands it work and the project has none of that name.
  const queue = [...agents];
  for (let k = 0; k < queue.length; k++) {
    const agent = queue[k];
    for (const adapter of adapters) {
      try {
        const { bundle, files } = await bundleAndEmit(agent.name, config, adapter, ctx, { judge });
        for (const spec of Object.values(bundle.structure?.meta.executors ?? {})) if (spec.program) programIds.add(spec.program);
        if (bundle.structure) for (const hash of documentDefHashes(bundle.structure)) defhashes.add(hash);
        const meta = bundle.structure?.meta;
        if (bundle.structure && (bundle.structure.perimeter() || meta?.background || meta?.marks)) guarded = true;
        const delegate = bundle.structure?.meta.delegate;
        if (delegate && !queue.some(a => a.name === delegate)) queue.push({ name: delegate });
        for (const f of files) {
          const prior = written.get(f.path);
          if (prior?.content === f.content || (prior && f.path.startsWith(shared))) continue;
          if (prior && prior.adapter !== adapter.name) {
            report.info(`adapters ${prior.adapter} and ${adapter.name} both write ${f.path} — keep only one of them in the config`);
            totalErrors++;
            continue;
          }
          written.set(f.path, { adapter: adapter.name, content: f.content });
          writeFiles([f]);
        }
      } catch (err) {
        report.failed(err, `agent ${agent.name} on ${adapter.name}`);
        totalErrors++;
      }
    }
  }

  // The project context and the orchestration go to AGENTS.md — the file every
  // harness reads; harnesses with their own instructions file get a pointer to it.
  try {
    if (await emitProjectContext(ctx.projectRoot, config)) {
      report.info(`${PROJECT_SOURCE} → ${AGENTS_MD}`);
    }
  } catch (err) {
    report.failed(err, `${PROJECT_SOURCE} → ${AGENTS_MD}`);
    totalErrors++;
  }
  for (const file of ensureProjectPointers(ctx.projectRoot, adapters)) {
    report.info(`${file} → points at ${AGENTS_MD}`);
  }
  // A build with errors may not have seen every perimeter: it installs the hook, never removes it.
  if (guarded || totalErrors === 0) {
    for (const adapter of adapters) {
      if (!adapter.projectSettings) continue;
      const { touched, problem } = adapter.projectSettings(ctx.projectRoot, { guarded });
      if (problem) { report.info(problem); totalErrors++; }
      for (const file of touched) report.info(`${file} → ${guarded ? 'keeps the perimeter of the work in progress' : 'perimeter hook removed'}`);
    }
  }

  try {
    const orchResult = await ensureOrchestrationSection({
      cwd: ctx.projectRoot,
      standaloneAgentsDir: standaloneDir(config.agentsDir),
      teamsDir: config.teamsDir,
      libraryRoots: libraryRootsOf(config),
      libraries: librariesAliasMap(config),
      config,
    });
    if (orchResult.action !== 'unchanged') {
      report.info(`${AGENTS_MD} orchestration ${orchResult.action} (${orchResult.standalones.length} standalone, ${orchResult.teams.length} team(s))`);
    }
  } catch (err) {
    report.failed(err, `to update ${AGENTS_MD} orchestration`);
    totalErrors++;
  }

  // Programs left behind by an edited or removed piece — reported, never
  // deleted; only after a clean build, when every live contract is known.
  if (totalErrors === 0) {
    for (const orphan of orphanPrograms(ctx.projectRoot, programIds)) {
      report.info(`${orphan} is the program of no piece any more (edited or removed) — review it, then delete it`);
    }
    // The cache of a dimension edited or removed answers nothing any more: it goes.
    for (const stale of removeStaleCaches(ctx.projectRoot, defhashes)) {
      report.info(`${stale} removed — the cache of a dimension that no longer exists (edited or removed)`);
    }
  }

  if (judge) finishJudgeRun(judge, { prune: totalErrors === 0 });

  report.done({ agents: queue.length, adapters: adapters.length, files: written.size, failures: totalErrors });
  return totalErrors === 0;
}

async function runWatchLoop(
  config: Config,
  adapters: AdapterPlugin[],
  ctx: AdapterCtx,
): Promise<void> {
  const { default: chokidar } = await import('chokidar');
  const watchPaths: string[] = [
    config.agentsDir,
    ...config.libraryRoot ? [config.libraryRoot] : [],
    ...(config.sharedLibraries ?? []).filter(l => l.watch).map(l => l.path),
    resolve(ctx.projectRoot, PROJECT_SOURCE),
    BUILTIN_LIBRARY_ROOT,
  ];
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: (p: string) => /\.agent-pack\/|node_modules|\.git\//.test(p),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const triggerRebuild = (event: string, p: string) => {
    if (!p.endsWith('.ap') && !p.endsWith('.yml')) return;
    reporter().note(`[watch] ${event} ${p}`);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return;
      running = true;
      try {
        await bundleAllOnce(config, adapters, ctx);
      } catch (err) {
        reporter().note(`[watch] error: ${err instanceof Error ? err.message : err}`);
      } finally {
        running = false;
      }
    }, 200);
  };
  watcher.on('add', (p: string) => triggerRebuild('add', p));
  watcher.on('change', (p: string) => triggerRebuild('change', p));
  watcher.on('unlink', (p: string) => triggerRebuild('unlink', p));

  reporter().note('[watch] watching for .ap changes (Ctrl+C to stop)');
  process.on('SIGINT', () => {
    watcher.close().then(() => process.exit(0));
  });
  await new Promise<void>(() => {});
}

function writeFiles(files: EmittedFile[]): void {
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, 'utf-8');
    reporter().written(f.path);
  }
}

/**
 * The reporter of this run: the pretty one on a terminal; the plain one with
 * `--plain`, `NO_COLOR`, or when stderr is no terminal (a pipe, CI, a test).
 */
function chooseReporter(args: string[]) {
  const plain = args.includes('--plain') || 'NO_COLOR' in process.env || !process.stderr.isTTY;
  if (plain) return plainReporter;
  process.stderr.write(`\n${banner(packageInfo(), { columns: process.stderr.columns }).join('\n')}\n\n`);
  return prettyReporter({ verbose: args.includes('--verbose'), root: process.cwd() });
}
