// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { renderKeywordBlock, } from './services/text.js';
import { FORMULAS, fill, refSuffix } from './formulas.js';
import { lex, type Keyword } from './lexer.js';
import type { BundleContext } from './dispatch/types.js';
import { resolveRunTarget } from './definition.js';
import { applyVars } from './vars.js';
import { splitList } from './lists.js';

/**
 * Per-primitive translation strategy.
 *
 * Each primitive (ABOUT, MANDATE, …) is stripped from `.ap` source and
 * translated into either:
 *   - a body injection rendered in the neutral compile (no adapter), or
 *   - one or more frontmatter fields rendered by a specific adapter.
 *
 * Adapters ask the primitive how to render themselves; the bundler does
 * not know each primitive's semantics.
 *
 * The `V` parameter is the shape of an already-parsed value. Simple primitives
 * carry a raw string (V = string); structured ones (future WHEN)
 * provide a `parse` to lift a raw line into a richer record.
 */
/** A frontmatter field. `value` is `string` for scalars, `string[]` for YAML literal-block lists. */
export interface FrontmatterField {
  key: string;
  value: string | string[];
}

export interface PrimitiveStrategy<V = string> {
  keyword: string;
  /** Lift a raw post-keyword line into a parsed value. Returns null on malformed input. */
  parse?(raw: string): V | null;
  /**
   * Body injection for the neutral compile. Empty string = no injection.
   * `ctx` is optional; most primitives ignore it. RunPrimitive uses it for
   * polymorphic kind-aware rendering.
   */
  renderNeutral(values: V[], ctx?: BundleContext): string;
  /**
   * Frontmatter fields contributed for `adapterName`, or null if the primitive
   * has no native frontmatter representation on that adapter (in which case
   * the bundler falls back to `renderNeutral` body injection).
   */
  contributesFrontmatter(adapterName: string, values: V[]): FrontmatterField[] | null;
}

export const AboutPrimitive: PrimitiveStrategy = {
  keyword: 'ABOUT',
  renderNeutral: () => '',
  contributesFrontmatter: (adapter, values) => {
    if (adapter !== 'claude-code' || values.length === 0) return null;
    return [{ key: 'description', value: values[0] }];
  },
};

/**
 * `APPLIES #tag1, #tag2, … [, universal | team:<team> | agent:<agent>]` — the
 * block's tags, searchable in the catalog and selectable by a WITH
 * (`#policy:<tag>`, `#skill:<tag>`), and the perimeter on which a policy or
 * a skill holds with no WITH naming it. Read by `parseApplies`
 * (src/services/tags.ts), the line's one reader.
 *
 * Metadata — never a line of the rendered agent body: `renderNeutral`
 * returns '' and no adapter frontmatter is emitted.
 */
export const AppliesPrimitive: PrimitiveStrategy = {
  keyword: 'APPLIES',
  renderNeutral: () => '',
  contributesFrontmatter: () => null,
};

// ---------------------------------------------------------------------------
// Agent-level identity primitives: ROLE / EXPERTISE / MANDATE
// ---------------------------------------------------------------------------

/**
 * `ROLE` identity carrier — the de-slugified display name of the role the agent
 * binds via `AS <role>`. The value is injected into metadata at bind time
 * (`bindRoleIdentity`), not declared in source: in source, `ROLE <name>:` is the
 * role block opener. Not rendered autonomously; combined into the `# Identity`
 * block by `renderIdentityBlock`.
 */
export const RolePrimitive: PrimitiveStrategy = {
  keyword: 'ROLE',
  renderNeutral: () => '',
  contributesFrontmatter: () => null,
};

/**
 * `EXPERTISE <comma-separated identifiers>` — capability domains the agent
 * masters (e.g. "nodejs, python, go"). Optional in agent.ap (0 or 1). The
 * rest is stored as a single string; callers split it with `splitList`.
 */
