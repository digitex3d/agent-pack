// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The md ADAPTER backend — the prose representation of an ApDocument.
 *
 * `renderMd(doc)` is the document-level composition: bootstrap, identity,
 * then the document's outline item by item (chapters, tag groups, entries,
 * cross-references) — structure and prose cannot diverge because both come
 * from the one outline. The pieces (`mdEnv`, `renderPreamble`, `renderEntry`)
 * are exported for the apx, which renders the same text block by block.
 * Node-level rendering lives in toolkit.ts; per-kind md lives in each block
 * class (`asMdBody`, `AgentBlock.asMdIdentity`). The core compiler consumes
 * this backend for the neutral body; harness adapters build on that body.
 */
import type { AgentBlock } from '../../src/apdoc/blocks.js';
import type { ApBlock } from '../../src/apdoc/block.js';
import { ApDocument } from '../../src/apdoc/document.js';
import { renderNodes, MdEnv } from './toolkit.js';
import { OwnsPrimitive } from '../../src/primitives.js';
import type { ApMdMeta } from '../../src/apdoc/types.js';
import { FORMULAS, fill, refSuffix, headingLine } from '../../src/formulas.js';
import { apxCommand } from '../../src/apx/paths.js';

const D = FORMULAS.document;


/** An empty md-meta — a document compiled without prose metadata renders bare. */
const EMPTY_MD: ApMdMeta = {
  bootstrap: '', intros: {}, vars: {}, breadcrumbs: {},
  agentBodyLead: 1, ownsInBody: true, provenance: {}, shapePos: {},
};

/**
 * The form a reference to a block takes, given the block's id: ` (tpl-…)` in
 * the md; the apx passes its own (` [node … get tpl-…]`).
 */
export type RefForm = (id: string) => string;

/** The render environment of a document, with references in the given form. */
export function mdEnv(
  doc: ApDocument,
  refForm: RefForm = refSuffix,
  apxOf: (agent: string | null) => string = agent => apxCommand(agent ?? doc.root()?.name ?? ''),
): MdEnv {
  const src = doc.mdSource ?? EMPTY_MD;
  // Substitution: `{{var}}` → value.
  const subRe = /\{\{(\w+)\}\}/g;
  return {
    forceLevels: doc.meta.forceLevels,
    refOf: target => {
      const id = doc.block(target)?.id;
      return id ? refForm(id) : '';
    },
    substitute: text => text.replace(subRe, (_m, varName: string) => src.vars[varName] ?? `{{${varName}}}`),
    apxOf,
    agent: doc.root()?.name ?? '',
  };
}

/**
 * The preamble — the agent definition, never trimmed: OWNS fence, bootstrap
 * (team membership + shared + runtime defaults), identity + lens, the agent's
 * own body (rules, WHEN workflows).
 */
export function renderPreamble(doc: ApDocument, env: MdEnv): string {
  const src = doc.mdSource ?? EMPTY_MD;
  const root = doc.root() as AgentBlock | null;
  let out = '';

  // OWNS fence — before everything, the scope warning (body-side only when
  // the active adapter did not claim OWNS into frontmatter).
  const owns = doc.owns();
  if (owns && src.ownsInBody) out += OwnsPrimitive.renderNeutral(owns.split(/\s*,\s*/));

  // Bootstrap: team membership + shared + runtime defaults (from meta.md).
  out += src.bootstrap;

  if (root) {
    // Identity + lens — the agent block owns its own md preamble.
    const roleBlock = root.role ? doc.resolve(root.role) : null;
    out += root.asMdIdentity(env, roleBlock);

    // The agent's own body (rules, WHEN workflows). The legacy strip leaves
    // leading blank lines before the first rule — reproduce their count.
    const body = renderNodes(env, root.body).join('\n');
    if (body.trim()) out += `${'\n'.repeat(src.agentBodyLead)}${body}\n\n`;
  }
  return out;
}

/** One block's own section: its heading at `depth`, then its body. */
export function renderEntry(block: ApBlock, depth: number, env: MdEnv): string {
  const about = block.about ? fill(D.about, { about: block.about }) : '';
  return `${headingLine(depth, fill(D.entry, { name: block.name, about }))}\n${block.asMdBody(env).trim()}\n\n`;
}

/**
 * The md representation — the prose bundle as a projection of the document
 * (plus its attached environmental texts): the preamble, then one render per
 * item of the document's outline.
 */
export function renderMd(doc: ApDocument, refForm: RefForm = refSuffix): string {
  const src = doc.mdSource ?? EMPTY_MD;
  const env = mdEnv(doc, refForm);
  let out = renderPreamble(doc, env);

  for (const item of doc.computeOutline()) {
    switch (item.type) {
      case 'chapter': {
        out += `${headingLine(1, item.title)}\n\n`;
        const intro = item.intro ? src.intros[item.intro] ?? '' : '';
        if (intro) out += `${intro}\n\n`;
        break;
      }
      case 'group':
        out += `${headingLine(item.depth, item.title)}\n\n`;
        break;
      case 'entry':
        out += renderEntry(doc.block(item.address)!, item.depth, env);
        break;
      case 'crossReferences':
        out += `${headingLine(1, item.title)}\n\n`;
        for (const row of item.rows) {
          const entries = row.entries.map(e => fill(D.crossReferences.entry, { name: e.name, ref: refForm(e.id) })).join(', ');
          out += `${fill(D.crossReferences.row, { tag: row.tag, entries })}\n`;
        }
        out += '\n';
        break;
    }
  }

  return out.trimEnd() + '\n';
}
