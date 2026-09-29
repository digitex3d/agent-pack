# agent-pack

**A programming language to orchestrate agents across every harness.**

You write your agents, their rules, their answer formats and their teams in `.ap` files. agent-pack compiles them into what each harness reads — Claude Code, Cursor, Junie, `AGENTS.md` — and into one `.apx` per agent: a single file holding the agent's definition and the engine that serves it, read on demand instead of pasted whole into the prompt.

No runtime, no server: the agents orchestrate themselves, following the flows you wrote.

## Install

agent-pack is not on npm yet; build it from source, then set up your project with the prompt in the [getting-started guide](./docs/guide/getting-started.md#set-up-a-project):

```bash
git clone https://github.com/digitex3d/agent-pack && cd agent-pack && npm ci && npm run build && npm link
```

## A first agent

Save this as `agents/standalone/web-researcher.ap` (unless you installed the example, which is its full version) and run `agent-pack bundle all`:

```
EXPORT AGENT web-researcher AS web-researcher-role:
    ABOUT     Researches a question on the internet and answers with a cited source for every claim
    MANDATE   answer the user's question from independent web sources, citing each one
    MUST      cite a URL and a publication date for every finding
    NEVER     invent a source, a URL or a quote

ROLE web-researcher-role:
    ABOUT   a careful researcher who finds, checks and cites sources before drawing any conclusion
    ALWAYS  prefer the primary source over a report relaying it
    WHEN asked to research a question:
        DO     split the question into the claims the answer depends on
        UNTIL  every claim has been checked
          RUN  verify-claim

PROCEDURE verify-claim:
    ABOUT  back one claim with independent sources before it enters the brief
    DO     search for the claim and read the most authoritative result
    IF     the sources disagree
      DO   add the conflict, with both sources, to the open questions
    AS     finding

TEMPLATE finding:
  ABOUT  one claim of the answer, backed by its sources
  SLOTS:
    claim:    TEXT MAX_WORDS 30   "the claim, stated as fact or labelled as opinion"
    sources:  TEXT                "each source as <url> (<publication date>)"
  BODY:
    - {claim} — {sources}
  EXAMPLE:
    - Paris hosted the 2024 Olympics — https://olympics.com (2024-08-11)
```

`finding` is a `TEMPLATE` — a typed answer format with slots, a layout and an example. The full agent, which also shapes its whole answer as a `research-brief` template (`LENS-OUT`), is [`templates/examples/web-researcher.ap`](./templates/examples/web-researcher.ap).

## What `bundle all` writes

| File | What it is |
|---|---|
| `.agent-pack/apx/<agent>.apx` | The agent: its definition and the engine that serves it, one file, run by Node alone |
| `.claude/agents/<agent>.md`, `.cursor/rules/<agent>.mdc`, … | What each harness loads — the whole definition, or (`claude-code-apx`) a pointer to the `.apx` |
| `AGENTS.md` | The project context (from `PROJECT.ap`) and the orchestration: every team, its members and routing |
| `CLAUDE.md` | One line, `@AGENTS.md`, for harnesses that read their own file |
| `.agent-pack/compiled/<agent>.ap.json` | The compiled document every output is projected from |

## The apx

An agent starts once with `node .agent-pack/apx/<agent>.apx start`: a short quiz on the kinds of blocks it holds, the introduction of every kind it missed, then its scope — who it is, its team and routing, the policies it respects, what it does when, where it writes, the shape of its answer. From then on it reads only what the task needs:

| Command | |
|---|---|
| `scope` | everything needed to start |
| `ls [kind= tag= name~ about~] [count]` | every block, grouped by kind, with its id |
| `get <id> [json]` | one block — its text, what it uses, what uses it |
| `refs <id>` | only the links of a block |
| `find <text>` | the blocks containing the text, with the matching lines |
| `md` | the whole prompt at once |
| `<store> <verb> …` | read or write one of the agent's stores |

Every reference the apx prints carries the command that fetches it — `Shape your response as \`finding\` [node .agent-pack/apx/web-researcher.apx get tpl-d82fd6de]` — so the agent follows ids, never guesses.

## Teams and flows

A team is a folder: its members' `.ap` files and a `flows.ap` saying what the team is for, how requests are routed and how work moves between members.

```
agents/teams/dev/
  senior.ap
  reviewer.ap
  flows.ap
```

```
# team — dev

ABOUT  the development team — code, tests, review

WHEN the task is small:
    RUN simple-task

WHEN the task is big:
    RUN complex-task

FLOW simple-task:
    STEP implement the change:
        BY senior
        DO implement the change and run the tests

FLOW complex-task:
    STEP implement end-to-end:
        BY senior
        DO implement the change and run the tests
    STEP review:
        BY reviewer
        CONTEXT full
        DO review the change for duplicated logic
```

The routing and the flows go into `AGENTS.md`, where any harness's main agent reads them and delegates.

A complete team you can bundle as it is — two members, routing, a two-step flow with a context mode and a step shape — is in [`templates/examples/team-example/`](./templates/examples/team-example/).

## The language

| Construct | Purpose |
|---|---|
| `AGENT`, `ROLE` | who the agent is: mandate, rules, identity and expertise |
| `OWNS <globs>` | the files an agent may write; its definition opens with a perimeter warning |
| `POLICY` | rules every agent that imports them must respect |
| `TEMPLATE` | a typed answer format — `SLOTS`, `BODY` layout, `EXAMPLE` |
| `PROCEDURE` | reusable steps, invoked with `RUN` |
| `FLOW`, `STEP`, `BY`, `CONTEXT` | how a team's members hand work to each other |
| `STORE` | the data an agent keeps between sessions, declared like a schema |
| `MUST`, `SHOULD`, `NEVER`, `ALWAYS` … | how binding each rule is |
| `WHEN`, `IF` / `ELSE`, `UNTIL` | conditions and loops |
| `MEM <event>` | save an event to the agent's persistent memory, to act on it directly next time |
| `DISTILL` | inside a procedure: its reasoning is distilled into a deterministic script, run from then on |
| `AS`, `LENS-IN`, `LENS-OUT` | which template an answer — or an incoming request — is shaped as |
| `IMPORT … FROM @main.<kind>` | reuse blocks from the project library (`library/`) |
| `VAR` | values substituted at compile time, from a `vars.ap` next to the agent — never secrets |
| `PLAYBOOK` (`*.playbook.ap`) | one triggered workflow compiled into a harness skill |

The full reference is [docs/reference/language.md](./docs/reference/language.md).

## Examples

- [`templates/examples/web-researcher.ap`](./templates/examples/web-researcher.ap) — a standalone agent: templates, a procedure, a loop.
- [`templates/examples/agent-pack-developer.ap`](./templates/examples/agent-pack-developer.ap) — an agent that writes and edits `.ap` files for you.
- [`templates/examples/team-example/`](./templates/examples/team-example/) — a team: members, routing, a flow.

## Requirements

- Node 20 or newer.
- `STORE`s are backed by tabeli and work where tabeli runs (Linux); point `APX_TABELI` at the tabeli binary if it is not installed as a skill.

## Documentation

- [docs/](./docs/index.md) — the guide and the reference: [language](./docs/reference/language.md), [CLI](./docs/reference/cli.md), [configuration](./docs/reference/config.md), [the apx](./docs/guide/apx.md).
- [SPECIFICATION.md](./SPECIFICATION.md) — the Agent Pack Specification.
- [CHANGELOG.md](./CHANGELOG.md) — every release, breaking changes included.

## Stability

agent-pack is pre-1.0: the `.ap` language and the CLI may change between minor versions. [CHANGELOG.md](./CHANGELOG.md) lists every breaking change.

## Contributing

Issues and ideas are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md), the [Code of Conduct](./CODE_OF_CONDUCT.md) and, for security problems, [SECURITY.md](./SECURITY.md).

## License

agent-pack was created by **Giuseppe Federico**.

- Code: [Apache 2.0](./LICENSE) — keep the [NOTICE](./NOTICE) with any redistribution.
- Specification: [CC BY-ND 4.0](./LICENSE-spec) — one canonical version.
- Documentation: [CC BY 4.0](./LICENSE-docs).
- The name: [TRADEMARKS.md](./TRADEMARKS.md). Governance: [GOVERNANCE.md](./GOVERNANCE.md). Citing: [CITATION.cff](./CITATION.cff).

Required attribution for works based on agent-pack: *"Based on the Agent Pack paradigm by Giuseppe Federico (2026)."*