export const ExpertisePrimitive: PrimitiveStrategy = {
  keyword: 'EXPERTISE',
  renderNeutral: () => '',
  contributesFrontmatter: () => null,
};

/**
 * `MANDATE <verb phrase>` — the agent's operating directive (e.g. "build
 * scalable secure systems without breaking what works"). Required in
 * agent.ap (exactly 1). Not rendered autonomously; combined into `# Identity`.
 */
export const MandatePrimitive: PrimitiveStrategy = {
  keyword: 'MANDATE',
  renderNeutral: () => '',
  contributesFrontmatter: () => null,
};

/**
 * `LENS-OUT <template>` — the agent's default response shape: binds it to an imported
 * TEMPLATE. Optional in agent.ap (0 or 1). Pure sugar over the existing
 * machinery: renders as a standalone `AS! <template>` line, which the AS
 * resolver turns into a `(id)` back-reference and the force-level pass into
 * the calibrated "Strictly shape your response as — no deviation:" intro.
 * The template must be imported; an unknown name fails the bundle loudly
 * (the AS resolver throws on an unresolved shape).
 */
export const LensOutPrimitive: PrimitiveStrategy = {
  keyword: 'LENS-OUT',
  renderNeutral: values => values.length === 0 ? '' : `${values.map(value => `AS! ${value.trim()}`).join('\n')}\n\n`,
  contributesFrontmatter: () => null,
};

/**
 * `LENS-IN <template>` — the agent's default INPUT shape: how callers talk
 * to it. Renders like the old LENS key, on the input side: the agent's bundle
 * carries the template definition (it must be declared inline or imported)
 * plus an explicit contract line after Identity. The orchestration section
 * also reads it for the team members list (`talk to it as …`); a team-level
 * `LENS-IN <agent> <template>` in the TEAM block overrides it, and a flow step's
 * own shape contract overrides both.
 */
export const LensInPrimitive: PrimitiveStrategy = {
  keyword: 'LENS-IN',
  renderNeutral: values => values.length === 0 ? '' :
    `${values.map(value => `You must read every request through the template @shape(${value.trim()}) — it is the shape your input arrives in.`).join('\n')}\n\n`,
  contributesFrontmatter: () => null,
};

/**
 * Render the unified `# Identity` block for an agent bundle.
 *
 * Fuses the bound role into the agent's identity: the role's display name, its
 * ABOUT, its EXPERTISE (optional) and the agent's MANDATE compose one opening
 * paragraph, and the role's own behaviours (ALWAYS/NEVER/WHEN…) follow as the
 * agent's first directives. Returns an empty string when both ROLE and MANDATE
 * are absent (migration edge case; lint will have already reported the missing
 * fields).
 *
 * Format contract:
 *   - ROLE rendered with `**…**`
 *   - ROLE-ABOUT folded in as ` — <about> — ` between role and expertise
 *   - EXPERTISE items bold + comma-separated (no trailing "and")
 *   - MANDATE rendered plain after "Your mandate: "
 *   - `roleBehaviours` (raw `.ap` lines) appended verbatim — the downstream
 *     force-level pass turns ALWAYS/NEVER/WHEN into prose MUSTs
 *   - Block ends with a trailing blank line
 */
export function renderIdentityBlock(
  metadata: Map<string, string[]>,
  roleBehaviours = '',
): string {
  // One line per bound role; ROLE, ROLE-ABOUT and EXPERTISE align by position.
  const roles = (metadata.get('ROLE') ?? []).map(role => role.trim());
  const abouts = metadata.get('ROLE-ABOUT') ?? [];
  const expertises = metadata.get('EXPERTISE') ?? [];
  const mandateRaw = metadata.get('MANDATE')?.[0]?.trim() ?? '';

  if (roles.length === 0 && !mandateRaw) return '';

  const agentFormulas = FORMULAS.blocks.agent;
  const lines: string[] = [agentFormulas.identity, ''];

  roles.forEach((role, index) => {
    const about = abouts[index]?.trim() ?? '';
    const expertise = splitList(expertises[index]?.trim() ?? '').map(item => fill(agentFormulas.expertise, { item })).join(', ');
    const formula = expertise ? (about ? agentFormulas.roleAboutExpertise : agentFormulas.roleExpertise) : (about ? agentFormulas.roleAbout : agentFormulas.role);
    lines.push(fill(formula, { role, about, expertise }));
  });

  if (mandateRaw) {
    lines.push('');
    lines.push(fill(FORMULAS.keywords.MANDATE.line, { mandate: mandateRaw }));
  }

  const behaviours = roleBehaviours.trim();
  if (behaviours) {
    lines.push('');
    lines.push(behaviours);
  }

  lines.push('');
  return lines.join('\n');
}

