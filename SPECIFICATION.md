# Agent Pack Specification

This document is the technical companion to
[`MANIFESTO.md`](./MANIFESTO.md). It elaborates the principles, the
trade-offs, and the primitive vocabulary of the paradigm with the
detail required for implementers, contributors, and academic citation.

The manifesto declares the *why*. This specification declares the *what*.

Agent Pack is a programming language whose target is the *context
window of an LLM*. The compiler reads `.ap` source and emits the bundle
that an LLM will execute. This document defines the syntax-bearing
primitives, the import system, the obligation system, and the runtime
boundary (adapters) of that language.

Versioning: this specification is co-versioned with the manifesto. The
canonical citation form for any element of the paradigm is
`Agent Pack §<id>`, where `<id>` is one of the stable identifiers
defined below (e.g. `Agent Pack §P3`, `Agent Pack §D2`).

## 1. Principles

The six non-negotiable foundations introduced in §5 of the manifesto.

- **P1 — Code, not prompts.** Agent rules are code. They have structure
  (sections, hierarchies, nested scopes), modularity (importable,
  reusable units), invariants (constraints checked at compile-time),
  and version history (every rule lives in git). Prompts as throwaway
  strings cannot be improved over time; programs can. If a rule does
  not satisfy these properties, it is not an agent rule — it is a
  note.

- **P2 — Human-readable without tooling.** The source is human-readable
  without tooling. Any `.ap` file is intelligible when opened in a
  plain text editor, with no compiler, no GUI, no preview. If a `.ap`
  file required a renderer to be understood, the format has failed.

- **P3 — Agnostic to model, author, and runtime.** No semantics in the
  source belongs to a specific vendor, model family, or runtime.
  Adapters translate but never extend: anything they emit must be
  derivable from the source. A runtime that demands behavior absent
  from `.ap` is the runtime's problem, not the source's. A definition
  written today works on tomorrow's model and on a runtime that does
  not yet exist.

- **P4 — Composable through explicit imports.** Every dependency
  between agents, playbooks, and rules is named, declared with
  `IMPORT FROM`. There is no global namespace, no auto-loading, no
  ambient context, no implicit inheritance. If it is not imported, it
  is not in scope. The composition graph is fully traceable from the
  source alone — any `.ap` file fully discloses what it pulls in.

- **P5 — Model-antifragile.** The paradigm gains value as models
  improve. Better reasoning makes `.ap` sources more powerful, not
  obsolete: the source describes intent, the model executes it. The
  same source compiled today against a stronger model produces a
  stronger bundle, with no edits to the source. Agent Pack feeds on
  model progress; it is not threatened by it.

- **P6 — Library-driven evolution.** The rule library is shared, the
  adoption is local. A new rule entering the library does not
  propagate to existing agents by default; each agent imports what
  serves it. The library grows monotonically; agents grow selectively.
  This is the inverse of ambient inheritance: rules are pulled, never
  pushed.

## 2. Trade-offs

We value:

- **Source over runtime.** The `.ap` text is the truth. Whatever runs
  is a derived artifact, reproducible from the source.
- **Composition over global magic.** Every dependency is named and
  importable. Nothing is injected by ambient context.
- **Vocabulary over convention.** A primitive with a stable name beats
  a tribal habit. Shared meaning beats shared style guide.
- **Adapters over abstractions.** Translate to many runtimes by
  writing thin, target-specific adapters — not by forcing every
  runtime under a universal abstraction layer.
- **Citable bundles over invisible state.** A bundle that can be
  referenced by section number is auditable, comparable, and
  benchmarkable. An opaque prompt blob is none of those things.
- **Explicit adoption over ambient propagation.** A rule reaches an
  agent because the agent imports it. The library grows monotonically;
  agents grow selectively. No rule is pushed onto an agent that did
  not ask for it.

That is, while there is value in the items on the right, we value the
items on the left more.

## 3. Primitives

The shared vocabulary of the paradigm. Each primitive has a stable
identifier (`D1`–`D14`) for external citation as `Agent Pack §D<n>`.
These terms have precise meaning and are not interchangeable.

- **D1 — agent** — an executable unit defined by a mission (what it
  must accomplish), a set of constraints (what it must not violate),
  and a compiled context (the rules and playbooks it has access to). The
  smallest addressable unit of the paradigm — every other primitive
  exists to serve, compose, or constrain agents.

- **D2 — playbook** — a self-contained, reusable capability — a
  workflow, a procedure, a piece of expertise — activated when a
  declarative trigger matches the current task. Playbooks are imported
  into agents, not duplicated; the same playbook can serve dozens of
  agents.

