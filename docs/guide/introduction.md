# What is agent-pack

agent-pack is a **programming language to orchestrate agents across every harness**.

You write what your agents are and how they work together — their identity, their rules, the shape of their answers, the procedures they follow, the teams they belong to and the flows that move work between them — in `.ap` files. The compiler resolves every reference, fails when something does not exist, and writes what each harness reads.

## Why a language

A prompt written by hand drifts: rules get copied between agents and diverge, answer formats live only in someone's head, and nothing tells you when an agent refers to a procedure that no longer exists. agent-pack treats agent definitions as source code:

- **Blocks you can reuse.** A policy, a template or a procedure is written once, in the project library, and imported by every agent that needs it.
- **References that resolve.** `RUN verify-claim`, `AS finding`, `BY reviewer` point at real blocks; the compiler checks them and gives every block a stable id.
- **Typed answers.** A `TEMPLATE` declares the slots of an answer — text with a word limit, a number in a range, one value of an enum, a list of another template — with its layout and an example.
- **Calibrated rules.** `MUST`, `SHOULD`, `MAY`, `NEVER` and their stronger forms say how binding each rule is.

## What it produces

For every agent, `agent-pack bundle all` writes:

- **an `.apx`** — the agent's definition and the engine that serves it, in one file run by Node (`node .agent-pack/apx/<agent>.apx start`). The agent reads what the task needs, block by block, instead of carrying the whole definition in its context. See [The apx](./apx.md).
- **the harness file** — for Claude Code, Cursor or Junie, either the whole definition or a pointer to the apx. See [Adapters](./adapters.md).

For the project, it writes **`AGENTS.md`**: the project-wide context compiled from `PROJECT.ap`, and the orchestration — every standalone agent, every team, its members and how requests are routed to its flows. Harnesses that read their own file get a one-line pointer to it (`CLAUDE.md` contains `@AGENTS.md`).

## No runtime

agent-pack compiles; it does not run anything. The agents run inside your harness and orchestrate themselves: the main agent reads the routing in `AGENTS.md` and delegates, each member follows the steps of its flow. There is no server to start and no process to keep alive.

## What agent-pack is not

- **Not a prompt template engine.** Templates stitch text; agent-pack resolves blocks, checks references and projects one structured document into every output.
- **Not a package registry.** Shared libraries are local folders reached by an alias; git is the versioning.
- **Not an agent framework.** It does not call models. Your harness does.

## Where to go next

- [Getting Started](./getting-started.md) — install, a first agent, a first bundle.
- [Teams and flows](./teams-and-flows.md) — orchestration.
- [Language](/reference/language) — every block and keyword.