/** Globs as the md lists them — each quoted as code, comma-separated: a FOR line's, a domain's, an agent's perimeter. */
export function renderGlobs(globs: readonly string[]): string {
  return globs.map(glob => fill(FORMULAS.keywords.FOR.glob, { glob })).join(', ');
}

/** What judged formulas put in a perimeter's side: their text, and the files the agent decides (file → probability). */
export interface JudgedSide {
  formulas: string[];
  uncertain: Record<string, number>;
}

/**
 * An agent's perimeter as globs: what it writes, and what it reads — null,
 * whatever it needs. A file a formula puts within is one more glob, matching
 * that file alone; `judged`, when a formula is among its domains, names the
 * formulas and the uncertain files — globs too: the agent decides them.
 */
export interface PerimeterGlobs {
  writes: string[];
  reads: string[] | null;
  judged?: { writes: JudgedSide; reads: JudgedSide };
  /** The plain globs, as the scope warning names them beside the formulas — absent with no formula. */
  shown?: { writes: string[]; reads: string[] };
}

/** The files the agent decides, as a line lists them: `src/a.ts` (p=0.55), … */
export function renderUncertain(uncertain: Record<string, number>): string {
  return Object.entries(uncertain).map(([file, probability]) => `${fill(FORMULAS.keywords.FOR.glob, { glob: file })} (p=${probability.toFixed(2)})`).join(', ');
}

/** The scope warning at the top of an agent's definition — the WRITES and READS globs of the domains it works within. */
export function renderPerimeter(perimeter: PerimeterGlobs): string {
  const writesFormulas = FORMULAS.keywords.WRITES;
  const readsFormulas = FORMULAS.keywords.READS;
  const named = (globs: string[], side?: JudgedSide) => [
    ...(globs.length ? [renderGlobs(globs)] : []),
    ...(side?.formulas ?? []).map(formula => fill(writesFormulas.formula, { formula })),
  ].join(', ');
  const writeNames = named(perimeter.shown?.writes ?? perimeter.writes, perimeter.judged?.writes);
  const writes = writeNames ? writesFormulas.fence.map(line => fill(line, { globs: writeNames })) : [writesFormulas.fence[0], writesFormulas.none];
  const readNames = perimeter.reads ? named(perimeter.shown?.reads ?? perimeter.reads, perimeter.judged?.reads) : '';
  const reads = perimeter.reads ? fill(readsFormulas.only, { globs: readNames }) : readsFormulas.all;
  const uncertain = { ...perimeter.judged?.reads.uncertain, ...perimeter.judged?.writes.uncertain };
  const decide = Object.keys(uncertain).length ? [fill(writesFormulas.uncertain, { files: renderUncertain(uncertain) })] : [];
  return [...writes, reads, ...decide, '', ''].join('\n');
}

/**
 * Strip a leading `<KEYWORD> <name>` line (TEMPLATE / PROCEDURE) and dedent
 * the body by 2 spaces. Both kinds carry the same redundant header pattern:
 * the section heading already names the entry, so the in-body keyword adds
 * only DSL noise. Recognition uses the shared lexer.
 */
