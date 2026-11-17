// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { loadConfig, type Config, libraryRoots as libraryRootsOf, librariesAliasMap, BUILTIN_LIBRARY_ROOT, packageInfo } from '../config.js';
import { AdapterRegistry } from '../adapter-registry.js';
import type { AdapterCtx, AdapterPlugin, EmittedFile } from '../../adapters/types.js';
import { bundleAndEmit, unitDocument } from '../bundlers/run.js';
import { orphanPrograms } from '../executor.js';
import { emitProjectContext, ensureProjectPointers, AGENTS_MD } from '../projectContext.js';
import { readMainFile } from '../services/mainMetadata.js';
import { ensureOrchestrationSection, buildOrchestrationContent, type OrchestrationSectionResult } from '../orchestrationSection.js';
import { removeMdBlock } from '../services/mdBlock.js';
import { discoverAgentsByWalk } from '../agentDiscovery.js';
import { standaloneDir, teamNamesUnder } from '../services/teamMetadata.js';
import { openJudgeRun, finishJudgeRun, type JudgeRun } from '../judge/phase.js';
import { documentDefHashes, removeStaleCaches } from '../apx/dimensions.js';
import { reporter, useReporter, plainReporter } from '../report.js';
import { prettyReporter } from '../../reporters/pretty/index.js';
import { banner } from '../../reporters/pretty/logo.js';
import { colorOn } from '../../adapters/acp/ansi.js';
import { apxPath, binPath } from '../apx/paths.js';
import { unitApxFiles, unitPayload, apxChecks } from '../apx/write.js';
import { unitAgents } from '../apx/unit.js';
import type { UnitSection } from '../apx/payload.js';
import { buildExecutable, bunInstalled } from './executable.js';

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
  let executable = false;
  let target: string | null = null;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--adapter' && args[index + 1]) adapterName = args[++index];
    else if (args[index] === '--executable') executable = true;
    else if (args[index] === '--target' && args[index + 1]) target = args[++index];
    else if (args[index] === '--out' && args[index + 1]) outputDir = args[++index];
    else if (args[index] === '--watch') watch = true;
    else if (args[index] === '--apx-compress') config.bundle.apxCompress = true;
    else if (args[index] === '--no-apx-compress') config.bundle.apxCompress = false;
    else if (args[index] === '--no-judge') config.judge = null;
    else if (args[index] === '--judge-strict') { if (config.judge) config.judge.offline = 'error'; }
    else if (args[index] === '--config') index++;
    else if (!args[index].startsWith('--') && !source) source = args[index];
  }
  useReporter(chooseReporter(args));
  const report = reporter();

  if (!source) {
    report.note('Usage:');
    report.note('  agent-pack bundle <name|path> [--adapter <name>] [--out <dir>] [--executable [--target <bun target>]] [--apx-compress|--no-apx-compress] [--no-judge|--judge-strict] [--plain] [--verbose]');
    report.note('  agent-pack bundle all       [--adapter <name>] [--out <dir>] [--watch] [--apx-compress|--no-apx-compress] [--no-judge|--judge-strict] [--plain] [--verbose]');
    process.exit(1);
  }

  if (watch && source !== 'all') {
    report.note('--watch is only supported with `bundle all`.');
    process.exit(1);
  }
  // `bundle <unit>` — the main or a team — builds every agent, then the units' apx; with --executable, that unit's executable.
  const unit = source === null || source === 'all' ? null : unitNamed(source, config);
  if (executable && source === 'all') {
    report.note('--executable makes one file of what it names — `bundle all --executable` would make one per agent; name the main, for all of them in one, or an agent.');
    process.exit(1);
  }
  if (target && !executable) {
    report.note('--target is the platform of an executable — use it with --executable.');
    process.exit(1);
  }
  if (executable && !bunInstalled()) {
    report.note('--executable needs Bun on the PATH (https://bun.sh) — install it, then run again.');
    process.exit(1);
  }


  const ctx: AdapterCtx = {
    projectRoot: process.cwd(),
    outputDir: outputDir ?? config.outputDir,
  };

  if (source === 'all' || unit) {
    await runBundleAll(config, adapterName, ctx, watch, unit && executable ? { ...unit, target } : null);
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
    if (executable) {
      buildExecutable(built.name, ctx.projectRoot, target);
      report.info(`${built.name} → ${binPath(built.name, target)}`);
    }
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
  executable: UnitExecutable | null = null,
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
  const ok = await bundleAllOnce(config, adapters, ctx, executable);
  if (!watch) {
    if (!ok) process.exit(1);
    return;
  }

  await runWatchLoop(config, adapters, ctx);
}

/** The unit — the main or a team — to compile into one executable after its apx, and for which platform. */
interface UnitExecutable {
  kind: UnitSection['kind'];
  name: string;
  target: string | null;
}

