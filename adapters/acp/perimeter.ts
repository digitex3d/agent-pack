// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** The copy as the ACP client's perimeter: what is inside it, and the permissions it approves (fail closed). */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { list, obj, str, type Params } from './rpc.js';
import { OPTION_KIND, PERMISSION_OUTCOME, TOOL_KIND } from './protocol.js';

/** A path as it really is: symlinks and `..` resolved, through its nearest existing folder when it does not exist yet. */
function realPath(path: string): string {
  let at = resolve(path);
  const rest: string[] = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    rest.unshift(basename(at));
    at = up;
  }
  return join(realpathSync(at), ...rest);
}

/** Whether `path` — relative to the copy, or absolute — is the copy or inside it, once resolved. */
export function insideCopy(copy: string, path: string): boolean {
  const root = realPath(copy);
  const real = realPath(resolve(copy, path));
  return real === root || real.startsWith(`${root}${sep}`);
}

/** The keys of a tool call's raw input that name a path it touches. */
const PATH_KEY_RE = /path|^cwd$|^(file|dir|directory|source|destination|target)$/i;

/** Every path a tool call says it touches: its locations, and the path fields of its raw input. */
function touchedPaths(toolCall: Params): string[] {
  const paths = list(toolCall.locations).flatMap(l => str(obj(l).path) ?? []);
  const fields = Object.entries(obj(toolCall.rawInput)).filter(([key]) => PATH_KEY_RE.test(key));
  for (const [, value] of fields) paths.push(...(Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v !== ''));
  return paths;
}

/** Whether a permission request is approved — only when every path it touches is inside the copy — and why not. */
export function permissionVerdict(copy: string, toolCall: Params, terminal: boolean): { allow: true } | { allow: false; why: string } {
  const execute = toolCall.kind === TOOL_KIND.execute;
  if (execute && !terminal) return { allow: false, why: 'it runs a command, and terminals are not enabled for this server' };
  const paths = touchedPaths(toolCall);
  // A command with no path of its own runs in the session's cwd: the copy.
  if (paths.length === 0 && execute) paths.push(copy);
  if (paths.length === 0) return { allow: false, why: 'it names no path the client can check' };
  const outside = paths.filter(p => !insideCopy(copy, p));
  return outside.length ? { allow: false, why: `it touches ${outside.join(', ')}, outside the copy` } : { allow: true };
}

/** The kinds of option that approve a request, and those that refuse it — the first one offered answers. */
const ALLOW_KINDS = [OPTION_KIND.allowOnce, OPTION_KIND.allowAlways] as const;
export const REJECT_KINDS = [OPTION_KIND.rejectOnce, OPTION_KIND.rejectAlways] as const;

/** The option of a permission request of the first of `kinds` it offers — null when it offers none. */
export function optionOf(options: unknown, kinds: readonly string[]): string | null {
  const offered = list(options).map(obj);
  for (const kind of kinds) {
    const id = str(offered.find(o => o.kind === kind)?.optionId);
    if (id) return id;
  }
  return null;
}

/** The outcome that answers a permission request: the option selected — cancelled when there is none to select. */
export function outcomeOf(optionId: string | null): Params {
  return { outcome: optionId ? { outcome: PERMISSION_OUTCOME.selected, optionId } : { outcome: PERMISSION_OUTCOME.cancelled } };
}

/** What a permission request is for, as a verdict names it: its tool call's title, else its id. */
export function requestName(params: Params): string {
  const toolCall = obj(params.toolCall);
  return str(toolCall.title) ?? str(toolCall.toolCallId) ?? 'a tool call';
}

/** A permission decided: what it was for, whether it was allowed, and why. */
export interface Verdict {
  what: string;
  allowed: boolean;
  why: string;
}

/**
 * The answer to `session/request_permission`, decided without asking: an
 * allow option when the verdict approves and one is offered, else a reject
 * option — cancelled when none is offered. Each verdict is handed to `decided`.
 */
export function answerPermission(copy: string, params: Params, terminal: boolean, decided: (v: Verdict) => void): Params {
  const what = requestName(params);
  const verdict = permissionVerdict(copy, obj(params.toolCall), terminal);
  const allow = verdict.allow ? optionOf(params.options, ALLOW_KINDS) : null;
  if (allow) {
    decided({ what, allowed: true, why: 'every path it touches is inside the copy' });
    return outcomeOf(allow);
  }
  decided({ what, allowed: false, why: verdict.allow ? 'it offers no option to allow it once or always' : verdict.why });
  return outcomeOf(optionOf(params.options, REJECT_KINDS));
}
