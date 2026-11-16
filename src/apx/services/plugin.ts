// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The service of a plugin (src/plugins.ts) — one for every plugin whose blocks
 * the agent holds, built from its spec in the document. Before the plugin's
 * code runs, everything its manifest says is checked here: the operation is
 * one it declares, the id is one of the agent's blocks of its kind, the input
 * fits the operation's template. Then its function is called with all of it:
 *
 *   tick({ block, input, state, out })   → an exit code, or { refuse: why }
 *
 * `state` is the block's memory in this session, written only when the
 * function returns without throwing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginBlock } from '../../apdoc/blocks.js';
import { STATE_DIR } from '../paths.js';
import { inputUsage, recordIssues, recordOfArgs, type PluginSpec } from '../../plugins.js';
import { serviceCommand, type ApxContext, type ApxOutput, type ApxService, type ApxSession } from '../service.js';

type Result = number | { refuse: string } | void;
type Operation = (call: { block: Record<string, unknown>; input: Record<string, unknown>; state: { get(fallback: unknown): unknown; set(value: unknown): void }; out(line: string): void }) => Result | Promise<Result>;

/** The apx service of one plugin. */
export function pluginService(spec: PluginSpec): ApxService {
  return {
    kind: spec.name,
    about: spec.about,
    operations: spec.operations.map(operation => ({ op: operation.op, args: `<${spec.prefix}-id> ${inputUsage(spec, operation.input)}`.trimEnd(), about: operation.about })),
    serve: (host, op, args) => serve(host, spec, op, args),
  };
}

async function serve(host: ApxOutput & ApxContext & ApxSession, spec: PluginSpec, op: string | undefined, args: string[]): Promise<number> {
  const blocks = host.doc.byKind(spec.name) as PluginBlock[];
  const operations = spec.operations.map(operationSpec => operationSpec.op).join('|');
  if (!op) {
    for (const pluginBlock of blocks) host.out(`${pluginBlock.id}  ${pluginBlock.name}${pluginBlock.about ? `  — ${pluginBlock.about}` : ''}`);
    return 0;
  }
  const operation = spec.operations.find(candidate => candidate.op === op);
  if (!operation) return host.fail(2, `'${op}' is no operation of ${spec.name} — ${host.cmd} ${spec.name} ${operations} <${spec.prefix}-id> …`);
  const [id, ...rest] = args;
  const block = id ? blocks.find(candidate => candidate.id === id) : undefined;
  if (!block) {
    const known = blocks.map(pluginBlock => `${pluginBlock.id} (${pluginBlock.name})`).join(', ') || 'none';
    return host.fail(2, `${id ? `no ${spec.name} \`${id}\` in this agent` : `${spec.name} ${op} takes an id (${spec.prefix}-…)`} — its ${spec.folder}: ${known}`);
  }
  const usage = `${serviceCommand(host.cmd, spec.name, op, block.id)} ${inputUsage(spec, operation.input)}`.trimEnd();
  if (!operation.input && rest.length > 0) return host.fail(2, `${spec.name} ${op} takes nothing after the id — ${usage}`);
  const read = recordOfArgs(spec, operation.input, rest, () => readFileSync(0, 'utf-8'));
  if ('error' in read) return host.fail(2, `${read.error} — ${usage}`);
  const issues = operation.input ? recordIssues(spec, operation.input, read.record) : null;
  if (issues) return host.fail(2, `${issues} — ${usage}`);

  // Its state, read when asked and written once the operation has returned.
  let file: string | null = null;
  let written: { value: unknown } | null = null;
  const stateFile = (): string => {
    if (file) return file;
    const session = host.sessionIdOrReason(`the state of ${spec.name} needs`);
    if ('reason' in session) throw new Refusal(session.reason);
    return (file = join(host.projectRoot, STATE_DIR, session.id, 'plugins', spec.name, `${block.id}.json`));
  };
  const state = {
    get: (fallback: unknown): unknown => {
      if (written) return written.value;
      const path = stateFile();
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback;
    },
    set: (value: unknown): void => { stateFile(); written = { value }; },
  };

  let result: Result;
  try {
    const mod = await import(pathToFileURL(spec.service).href) as Record<string, Operation>;
    result = await mod[op]({ block: { id: block.id, name: block.name, about: block.about, ...block.fields }, input: read.record, state, out: line => host.out(line) });
  } catch (error) {
    if (error instanceof Refusal) return host.fail(1, error.message);
    return host.fail(1, `${spec.name} ${op} failed: ${error instanceof Error ? error.message : error} — nothing of its state was written`);
  }
  if (written) {
    mkdirSync(dirname(file!), { recursive: true });
    writeFileSync(file!, `${JSON.stringify((written as { value: unknown }).value)}\n`);
  }
  if (result && typeof result === 'object') return host.fail(1, result.refuse);
  return typeof result === 'number' ? result : 0;
}

/** Why a state cannot be read or written — said to the agent, not thrown at it. */
class Refusal extends Error {}