/** The unit a name names — the main, by its file's name, or a team — or null when it names neither. */
function unitNamed(name: string, config: Config): Pick<UnitExecutable, 'kind' | 'name'> | null {
  let main: string | null = null;
  try { main = readMainFile(process.cwd())?.name ?? null; } catch { main = null; }
  if (name === main) return { kind: 'main', name };
  return teamNamesUnder(config.teamsDir).includes(name) ? { kind: 'team', name } : null;
}

export async function bundleAllOnce(
  config: Config,
  adapters: AdapterPlugin[],
  ctx: AdapterCtx,
  executable: UnitExecutable | null = null,
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

  /** The agents whose build failed: the main carries them as their last apx has them. */
  const failed = new Set<string>();
  // The default delegate joins the build when some agent hands it work and the project has none of that name.
  const queue = [...agents];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const agent = queue[queueIndex];
    for (const adapter of adapters) {
      try {
        const { bundle, files } = await bundleAndEmit(agent.name, config, adapter, ctx, { judge });
        for (const spec of Object.values(bundle.structure?.meta.executors ?? {})) if (spec.program) programIds.add(spec.program);
        if (bundle.structure) for (const hash of documentDefHashes(bundle.structure)) defhashes.add(hash);
        const meta = bundle.structure?.meta;
        if (bundle.structure && (bundle.structure.perimeter() || meta?.background || meta?.marks)) guarded = true;
        const delegate = bundle.structure?.meta.delegate;
        if (delegate && !queue.some(queued => queued.name === delegate)) queue.push({ name: delegate });
        for (const file of files) {
          const prior = written.get(file.path);
          if (prior?.content === file.content || (prior && file.path.startsWith(shared))) continue;
          if (prior && prior.adapter !== adapter.name) {
            report.info(`adapters ${prior.adapter} and ${adapter.name} both write ${file.path} — keep only one of them in the config`);
            totalErrors++;
            continue;
          }
          written.set(file.path, { adapter: adapter.name, content: file.content });
          writeFiles([file]);
        }
      } catch (err) {
        report.failed(err, `agent ${agent.name} on ${adapter.name}`);
        failed.add(agent.name);
        totalErrors++;
      }
    }
  }

  // Each unit's own document — every team's and the main's: its flows, by the one compiler.
  // What they start in the background and what they MARK is the unit's, and keeps the perimeter too.
  const unitDocuments = new Map<string, string>();
  let mainName: string | null = null;
  try { mainName = readMainFile(ctx.projectRoot)?.name ?? null; } catch { mainName = null; }
  for (const name of [...teamNamesUnder(config.teamsDir), ...(mainName ? [mainName] : [])]) {
    try {
      const unit = await unitDocument(name, config, ctx, { adapter: adapters[0], judge });
      writeFiles(unit.files);
      unitDocuments.set(name, unit.document);
      const meta = unit.structure.meta;
      if (meta.background || meta.marks) guarded = true;
    } catch (err) {
      report.failed(err, name === mainName ? `the main ${name}` : `team ${name}`);
      totalErrors++;
    }
  }

  // The project context and the orchestration go to AGENTS.md — the file every
  // harness reads; harnesses with their own instructions file get a pointer to it.
  let project: Awaited<ReturnType<typeof emitProjectContext>> = null;
  try {
    // AGENTS.md boots the main by the form it is run in: its executable when this build makes one, else its apx.
    project = await emitProjectContext(ctx.projectRoot, config, executable?.kind === 'main' ? `${binPath(executable.name, executable.target)} start` : null);
    if (project) report.info(`${project.file} → ${AGENTS_MD}`);
  } catch (err) {
    report.failed(err, `the main → ${AGENTS_MD}`);
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

  let held: Pick<OrchestrationSectionResult, 'held' | 'content'> | null = null;
  /** Every team of the project, listed in the main or not, with the text its own apx prints. */
  const teamUnits: UnitSection[] = [];
  try {
    const opts = {
      cwd: ctx.projectRoot,
      standaloneAgentsDir: standaloneDir(config.agentsDir),
      teamsDir: config.teamsDir,
      libraryRoots: libraryRootsOf(config),
      libraries: librariesAliasMap(config),
      config,
    };
    for (const name of teamNamesUnder(config.teamsDir)) {
      const team = await buildOrchestrationContent({ ...opts, team: name });
      const heldTeam = team.held.teams[0];
      if (heldTeam) teamUnits.push({ kind: 'team', name: heldTeam.name, about: heldTeam.about, version: '', teams: [heldTeam], members: [], text: `${team.content}\n` });
    }
    if (project) {
      // With a main, the orchestration is the main's: its apx prints it, AGENTS.md no longer holds it.
      held = await buildOrchestrationContent(opts);
      if (removeMdBlock(resolve(ctx.projectRoot, AGENTS_MD), 'orchestration')) report.info(`${AGENTS_MD} orchestration → ${apxPath(project.main.name)}`);
    } else {
      const orchResult = await ensureOrchestrationSection(opts);
      held = orchResult;
      if (orchResult.action !== 'unchanged') {
        report.info(`${AGENTS_MD} orchestration ${orchResult.action} (${orchResult.standalones.length} standalone, ${orchResult.teams.length} team(s))`);
      }
    }
  } catch (err) {
    report.failed(err, `to update ${AGENTS_MD} orchestration`);
    totalErrors++;
  }

  // The units' apx — the main's and each team's: the engine once, what the unit is, and the image of every agent it holds.
  // The teams first: the main holds each team's apx image.
  const units: UnitSection[] = [...teamUnits];
  if (held && project) {
    const { main } = project;
    units.push({ kind: 'main', name: main.name, about: main.about, version: main.version, ...held.held, text: `${project.content.trim()}\n\n${held.content.trim()}\n` });
  }
  const agentNames = new Set(queue.map(queued => queued.name));
  const limits = { waitMax: config.wait?.max ?? null, markMax: config.mark?.max ?? null, drivers: config.drivers ?? null };
  for (const section of units) {
    try {
      if (agentNames.has(section.name)) throw new Error(`the ${section.kind} ${section.name} is called like an agent — both would be ${apxPath(section.name)}: rename one`);
      for (const agent of unitAgents(section).filter(agentName => failed.has(agentName))) {
        report.info(`${agent} failed to build: the ${section.kind} ${section.name} carries it as its last apx has it`);
      }
      // A team's own document — its flows, by the one compiler — is its apx's own image.
      const document = unitDocuments.get(section.name);
      if (document === undefined) throw new Error(`its document failed to build — fix it, then bundle again`);
      const own = document === undefined ? null : unitPayload(document, apxChecks(config, ctx.projectRoot), limits);
      writeFiles(unitApxFiles(section, ctx.projectRoot, own, config.bundle.apxCompress === true));
      if (executable?.name === section.name) {
        await unitExecutable(section, executable.target, ctx.projectRoot, config);
        report.info(`${section.name} → ${binPath(section.name, executable.target)}`);
      }
    } catch (err) {
      report.failed(err, `to write the apx of the ${section.kind} ${section.name}`);
      totalErrors++;
    }
  }
  if (executable && !units.some(unit => unit.name === executable.name)) {
    report.info(`no ${executable.kind} ${executable.name} was built — its executable was not made`);
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

/** Compile a unit's apx into its executable — when Bun fails on the main's, AGENTS.md goes back to the apx it can run; then it throws. */
async function unitExecutable(unit: UnitSection, target: string | null, projectRoot: string, config: Config): Promise<void> {
  try {
    buildExecutable(unit.name, projectRoot, target);
  } catch (err) {
    if (unit.kind === 'main') await emitProjectContext(projectRoot, config, null);
    throw err;
  }
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
    ...(config.sharedLibraries ?? []).filter(library => library.watch).map(library => library.path),
    // The main's file sits at the project root, under a name of its own: every root .ap is watched.
    ...readdirSync(ctx.projectRoot).filter(name => name.endsWith('.ap')).map(name => resolve(ctx.projectRoot, name)),
    BUILTIN_LIBRARY_ROOT,
  ];
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    ignored: (watchedPath: string) => /\.agent-pack\/|node_modules|\.git\//.test(watchedPath),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const triggerRebuild = (event: string, filePath: string) => {
    if (!filePath.endsWith('.ap') && !filePath.endsWith('.yml')) return;
    reporter().note(`[watch] ${event} ${filePath}`);
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
  watcher.on('add', (filePath: string) => triggerRebuild('add', filePath));
  watcher.on('change', (filePath: string) => triggerRebuild('change', filePath));
  watcher.on('unlink', (filePath: string) => triggerRebuild('unlink', filePath));

  reporter().note('[watch] watching for .ap changes (Ctrl+C to stop)');
  process.on('SIGINT', () => {
    watcher.close().then(() => process.exit(0));
  });
  await new Promise<void>(() => {});
}

function writeFiles(files: EmittedFile[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf-8');
    reporter().written(file.path);
  }
}

/**
 * The reporter of this run: the pretty one on a terminal; the plain one with
 * `--plain`, `NO_COLOR`, or when stderr is no terminal (a pipe, CI, a test).
 */
function chooseReporter(args: string[]) {
  const plain = args.includes('--plain') || !colorOn() || !process.stderr.isTTY;
  if (plain) return plainReporter;
  process.stderr.write(`\n${banner(packageInfo(), { columns: process.stderr.columns }).join('\n')}\n\n`);
  return prettyReporter({ verbose: args.includes('--verbose'), root: process.cwd() });
}
