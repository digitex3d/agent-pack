# The Agent Pack Manifesto

> *A programming language for LLM contexts.*
> *The source is the truth. Everything else is a bundle.*

## 1. Preamble

Today, agent rules live as throwaway strings. They should live as code.

Agent rules are becoming part of the software supply chain — but they
still live as disposable prompt text. They are pasted into configuration
files, copied across IDEs, lost between projects. They are not
versioned, not composable, not citable, not shared.

This document is the canonical statement of *Agent Pack*: a way to treat
agent definitions as source code.

## 2. The Thesis

> **Agent Pack is a programming language for LLM contexts.**
>
> Agents, playbooks, directives, vocabularies are not prompt fragments —
> they are constructs of a language with syntax, imports, scope, and a
> compiler. AI agents must be treated as first-class code: structured,
> versioned, composable, and runtime-agnostic.
>
> *Increasingly, we do not only program products; we also program the
> agents that build, review, refactor, and maintain them.*

## 3. The Problem

The state of practice is indefensible.

1. **Throwaway prompts.** Production-grade behavior is being shipped as
   configuration strings: not versioned, not diffable, not reviewable.
   A pull request that changes a 400-line agent prompt is approved
   blind, because the tooling to read it as code does not exist. We
   have accepted, without protest, a regression of thirty years of
   software engineering practice.
2. **Runtime lock-in.** The same agent — a code reviewer, a refactoring
   playbook, a team workflow — is rewritten by hand for Claude Code,
   Cursor, Codex, Copilot. Every copy diverges within two weeks.
   The cost is paid in silence, project by project.
3. **No shared vocabulary.** *Agent*, *playbook*, *directive*, *team*,
   *lens* mean a different thing in every repository. Knowledge does
   not transfer. Each team reinvents the primitives, badly, in
   isolation.

None of this is a technical limitation. It is a cultural one.

**Prompt engineering is not the answer.** Iterating on a long string
until it "works on the latest model" is not engineering — it is
debugging without a source. The discipline this manifesto demands is
the opposite: declare the rules, version them, compose them, and let
the model execute. The prompt is an artifact, not the source.

## 4. The Paradigm

Agent Pack is a programming language whose target is not a CPU but the
*context window of an LLM*. The compiler reads `.ap` source and emits
the bundle that an LLM will execute. Like any language, it has a syntax
(`.ap`), an import system (`IMPORT FROM`), a type system (vocabularies,
force levels), and a set of runtimes (the adapters). Unlike traditional
languages, its runtime is non-deterministic — and that is the design
constraint that shapes everything else.

Agent definitions live in plain text, organized by domain, composed
through explicit `IMPORT FROM`, versioned in git, and compiled toward
different runtimes through *adapters*. A single source can produce a
Claude Code subagent, a Cursor rule, a Codex configuration, and an
MCP-loadable bundle from the same file — none of them rewritten by hand.

**Invariant: adapters translate, never extend.** No adapter may
introduce semantics absent from the source `.ap`. If a target runtime
requires behavior not expressible in `.ap`, the language is extended —
not the adapter.

In Agent Pack, the source is the truth. Adapters, runtimes, and bundles
are downstream of it.

## 5. The Principles

Six non-negotiable foundations. Each principle has a stable identifier
(`P1`–`P6`) for citation as `Agent Pack §P<n>`. Detailed commentary
appears in [`SPECIFICATION.md`](./SPECIFICATION.md).

- **P1 — Code, not prompts.** Agent rules are code. They have structure,
  modularity, invariants, and version history — or they are not agent
  rules, they are notes.
- **P2 — Human-readable without tooling.** The source is human-readable
  without tooling. If a `.ap` file requires a renderer to be understood,
  the format has failed.
- **P3 — Agnostic to model, author, and runtime.** No semantics in the
  source belongs to a vendor. Adapters translate; they do not invent.
  A runtime that demands behavior absent from `.ap` is the runtime's
  problem, not the source's.
- **P4 — Composable through explicit imports.** Every dependency is
  named. There is no ambient context, no global magic, no implicit
  inheritance. If it is not imported, it is not in scope.
- **P5 — Model-antifragile.** The paradigm gains value as models
  improve. Better reasoning makes `.ap` sources more powerful, not
  obsolete: the source describes intent, the model executes it.
- **P6 — Library-driven evolution.** The rule library is shared, the
  adoption is local. A new rule entering the library does not
  propagate to existing agents by default; each agent imports what
  serves it. The library grows monotonically; agents grow selectively.

**Traceability.** P1–P2 → §3.1 (throwaway prompts). P3–P4 → §3.2
(runtime lock-in) and §3.3 (no shared vocabulary). P5–P6 are
forward-looking: they constrain how the paradigm behaves as models and
the library evolve.

## 6. What This Is Not

Defining by exclusion is essential. Agent Pack:

- **Is not a framework.** It does not impose a runtime, a library, or
  an API.
- **Is not yet another CLI.** The CLI is a reference implementation;
  the paradigm survives any specific implementation.
- **Is not proprietary.** No feature of the paradigm requires a closed
  service, an account, or a vendor.
- **Does not compete with Anthropic, OpenAI, or any other model and
  runtime vendor.** Agent Pack lives one layer above: it feeds on their
  improvements, it does not replace them.
- **Is not a GUI, nor a marketplace.** The source is text, versioned,
  diffable, citable. It stays that way.
- **Is not a prompt wrapper.** A prompt is a string. An agent pack is
  a program.

## 7. Authorship

Authored by **Giuseppe Federico**, May 2026.

- Text (this manifesto, [`SPECIFICATION.md`](./SPECIFICATION.md)):
  **CC-BY-4.0** — see [`LICENSE-docs`](./LICENSE-docs).
- Reference implementation: **Apache-2.0** — see [`LICENSE`](./LICENSE).
- Anteriority and proofs of existence: see [`NOTICE`](./NOTICE).

Required attribution under CC-BY-4.0:

> *"Based on the Agent Pack paradigm by Giuseppe Federico (2026)."*

---

*The source is the truth. Everything else is a bundle.*