export function stripHeaderKeyword(rawBody: string, keyword: Keyword, name: string): string {
  const tokens = lex(rawBody);
  // The dedent below assumes the body is indented under a `KEYWORD name:` header
  // (the inline-block shape). A body that does NOT open with that header — e.g. a
  // role already resolved to indent 0 by the import path — must pass through
  // untouched, or the 2-space dedent would chop real content.
  const opensWithHeader = tokens.some(
    token => token.kind === 'keyword' && token.keyword === keyword && token.rest === name,
  );
  if (!opensWithHeader) return rawBody.trim();

  const out: string[] = [];
  let stripped = false;
  for (const token of tokens) {
    if (!stripped && token.kind === 'keyword' && token.keyword === keyword && token.rest === name) {
      stripped = true;
      continue;
    }
    if (token.kind === 'blank') { out.push(''); continue; }
    const raw = 'raw' in token ? token.raw : '';
    out.push(raw.startsWith('  ') ? raw.slice(2) : raw);
  }
  return out.join('\n').trim();
}

/**
 * Body substitution covering two sub-line transformations:
 *
 *   1. `{{name}}`        → `vars[name]`        (variable interpolation)
 *   2. `AS <slug>`       → `AS \`slug\` (id)`  (shape back-reference; keeps the
 *                                              AS keyword so applyForceLevels
 *                                              renders the force-level intro)
 *
 * `AS` is a force-level family (see force-levels.json): `AS`, `AS!`, `AS!!`,
 * `!AS` modulate intensity. Here we resolve ONLY the slug argument against the
 * SHAPE category (the imported templates) and emit a numbered back-reference; the
 * intro phrasing comes from the force-level config, applied downstream by
 * applyForceLevels. This keeps slug resolution as the sole bespoke step.
 *
 * The two patterns are lexically disjoint; the AS pass runs first, so a
 * constant's value is never read as an AS line.
 */
export interface SubstitutionContext {
  vars?: Record<string, string>;
  /** SHAPE targets resolvable by `AS`. */
  templates: { name: string; refId?: string }[];
}

export function applyBodySubstitutions(text: string, ctx: SubstitutionContext): string {
  const shapes = ctx.templates;
  // AS first: a constant's value never becomes an AS line.
  const shaped = text.replace(/^([ \t]*)(!?AS!*)[ \t]+(\S+)[ \t]*$/gm, (_m, asIndent: string, asKeyword: string, asSlug: string) => {
    const shape = shapes.find(candidate => candidate.name === asSlug);
    if (!shape) {
      throw new Error(`AS: unknown shape "${asSlug}" (no TEMPLATE with this name is imported)`);
    }
    return `${asIndent}${asKeyword} \`${asSlug}\`${refSuffix(shape.refId)}`;
  });
  return applyVars(shaped, ctx.vars ?? {});
}

/**
 * Factory for a multi-line keyword primitive whose neutral render is a labelled
 * bullet block. Takes:
 *   - `keyword`: the DSL keyword (e.g. `WHEN`)
 *   - `intro`: the human-readable label used in the body block (e.g. `When`)
 *   - `claimedBy`: adapters with a native frontmatter for this primitive —
 *      a non-null `renderFrontmatter` signals "do not inject in body";
 *      the actual frontmatter shape is emitted by the adapter's emitter.
 */
export interface BulletGroupPrimitive extends PrimitiveStrategy<string> {
  /** Human-readable label used for the body block (e.g. `When`, `You must`). */
  intro: string;
  /**
   * Optional inline rendering: when a consecutive group has at most
   * `maxCount` values, render via `format(values)` instead of the bullet block.
   */
  inline?: { maxCount: number; format(values: string[]): string };
}

