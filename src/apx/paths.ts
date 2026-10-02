// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Where agent-pack's runtime files live, relative to the project root — the
 * one place every writer, renderer and the apx engine read them from. No
 * imports: the apx engine bundles this module.
 */

/** The apx files — build output, outside git. */
export const APX_DIR = '.agent-pack/apx';

/** Where an agent's `LASTS session` stores live: beside its apx. */
export function storeStateDir(agent: string): string {
  return `${APX_DIR}/${agent}.state`;
}

/** Where an agent's `LASTS project` stores live: at the project root, the project's to version. */
export function projectStoreDir(agent: string): string {
  return `stores/${agent}`;
}

/** The path of an agent's apx — how every printed command names it. */
export function apxPath(agent: string): string {
  return `${APX_DIR}/${agent}.apx`;
}

/** The command that runs an agent's apx, with its verb and arguments. */
export function apxCommand(agent: string, ...args: string[]): string {
  return ['node', apxPath(agent), ...args].join(' ');
}

/** The project root, from the path of an apx file inside it — the inverse of `apxPath`. */
export function projectRootOf(apxFile: string): string {
  return [apxFile, ...APX_DIR.split('/').map(() => '..'), '..'].join('/');
}

/**
 * The flow scripts an adapter compiles for its harness — build output, outside
 * git: `<flow id>.<content hash>.<ext>`, so an edited flow never finds an old one.
 */
export const FLOWS_DIR = '.agent-pack/flows';

/** A flow script's name before its extension — the hash is the flow block's content hash. */
export function flowScriptStem(id: string, contentHash: string): string {
  return `${id}.${contentHash.replace(/^sha256:/, '').slice(0, 8)}`;
}

/** The file a flow's script is written to. */
export function flowScriptFile(id: string, contentHash: string, ext: string): string {
  return `${flowScriptStem(id, contentHash)}.${ext}`;
}

/**
 * The session state — build output's sibling, outside git: one folder per
 * harness session. What sits inside is the variables seam's (sessionVars.ts).
 */
export const STATE_DIR = '.agent-pack/state';

/** The distilled scripts — written by agents, versioned with the sources. */
export const DISTILLED_DIR = 'distilled';
