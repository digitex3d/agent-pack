# Teams and flows

Agents work alone or in teams. A standalone agent lives anywhere under `agents/` (by convention `agents/standalone/`); a team is a folder under `agents/teams/`.

```
agents/teams/dev/
  senior.ap        # a member — a file with one EXPORT AGENT block
  reviewer.ap      # another member
  flows.ap         # what the team is for, its routing, its flows
  team.ap          # optional: context every member shares
```

## flows.ap

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

- `ABOUT` is the team's purpose.
- The top-level `WHEN … RUN <flow>` lines are the **routing**: which flow a request goes to.
- A `FLOW` is an ordered list of `STEP`s — some of them, when the flow says so, under a condition or in a loop (below). Each step names who carries it out (`BY`, an agent or a team), what to do (`DO`), and optionally how much upstream context to pass (`CONTEXT`) and the template to hand the step's agent (`AS`).
- A step may carry rules — `MUST`, `NEVER`, `SHOULD`, … (write `NEVER skip a finding`, not `DO never skip a finding`) — and put some of its `DO`, `RUN` and rule lines under `IF <condition>:` and its `ELSE`. A rule is not an action: the step still needs a `DO` or `RUN`.
- `PARALLEL` groups steps that run at the same time.
- The flow itself may put its `STEP`, `PARALLEL` and `RUN` lines under `IF <condition>:` and its `ELSE`, or repeat them under `UNTIL <condition>:` — a fix round, a plan revision — nesting further `IF`/`ELSE`/`UNTIL` inside. The condition is prose, judged by whoever runs the flow; see [Language reference — FLOW](/reference/language#flow).

```
FLOW assess:
    PARALLEL
        STEP audit the docs:
            BY docs-auditor
            DO score the documentation
        STEP audit the install:
            BY onboarding-auditor
            DO run the install from scratch
    STEP aggregate:
        BY judge
        CONTEXT full
        DO combine the audits into one verdict
```

### Context modes

| `CONTEXT` | What the step's agent receives |
|---|---|
| `isolated` | only the step's own intent — no upstream context |
| `summary` | a synthesized digest of the upstream context, provenance preserved |
| `full` | the full upstream context, reproduced |
| `inherited` | a fork of the caller, inheriting its whole conversation |

Adapters render each mode as the harness's own delegation call.

## Where orchestration lives

`bundle all` writes the orchestration into `AGENTS.md`: every standalone agent with its description, every team with its purpose, members and routing, and the flows. The harness's main agent reads it, picks the agent or team whose purpose matches the request, applies the team's routing, and delegates. There is no runtime: the agents orchestrate themselves.

Each member also knows its team: its compiled definition opens with the team's name and purpose, its own responsibility within it, and its fellow members.

## Input shapes

A member can declare the template it expects to be talked to in, with `LENS-IN`:

```
EXPORT AGENT senior AS senior-engineer:
    ABOUT     implements changes end to end
    LENS-IN   task-spec
```

The orchestration then lists it as ``talk to it as `task-spec` ``, and whoever delegates to it shapes the request as that template. A `STEP` that declares its own `AS <template>` overrides the member's default for that step.

## team.ap

An optional `team.ap` at the team root is injected, as written, into every member's definition — mission, house rules, what is true for the team today. A team without it injects nothing; standalone agents never receive one.