export function createBulletGroupPrimitive(opts: {
  keyword: string;
  intro: string;
  claimedBy?: readonly string[];
  inline?: { maxCount: number; format(values: string[]): string };
  /** Map collected values to one or more frontmatter fields when claimed. */
  toFrontmatter?(values: string[]): FrontmatterField[];
}): BulletGroupPrimitive {
  const claimedBy = opts.claimedBy ?? [];
  return {
    keyword: opts.keyword,
    intro: opts.intro,
    inline: opts.inline,
    renderNeutral: (values, _ctx?) => {
      if (values.length === 0) return '';
      if (opts.inline && values.length <= opts.inline.maxCount) {
        return `${opts.inline.format(values)}\n\n`;
      }
      return `${renderKeywordBlock(opts.intro, values)}\n\n`;
    },
    contributesFrontmatter: (adapter, values) => {
      if (values.length === 0 || !claimedBy.includes(adapter)) return null;
      const fm = opts.toFrontmatter?.(values);
      return fm ?? null;
    },
  };
}

/**
 * `WHEN <trigger>` — a trigger line; several WHEN lines group into one block.
 * On claude-code a file-level WHEN goes to the frontmatter's `when-to-use:`.
 */
export const WhenPrimitive = createBulletGroupPrimitive({
  keyword: 'WHEN',
  intro: FORMULAS.keywords.WHEN.head,
  claimedBy: ['claude-code'],
  toFrontmatter: triggers => [{ key: 'when-to-use', value: triggers }],
});

/**
 * `RUN <name>` — invoke a procedure or flow by name. Rendering is polymorphic:
 * when a BundleContext is available (bundle pipeline), the target kind is
 * resolved via the STRATEGIES registry and rendered as
 * `Run the <kind> \`<name>\` (id)`. Without context (e.g. lint pass),
 * falls back to the legacy `Run \`<name>\`` form.
 */
/** `Run \`x\`` for one name, `Run \`a\`, \`b\` (in order)` for several — the context-free form. */
function bareRun(values: string[]): string {
  const runFormulas = FORMULAS.keywords.RUN;
  return values.length === 1
    ? fill(runFormulas.bare, { name: values[0] })
    : fill(runFormulas.sequence, { names: values.map(name => fill(runFormulas.name, { name })).join(', ') });
}

export const RunPrimitive: BulletGroupPrimitive = {
  keyword: 'RUN',
  intro: 'Run',
  inline: { maxCount: 3, format: bareRun },
  renderNeutral: (values, ctx?) => {
    if (values.length === 0) return '';
    // No context: fallback rendering (lint pass, pre-bundle processing).
    if (!ctx) return `${bareRun(values)}\n\n`;
    const runFormulas = FORMULAS.keywords.RUN;
    const rendered = values.map(name => {
      const target = resolveRunTarget(name, ctx);
      if (!target) return fill(runFormulas.unresolved, { target: name });
      if (target.kind === 'flow' && target.refId && ctx.flowCommand) {
        return fill(runFormulas.flow, { name, ref: refSuffix(target.refId), command: ctx.flowCommand(target.refId) });
      }
      return fill(runFormulas.line, { kind: target.kind, name, ref: refSuffix(target.refId) });
    });
    if (rendered.length === 1) return `${rendered[0]}\n\n`;
    return `${rendered.join('\n')}\n\n`;
  },
  contributesFrontmatter: () => null,
};

/**
 * `DO <action>` — an imperative action. Multiple consecutive
 * `DO` lines collapse into a `Do:` block with the actions as bullets.
 * Replaces the legacy `STEP` keyword.
 */
export const DoPrimitive = createBulletGroupPrimitive({
  keyword: 'DO',
  intro: FORMULAS.keywords.DO.intro,
});

/** `DELEGATE <task>` — work handed to someone else (src/delegation.ts); grouped like DO. */
export const DelegatePrimitive = createBulletGroupPrimitive({
  keyword: 'DELEGATE',
  intro: FORMULAS.keywords.DELEGATE.intro,
});

/** `ASK <question>` — an agent's question to a delegate (src/delegation.ts); grouped like DO. */
const AskPrimitive = createBulletGroupPrimitive({
  keyword: 'ASK',
  intro: FORMULAS.keywords.ASK.intro,
});

