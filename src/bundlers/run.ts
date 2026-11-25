// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import { type AdapterCtx, type AdapterPlugin, type Bundle, type EmittedFile, type Emitter, emitterFor, neutralEmitter } from '../../adapters/types.js';
import { detectAndBuild } from './detect.js';
import type { BuildAgentOptions } from './agent.js';
import { apxFiles, apxChecks } from '../apx/write.js';
import { FLOWS_DIR, flowScriptFile } from '../apx/paths.js';
import { bundleAgentObjectFromConfig } from '../compiler/index.js';
import type { ApDocument } from '../apdoc/document.js';

/**
 * Single pipeline: detect kind → build bundle → pick the adapter's emitter for
 * that kind → emit files. With no adapter the bundle falls back to plain
 * markdown under `outputDir`.
 * Returns both the materialized files and the bundle object so callers can
 * inspect metadata (e.g. dynamicEntries) without re-running the bundler.
 */
export async function bundleAndEmit(
  source: string,
  config: Config,
  adapter: AdapterPlugin | undefined,
  ctx: AdapterCtx,
  buildOpts: BuildAgentOptions = {},
): Promise<{ bundle: Bundle; files: EmittedFile[] }> {
  const bundle = await detectAndBuild(source, config, { ...buildOpts, adapter });
  let emit: Emitter = neutralEmitter;
  if (adapter) {
    emit = emitterFor(adapter, bundle);
  }
  const files = emit(bundle, ctx);
  if (bundle.structure) {
    // Every agent — and every skill, an agent too — gets its apx, whatever the adapter writes into its harness.
    files.push(...agentArtifacts(bundle.name, bundle.structure.asJson(), config, ctx));
    files.push(...flowScriptFiles(bundle.structure, adapter, ctx.projectRoot));
  }
  return { bundle, files };
}

/** A document's compiled file, `<outputDir>/<name>.ap.json` — an agent's or a unit's. */
export function compiledFile(name: string, document: string, config: Config): EmittedFile {
  return { path: resolve(config.outputDir, `${name}.ap.json`), content: document };
}

/** An agent's own artifacts, from its document: its compiled file and its apx. */
export function agentArtifacts(name: string, document: string, config: Config, ctx: AdapterCtx): EmittedFile[] {
  const limits = { waitMax: config.wait?.max ?? null, markMax: config.mark?.max ?? null, drivers: config.drivers ?? null };
  return [compiledFile(name, document, config), ...apxFiles(name, document, ctx.projectRoot, config.bundle.apxCompress === true, apxChecks(config, ctx.projectRoot), limits)];
}

/** The flows a document holds, as the harness's own scripts — when its adapter runs flows so. */
function flowScriptFiles(structure: ApDocument, adapter: AdapterPlugin | undefined, projectRoot: string): EmittedFile[] {
  const runner = adapter?.flowScript;
  if (!runner) return [];
  return structure.byKind('flow').flatMap(flow => {
    const script = runner.compile(flow, structure);
    return script ? [{ path: resolve(projectRoot, FLOWS_DIR, flowScriptFile(flow.id, flow.contentHash, runner.ext)), content: script }] : [];
  });
}

/**
 * A unit's document — a team's: the same compiler, on the team's file, rooted
 * at its TEAM block — with the files it brings: its compiled document beside
 * every agent's, and its flows as the adapter's scripts.
 */
export async function unitDocument(name: string, config: Config, ctx: AdapterCtx, buildOpts: BuildAgentOptions = {}): Promise<{ structure: ApDocument; document: string; files: EmittedFile[] }> {
  const { adapter } = buildOpts;
  const { structure } = await bundleAgentObjectFromConfig(name, config, {
    bundleConfig: config.bundle, lintConfig: config.lint, adapter, judge: buildOpts.judge, vars: { name },
  });
  if (!structure) throw new Error(`${name}: no document was compiled`);
  const document = structure.asJson();
  return { structure, document, files: [compiledFile(name, document, config), ...flowScriptFiles(structure, adapter, ctx.projectRoot)] };
}
