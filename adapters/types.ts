// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { resolve } from 'path';
import type { ApDocument } from '../src/apdoc/document.js';
import type { ApBlock } from '../src/apdoc/block.js';

export interface AdapterCtx {
  projectRoot: string;
  outputDir?: string;
}

export interface EmittedFile {
  path: string;
  content: string;
}

export type Emitter<B extends Bundle = Bundle> = (bundle: B, ctx: AdapterCtx) => EmittedFile[];

export const neutralEmitter: Emitter = (b, ctx) => [{
  path: resolve(ctx.projectRoot, ctx.outputDir ?? '.agent-pack/compiled', `${b.name}.md`),
  content: b.body,
}];

/**
 * What a bundle IS, as a plain string the core stamps at construction.
 *
 * This is the discriminator adapters dispatch on. It is deliberately NOT
 * `instanceof`: an adapter is imported by the user's `agent-pack.config.mjs`,
 * which resolves `agent-pack` from the PROJECT's node_modules, while the CLI may
 * run from a different install (global link, npx, a version-conflicted nested
 * copy). Those are separate module realms, so the adapter's `AgentBundle` class
 * is a different object from the one the core built the bundle with, and
 * `instanceof` returns false for a bundle that is, in every way that matters, an
 * agent. A string compares by value and is immune to that.
 */
export type BundleKind = 'agent' | 'playbook';

export abstract class Bundle {
  /** The core stamps this at construction — it is the only party that knows for sure. */
  abstract readonly kind: BundleKind;
  name: string = '';
  body: string = '';
  sourcePath: string = '';
  /**
   * All metadata-style primitives extracted from the source, keyed by
   * keyword. e.g. `metadata.get('ABOUT')[0]` is the description, and
   * `metadata.get('WHEN')` is the list of trigger lines (playbook).
   * Single source of truth — adapters obtain frontmatter fields by asking
   * each primitive how it contributes for the active adapter.
   */
  metadata: Map<string, string[]> = new Map();
  /**
   * Structured mirror of this bundle (apx format), stamped by the core when
   * the compile ran with a recorder. The IR the `.ap.json` artifact serializes;
   * adapters may consume it instead of `body` when they want structure.
   */
  structure?: ApDocument;
}

export class AgentBundle extends Bundle {
  readonly kind = 'agent' as const;
}

export class PlaybookBundle extends Bundle {
  readonly kind = 'playbook' as const;
}

/**
 * Per-kind emitters. An adapter declares WHAT IT CAN DO; it never inspects the
 * bundle to work out what it was handed. The core owns the discrimination —
 * it built the bundle, so it is the only party that knows the kind for certain,
 * and `emitterFor` below looks the handler up by `bundle.kind`.
 *
 * Every key is optional: an adapter that handles only agents simply omits
 * `playbook`, and is then a hard error if asked to emit one (see `emitterFor`).
 */
export interface AdapterEmitters {
  agent?: Emitter<AgentBundle>;
  playbook?: Emitter<PlaybookBundle>;
}

export interface AdapterPlugin {
  type: 'adapter';
  apiVersion: 2;
  name: string;
  emitters: AdapterEmitters;
  /**
   * Optional: the harness's own project-instructions file and the line that
   * points it at AGENTS.md (where agent-pack writes the project context and
   * the orchestration). Harnesses that read AGENTS.md natively need none.
   * Example: claude-code declares `{ file: 'CLAUDE.md', content: '@AGENTS.md' }`.
   */
  projectPointer?: { file: string; content: string };
  /**
   * Optional: harness-native renderings, keyed by keyword then value — the
   * values of an enum primitive (e.g. `{ CONTEXT: { full: '…' } }`) or the
   * levels of a force-level family (e.g. `{ MEM: { '0': '…' } }`).
   * The core renders each declared value with the adapter's string instead of
   * the neutral prose, falling back to the neutral rendering for any value the
   * adapter leaves out. This is how an abstract mode like `CONTEXT inherited`
   * compiles down to the concrete tool call this harness expresses it with.
   */
  renderings?: Record<string, Record<string, string>>;
  /**
   * Optional: the environment variable this harness puts its session id in. The
   * apx keeps session variables per session, and finds the session there; with
   * none declared, session variables cannot be read or written (fail closed).
   * Example: claude-code declares `CLAUDE_CODE_SESSION_ID`.
   */
  sessionEnv?: string;
  /**
   * Optional: the harness runs a flow as a script of its own, compiled from the
   * flow's steps and written to `.agent-pack/flows/`. `compile` returns null
   * for a flow the script cannot express — its steps are then carried out as
   * written. `apx flow <id>` prints `renderings.FLOW.run` when the script exists.
   * Example: claude-code compiles a Workflow tool script.
   */
  flowScript?: { ext: string; compile(flow: ApBlock, doc: ApDocument): string | null };
}

/**
 * Resolve the emitter an adapter declares for this bundle's kind — the core's
 * side of the dispatch.
 *
 * Throws when the adapter declares no emitter for the kind. That case is a real
 * misconfiguration (an adapter asked to emit something it cannot), and it must
 * be loud: the predecessor of this function silently left the bundle on a
 * fallback emitter, so a non-matching adapter wrote correct content to the wrong
 * path and reported success.
 */
export function emitterFor(adapter: AdapterPlugin, bundle: Bundle): Emitter {
  const emit = adapter.emitters[bundle.kind as keyof AdapterEmitters];
  if (!emit) {
    const declared = Object.keys(adapter.emitters).join(', ') || '(none)';
    throw new Error(
      `Adapter "${adapter.name}" declares no emitter for bundle kind "${bundle.kind}" ` +
      `(bundle: "${bundle.name}", declared kinds: ${declared}).`,
    );
  }
  return emit as Emitter;
}