/** `FORK <task>` — work handed to a fork, on the conversation itself (src/delegation.ts); grouped like DO. */
export const ForkPrimitive = createBulletGroupPrimitive({
  keyword: 'FORK',
  intro: FORMULAS.keywords.FORK.intro,
});

/** `WAIT <var>, …` / `WAIT ALL` — what a `~` started, taken back (src/delegation.ts). */
export const WaitPrimitive = createBulletGroupPrimitive({
  keyword: 'WAIT',
  intro: FORMULAS.keywords.WAIT.intro,
});

/** `MARK <criterion> INTO <var> AS <spec>` — zones of the code bound to contracts that wait (src/delegation.ts). */
export const MarkPrimitive = createBulletGroupPrimitive({
  keyword: 'MARK',
  intro: FORMULAS.keywords.MARK.intro,
});

/** `COMPUTE <action>` — an action left to a program (src/executor.ts); grouped like DO. */
export const ComputePrimitive = createBulletGroupPrimitive({
  keyword: 'COMPUTE',
  intro: FORMULAS.keywords.COMPUTE.intro,
});

/**
 * `BY <executor>` — binds the enclosing STEP to the agent or team that
 * executes it, resolved by ABOUT-match at RUN-time (see flows.rule). At most
 * one per step (enforced by the STEP block contract). Rendered inline with the
 * executor name in backticks, mirroring RUN reference rendering.
 */
export const ByPrimitive = createBulletGroupPrimitive({
  keyword: 'BY',
  intro: FORMULAS.keywords.BY.intro,
  inline: {
    maxCount: 1,
    format: values => fill(FORMULAS.keywords.BY.inline, { value: values[0] }),
  },
});

/**
 * Non-force-level bullet-group primitives. They share the bullet-block rendering
 * with force-levels (consumed by applyForceLevels) but have specific behaviors:
 * - WHEN: claude-code frontmatter contribution
 * - RUN/BY: inline format with grammar variations
 * - DO: plain bullet block
 *
 * Force-level primitives (MUST family, ALWAYS family, SHOULD family, MAY) are
 * NOT here — they live in src/config/force-levels.json and are resolved by
 * applyForceLevels via getIntroByKeyword().
 */
export const FORCE_LEVEL_PRIMITIVES: BulletGroupPrimitive[] = [
  WhenPrimitive,
  RunPrimitive,
  DoPrimitive,
  AskPrimitive,
  DelegatePrimitive,
  ForkPrimitive,
  WaitPrimitive,
  MarkPrimitive,
  ComputePrimitive,
  ByPrimitive,
];

/**
 * The set of keyword primitives that are "agent metadata" — they must be
 * stripped from the rendered agent body during `partitionMetadata`.
 *
 * This is the single source of truth for `bundle.ts`'s strip list.  Adding a
 * new catalog-only keyword here is sufficient; the bundle pipeline picks it up
 * automatically.
 *
 * These are the primitives whose renderNeutral is '' at baseline (catalog-only
 * or adapter-frontmatter) and that carry no prose into the body when the
 * adapter does not claim them — i.e. they are structurally metadata, not body.
 */
export const AGENT_METADATA_KEYWORDS: Keyword[] = [
  AboutPrimitive.keyword as Keyword,      // ABOUT
  AppliesPrimitive.keyword as Keyword,    // APPLIES
  // ROLE is NOT stripped here: it is the inline `ROLE <name>:` block opener,
  // extracted by inlineBlocks. Stripping it would orphan the block body.
  ExpertisePrimitive.keyword as Keyword,  // EXPERTISE  (lint-forbidden in agent.ap — lives in the bound role)
  MandatePrimitive.keyword as Keyword,    // MANDATE    (combined into # Identity block)
  'BUDGET' as Keyword,                    // BUDGET     (the cost tier: the adapter maps it to a model)
  'AS' as Keyword,                        // AS <role> (the binding; resolves the role's display/EXPERTISE into Identity)
  LensOutPrimitive.keyword as Keyword,    // LENS-OUT   (rendered as the AS! binding after Identity)
  LensInPrimitive.keyword as Keyword,     // LENS-IN    (caller-side: consumed by the orchestration members list)
];

