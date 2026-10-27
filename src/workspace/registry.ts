// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The workspace engines shipped with agent-pack, by name — the one table the
 * apx resolves `workspaces: { adapter: … }` through, as the judges are. A
 * second engine is an entry here, not a change to the apx.
 */
import gitWorkspace from '../../adapters/git/index.js';
import { fromBuiltins } from '../judge/builtins.js';
import type { WorkspaceEngine } from './types.js';

const BUILTIN_WORKSPACES: Record<string, () => WorkspaceEngine> = {
  git: () => gitWorkspace(),
};

/** A config entry as a workspace engine: a built-in by name, or an engine object as is. */
export const resolveWorkspace = fromBuiltins('workspace', BUILTIN_WORKSPACES);