- **D3 — directive** — the smallest unit of normative content: a
  single rule, written once, identifiable by ID, versionable in git,
  citable across agents and projects. The "sentence" of the language:
  every larger artifact (playbook, agent, manifesto) is built out of
  directives.

- **D4 — IMPORT FROM** — the explicit dependency operator. Statements
  like `IMPORT <directive> FROM <library>.<path>` declare exactly which
  rule or playbook is pulled into a definition, and from where. There is
  no ambient inheritance, no auto-discovery — every link is named and
  traceable from the source alone.

- **D5 — vocabulary** — a curated set of domain-specific terms with
  fixed meaning, importable like any other rule. Vocabularies prevent
  semantic drift across agents working on the same domain: when two
  agents both `IMPORT FROM` the `payments` vocabulary, they share an
  exact definition of *charge*, *refund*, *settlement*.

- **D6 — lens** — a compile-time filter applied to an agent's context
  to expose only what is relevant for a specific caller or purpose.
  The same agent, viewed through a *security-review* lens versus a
  *frontend* lens, receives two different bundles from one source —
  without forking the agent.

- **D7 — *deprecated*.** Previously defined the *team* primitive. The
  concept proved too vague to specify: multi-agent orchestration is
  not yet stable enough in the paradigm to deserve a primitive. The
  ID is retained per the append-only rule (§4) and not reused.

- **D8 — adapter** — a translation layer from `.ap` source to a
  specific runtime's native format (Claude Code subagents, Junie
  personas, MCP servers, plain markdown bundles). Adapters are pure
  transformations: they map, they never invent. New runtimes are
  supported by writing a new adapter, never by altering the source.

- **D9 — bundle** — the compiled artifact for a specific invocation:
  one agent, one caller, one task. Bundles are emitted with stable
  section numbers (`§N.M`) so they can be cited, compared, and
  benchmarked like scientific papers — not consumed as opaque prompt
  blobs. Two bundles produced from the same source by different models
  can be diffed line by line.

- **D10 — manifesto** — the `MANIFESTO.ap` file that declares the
  *why* of a project — its mission, its constraints, its non-goals —
  and binds every agent in that project at compile-time. The paradigm
  is *self-describing*: the manifesto governing the Agent Pack
  reference implementation is itself an `.ap` artifact, processed by
  the very system it specifies.

- **D11 — force level** — calibrated keyword (`NON-NEGOTIABLE`,
  `MUST`, `MUST-NOT`, `SHOULD`, `MAY`) attached to a directive. At
  compile-time the keyword expands into a precise obligation formula
  consumed by the agent. Obligation is a *first-class primitive of
  the language*, not a documentation convention left to the reader's
  interpretation.

- **D12 — dynamic rule** — a rule declared in `dynamic.ap` that is
  *not* inlined into the bundle. Instead, the adapter materializes a
  runtime reference, and the rule is loaded on demand via MCP when
  the agent needs it. From a single source the paradigm thus produces
  two layers: a compile-time bundle of stable rules, and a
  runtime-loadable set of contextual rules — each with its own
  lifecycle.

- **D13 — rule-fit** — the import-time diagnostic check that flags
  when an agent fails to import a rule from the library that would
  clearly serve its mission. Rule-fit does not adopt rules on the
  agent's behalf; adoption remains explicit (P4, P6). It is an advisory
  signal — a linter for the library — surfacing candidates for the
  author to import, never silent inheritance.

- **D14 — librarian** — a built-in meta-agent whose mission is to
  keep the rule library structured, organized, and free of
  duplication. The librarian renames, splits, merges, and catalogs
  directives so that the library never degrades into ad-hoc
  accumulation. A first-class agent curates the substrate that all
  other agents draw from.

## 4. Citation

External works referencing this specification should use the stable
identifiers defined above. Examples:

- `Agent Pack §P3` — the agnosticism principle
- `Agent Pack §D2` — the playbook primitive
- `Agent Pack §P6 + §D13` — library-driven evolution and its diagnostic

Identifiers are append-only: new principles or primitives may be added
in future revisions, but existing IDs must never be reassigned. A
deprecated ID is marked deprecated; it is not reused.

## 5. Authorship and License

This specification was written by **Giuseppe Federico** in May 2026.
Its text is released under the Creative Commons Attribution 4.0
International license — see [`LICENSE-docs`](./LICENSE-docs) and
[`NOTICE`](./NOTICE).

The license protects the original expression of the principles,
trade-offs, and primitive definitions as written here. It does not
claim ownership over the abstract ideas or concepts they describe;
those remain free for anyone to reach independently.

Required attribution under CC-BY-4.0 for any redistribution,
adaptation, or derivative reference of this specification:

> *"Based on the Agent Pack paradigm by Giuseppe Federico (2026)."*