// ---------------------------------------------------------------------------
// Enum primitives — KEYWORD <value> → string lookup, no force-level semantics
// ---------------------------------------------------------------------------

/**
 * `KEYWORD <arg>` — enumerated primitive: each arg is a key to a callback that
 * produces the substitution text. Distinct from force-levels: no amplification,
 * no negation, value lookup → string.
 *
 * Example:
 *   `BUDGET cheap` → `values['cheap']()` → `'fast, shallow work — the cheapest model'`
 *
 * Unknown arg: lint warning, line left literal.
 */
export interface EnumPrimitive {
  keyword: string;
  values: Record<string, () => string>;
  /** Opening line of the chapter legend that explains this enum's modes. */
  legendIntro?: string;
}

export const ENUM_PRIMITIVES: EnumPrimitive[] = [
  // `BUDGET <tier>` in an AGENT: how much it may spend — the adapter maps the
  // tier to a model of its harness; the source never names a model.
  {
    keyword: 'BUDGET',
    values: {
      cheap:    () => 'fast, shallow work — the cheapest model',
      moderate: () => 'balanced work — a mid-range model',
      costly:   () => 'deep reasoning — the strongest model',
    },
  },
];

export function enumPrimitiveFor(keyword: string): EnumPrimitive | null {
  return ENUM_PRIMITIVES.find(primitive => primitive.keyword === keyword) ?? null;
}

/** Registry: every primitive whose metadata can flow into adapter frontmatter. */
export const FRONTMATTER_PRIMITIVES: PrimitiveStrategy<unknown>[] = [
  AboutPrimitive     as unknown as PrimitiveStrategy<unknown>,
  WhenPrimitive      as unknown as PrimitiveStrategy<unknown>,
  RolePrimitive      as unknown as PrimitiveStrategy<unknown>,
  ExpertisePrimitive as unknown as PrimitiveStrategy<unknown>,
  MandatePrimitive   as unknown as PrimitiveStrategy<unknown>,
];

/**
 * Walk the registered primitives and aggregate their frontmatter contributions
 * for the given adapter. The bundler exposes raw collected values via
 * `bundle.metadata`; each primitive translates its own values into adapter-
 * specific fields, or returns null to leave the body responsible.
 */
export function collectFrontmatter(
  metadata: Map<string, string[]>,
  adapterName: string,
): FrontmatterField[] {
  const out: FrontmatterField[] = [];
  for (const primitive of FRONTMATTER_PRIMITIVES) {
    const values = metadata.get(primitive.keyword);
    if (!values || values.length === 0) continue;
    const fields = primitive.contributesFrontmatter(adapterName, values as never);
    if (fields) out.push(...fields);
  }
  return out;
}

/**
 * Prepend a primitive's neutral body rendering (e.g. the WHEN
 * trigger block) when the active adapter does NOT consume the same primitive
 * via frontmatter. Otherwise pass `body` through unchanged.
 */
export function injectNeutralIfUnclaimed<V>(
  body: string,
  primitive: PrimitiveStrategy<V>,
  values: V[],
  adapterName: string,
): string {
  if (values.length === 0) return body;
  if (primitive.contributesFrontmatter(adapterName, values)) return body;
  return primitive.renderNeutral(values) + body;
}

/** Render frontmatter fields as a YAML block (with `---` delimiters). */
export function serializeFrontmatter(fields: FrontmatterField[]): string {
  const lines: string[] = ['---'];
  for (const field of fields) {
    if (Array.isArray(field.value)) {
      lines.push(`${field.key}: |`);
      for (const item of field.value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${field.key}: ${field.value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}
