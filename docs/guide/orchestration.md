# Orchestration

A flow is how a team splits a piece of work among its agents: who does what, with how much context, in which order, at the same time or not, and within which files. This guide walks through it one concept at a time. For the full grammar see [Language reference — FLOW](/reference/language#flow); for the commands see [The apx](/guide/apx).

## A flow is run by whoever runs it

A flow is a list of steps. Whoever runs the flow — the lead, usually the harness's main session — carries the steps out in order. A step names no one: the lines inside it say who does the work.

```
FLOW simple-task:
    STEP implement the change:
        DELEGATE implement the change and run the tests BY senior
```

Read it as: *I run `simple-task`; in its one step, I hand the change to `senior`.*

## STEP

`STEP <title>:` is a label. It groups the lines the lead carries out, and gives the phase a name. Every line of a flow sits in a step, or under an `IF`, `ELSE` or `UNTIL` that holds steps.

```
FLOW deliver-task:
    STEP implement:
        DELEGATE implement the one task handed over, test-first INTO report BY implementer
        IF {{report}} has a status of blocked or needs-context:
            DO end the flow and send {{report}} back to the requester
    STEP judge:
        DELEGATE judge the findings INTO triage BY finding-judge
```

- `DO` — the lead does it.
- `DELEGATE` — the lead hands it to an agent.
- `FORK` — the lead hands it over on its own conversation.
- `WAIT` — the lead waits for work started in the background.
- `IF`, `ELSE` and rules (`MUST`, `NEVER`, …) — as anywhere else.

A step takes no `BY` and no `CONTEXT`. Both moved to the line that hands the work over.

## DELEGATE: how much context goes with the work

`DELEGATE <task> [INTO <name>] BY <agent> [AS <template>]` hands a task to one agent and takes its answer back. Its form says how much the agent receives.

**Without `AS` — everything.** The agent gets the task and all the context so far.

```
DELEGATE write the plan from the request and the code map INTO plan BY planner
```

**With `AS <template>` — only what the template holds.** Use it when the agent must not see the rest: a reviewer who should not read the author's reasoning.

```
DELEGATE report every gap between the task and the diff INTO gaps BY conformance-reviewer AS task-and-diff
```

`task-and-diff` holds the task, its acceptance criteria and the diff. That is all the reviewer gets. A template that holds only the task is the old `isolated`.

**`FORK` — the conversation itself.** The agent starts from the lead's conversation as it is.

```
FORK frame the study and read its sources INTO framing BY research-planner
FORK write the article with the developer BY article-writer AS! results-report
```

Without `BY`, the fork is a copy of the lead. With `BY`, that agent works on the conversation with its own definition. With `AS`, what it is handed on top of the conversation takes the template's shape. Use `FORK` for work done with the developer — approvals, drafts written together.

| Form | What the agent receives |
|---|---|
| `DELEGATE … BY x` | everything so far |
| `DELEGATE … BY x AS t` | only what `t` holds |
| `FORK … [BY x] [AS t]` | the conversation itself |

**Written as a block**, a `DELEGATE` carries the lines the agent is told:

```
DELEGATE judge the findings INTO triage BY finding-judge:
    DO verify every finding in {{gaps}} and {{paths}} against the code
    DO answer with a triage-report
    NEVER close a finding without reading its line
```

## In the background: `~` and WAIT

A `~` after `DELEGATE` or `FORK` starts the work and goes on. `WAIT` takes it back.

```
STEP review:
    DELEGATE~ report every gap between the task and the diff INTO gaps BY conformance-reviewer AS task-and-diff
    DELEGATE~ trace every path the diff touches INTO paths BY edge-case-hunter AS diff-and-claims
    WAIT gaps, paths
```

- `WAIT <name>, …` waits for the ones it names; `WAIT ALL` for everything started in its block.
- **Every `~` is waited for in its own block** — its step, its `IF` or `ELSE` branch, its `UNTIL`. Reading `{{gaps}}` before its `WAIT`, a `WAIT` on a name nothing started, or a `~` never waited for, fails the build.
- **WAIT waits for all of them.** One that fails does not stop the others: after the `WAIT`, each variable holds its result, or says it was blocked. The flow deals with the blocked ones, with an `IF`.
- **WAIT has a limit.** `wait.max` in the config (`30m` by default), or on the line: `WAIT ALL MAX 10m`. At the limit nothing is blocked by itself: the lead decides — wait again, take the piece over, reassign it, or block it.

## Within which files: domains and @WITHIN

A `DOMAIN` says which files a region of the code is made of:

```
EXPORT DOMAIN api:
    ABOUT    the HTTP layer
    WRITES   IN src/api/**, src/shared/http.ts
    READS    IN src/db/**
```

`@WITHIN <domain>, …` puts work within it. It stands above an `AGENT`, a `TEAM`, a `FLOW` or a `STEP`:

```
@WITHIN code
FLOW deliver:
    @WITHIN api
    STEP build the endpoint:
        DELEGATE build the endpoint BY backend-dev
```

- The work writes only the domain's `WRITES` files and reads only its `READS` files.
- A nested `@WITHIN` narrows, and only by naming domains the outer one names. Naming one outside fails the build — never a silent intersection.
- No `@WITHIN`, no perimeter: the agent writes where it needs.
- The perimeter is kept, not only written down: a piece of work carries its step's and its assignee's, and a harness hook stops a write outside it before it happens — see [The apx — The perimeter](/guide/apx#the-perimeter).

**A domain can be described in words.** A judge decides, at compile time, which files match:

```
EXPORT DOMAIN web:
    ABOUT    the web app
    WRITES!  the pages and components of the web app IN src/**
```

With `!`, a file the judge is unsure about is the agent's to decide; with `!!`, the judge alone decides. Without a `judge` in the config, a formula fails the build.

## Contracts: MARK, then DELEGATE

When work splits along the code itself — one piece per screen, per endpoint, per module — whoever runs the flow marks the pieces first, and hands them over after. Marking and starting are two separate lines.

A **contract** is a piece of work with an id that the apx knows: what to do (its spec), where (its zone), who does it, and its state. `DELEGATE <task>` creates one and starts it at once. `MARK` creates them and leaves them waiting.

```
@WITHIN engine
FLOW build-engine:
    STEP fix the skeleton and mark the zones:
        DELEGATE fix the skeleton of the engine, one module per zone BY engine-lead
        MARK one zone per part of the engine: renderer, world, actors INTO parts AS zone-spec
    STEP build the zones:
        DELEGATE~ parts BY engine-dev
        WAIT ALL
```

- **`MARK <criterion> INTO <name> AS <spec>`** — the lead reads the code, picks the zones, and for each one writes a mark in a comment and creates a contract with the spec filled in. `AS` is required.

  ```ts
  // agent-pack ctr-4a1f0c92
  export function renderSector(sector: Sector) {
    // to build: walls, floors and ceilings, light per sector
  }
  // agent-pack end ctr-4a1f0c92
  ```

- **`DELEGATE[~] <name> BY <agent>`** — no braces: the name is a list of contracts. One delegation per contract, all at the same time, all to the one agent `BY` names — other agents, other `MARK`s. Each works in its own isolated copy. Without `~` the flow waits for them where it stands; with `~`, at its `WAIT`. Waiting merges what was delivered and lands it in the working folder.
- **The perimeter of a contract** is its zone, plus the files it creates. `MARK … WITHIN <domain>` widens it to a domain.
- **`MAX <n>`** caps the number of zones, with a project default. No zone found is not an error: the `DELEGATE` does nothing, with a warning.
- Marks stay in the code. A file that cannot hold a comment cannot be marked.

- The list is a variable like any other — `SESSION VAR parts` in a module, imported by the team file. Before its `WAIT` it holds the ids of its contracts; after it, each one's state — `merged`, `blocked` with why, `ended without delivery` — so a later step can say `IF {{parts}} has a blocked part:`. A `DELEGATE` of a variable no `MARK` above it filled fails the build.

## EACH: one delegation per item

`EACH` hands one item of a data list to each delegation:

```
STEP work on the subtasks:
    DELEGATE split the task into independent subtasks INTO subtasks BY planner
    EACH subtask IN {{subtasks}} MAX 5:
        DELEGATE~ work only on {{subtask}} INTO results BY implementer
    WAIT results
```

- `EACH` holds only `DELEGATE` and `FORK` lines.
- All delegations start together. Without `~` the flow waits for all of them; with `~` it goes on until the `WAIT`.
- `INTO` collects one result per item, as a list in item order. A run that fails does not stop the others: its state goes in the list.
- `MAX` is required: a longer list stops the flow with an error.
- The list is a variable typed with a template of one `LIST` slot.
- Lists of contracts need no `EACH`: delegate them directly. An `EACH` over one fails the build.
- With `~`, each run is a piece of its own in the apx: `dlg-28f9d7d3-1`, `dlg-28f9d7d3-2`, … The `WAIT` takes them all back.

## A complete flow

The delivery team builds a task, reviews it twice in parallel, judges the findings and fixes them in rounds:

```
FLOW deliver-task:
    STEP implement:
        DELEGATE implement the one task handed over, test-first INTO report BY implementer
        IF {{report}} has a status of blocked or needs-context:
            DO end the flow and send {{report}} back to the requester
    STEP review the change:
        DELEGATE~ report every gap between the task and the diff INTO gaps BY conformance-reviewer AS task-and-diff
        DELEGATE~ trace every path the diff touches INTO paths BY edge-case-hunter AS diff-and-claims
        WAIT gaps, paths
    STEP judge:
        DELEGATE judge the findings INTO triage BY finding-judge:
            DO verify every finding in {{gaps}} and {{paths}} against the code
            DO answer with a triage-report
    UNTIL {{triage}} says clean, replan or escalate MAX 5:
        STEP fix:
            DELEGATE fix each row routed to patch with the smallest change INTO report BY implementer
        STEP judge the fix:
            DELEGATE judge the fix INTO triage BY finding-judge
    IF {{triage}} says clean:
        STEP audit:
            DELEGATE audit the finished code against the goal INTO audit BY goal-auditor
```

What to notice:

- The reviewers get only their template: they never read the implementer's report.
- They run together, and the step ends only when both answered.
- The judge gets everything, because it must weigh both reviews.

## What the apx keeps

Everything a `~` starts has an id like `dlg-28f9d7d3` and a record on disk, in the session's registry. It outlives the conversation. The compiled flow names the commands on each line:

```bash
node .agent-pack/apx/lead.apx delegate start dlg-28f9d7d3
node .agent-pack/apx/lead.apx delegate deliver dlg-28f9d7d3 - < gaps.json
node .agent-pack/apx/lead.apx wait dlg-28f9d7d3 dlg-1d06e0a6 --max 10m
```

- `delegate start` — the lead, before handing the piece over.
- `delegate deliver` / `delegate block` — whoever carries it out. A result that breaks its variable's type is refused.
- `wait` — the lead, at the `WAIT`. It returns each piece's state.
- `delegate take`, `delegate reassign`, `delegate block` — the lead, when a piece is late or ended without delivery.
- `delegate list` — every piece of the session.

See [The apx — Background work](/guide/apx#background-work).

## Harnesses

The flow is the same everywhere. How it runs differs.

- **Claude Code.** A `~` runs as a background agent, and the session hears when it finishes — but only between turns. So a `WAIT` does not block the session: the lead does not go on until the notifications of the pieces it waits for have come, records one that ended without delivering, then checks the states with `apx wait … --now` — the limit counted from when each piece started. A `FORK` runs as a native fork; a `FORK … BY y` is one that reads `y`'s definition first (`y.apx scope`) and follows `y`'s rules from there. One hook of the project, in `.claude/settings.json`, keeps every perimeter: it runs inside subagents too, and a write outside the work in progress is denied before it happens. A fork shares the session of whoever started it, so it is held to every piece in progress that has a perimeter.
- **Codex.** The agents are custom agents (`.codex/agents/<name>.toml`), the skills `.agents/skills/<name>/SKILL.md`; Codex reads `AGENTS.md` itself. It exports no session id to its commands, so session variables and the apx's registry cannot be used with Codex as the one running the flow.
- **Other harnesses.** `apx wait` blocks until the pieces settle or the limit is reached. A `FORK … BY y` becomes a `DELEGATE … BY y` with all the context.

### Delegating to another harness

A line can hand its task to an agent of the project as another harness runs it: `BY <harness>:<agent>`.

```
STEP review:
    DELEGATE~ trace every path of {{notes}} INTO gaps BY codex:hunter AS diff-only
    WAIT gaps
STEP write:
    DELEGATE write the notes BY claude-code:writer
```

- **The harness is a dependency of the build.** It must be in `adapters:`, have a launch recipe, and its CLI must be on the PATH — `agent-pack harness list` shows what is installed, enabled and delegable.
- **It is launched from outside, never by agent-pack.** `apx delegate start <dlg-id>` opens the piece's own copy of the project, carries in the agent's definition, writes the prompt — the task and the variables it reads, or the form of its `AS` — and prints the harness's command, filled, with the rules to run it by. The lead runs it with its shell.
- **It ends in its copy.** `apx delegate deliver <dlg-id> --answer` takes the answer the command wrote and, of what changed in the copy, only what stays within the perimeter — the rest is left out and said. A `WAIT` merges it into the working folder.
- **No conversation crosses.** A `FORK` to another harness is an error.

Each adapter brings its recipe, `invoke.ap`: `claude-code` runs `claude -p --agent <agent>`, `codex` runs `codex exec` in the copy, its answer written with `-o` and bound with `--output-schema` when the line has an `AS`.

Today a flow made only of `DELEGATE` lines can also run as a Claude Code Workflow script — see [The apx — Flows](/guide/apx#flows).
