// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import { Config } from '../config.js';
import { AdapterCtx, AdapterPlugin, Bundle, EmittedFile, Emitter, emitterFor, neutralEmitter } from '../../adapters/types.js';
import { detectAndBuild } from './detect.js';
import { BuildAgentOptions } from './agent.js';
import { apxFiles, apxChecks } from '../apx/write.js';
import { FLOWS_DIR, flowScriptFile } from '../apx/paths.js';

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
    const document = bundle.structure.asJson();
    files.push({ path: resolve(config.outputDir, `${bundle.name}.ap.json`), content: document });
    // Every agent gets its apx, whatever the adapter writes into its harness.
    if (bundle.kind === 'agent') files.push(...apxFiles(bundle.name, document, ctx.projectRoot, config.bundle.apxCompress === true, apxChecks(config, ctx.projectRoot)));
    // The flows the agent's team runs, as the harness's own scripts.
    const runner = adapter?.flowScript;
    for (const flow of runner ? bundle.structure.byKind('flow') : []) {
      const script = runner!.compile(flow, bundle.structure);
      if (script) files.push({ path: resolve(ctx.projectRoot, FLOWS_DIR, flowScriptFile(flow.id, flow.contentHash, runner!.ext)), content: script });
    }
  }
  return { bundle, files };
}
