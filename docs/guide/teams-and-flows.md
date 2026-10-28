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
        DELEGATE implement the change and run the tests BY senior

FLOW complex-task:
    STEP implement end-to-end:
        DELEGATE implement the change and run the tests BY senior
    STEP review:
        DELEGATE review the change for duplicated logic BY reviewer
```

- `ABOUT` is the team's purpose.
- The top-level `WHEN … RUN <flow>` lines are the **routing**: which flow a request goes to.
- A `FLOW` is an ordered list of `STEP`s — some of them, when the flow says so, under a condition or in a loop (below). A step is a label over the lines whoever runs the flow carries out: `DO` it, `DELEGATE` it to an agent or a team (`BY`), `FORK` it, `WAIT` for it.
- A `DELEGATE`'s form says how much context it hands over: `DELEGATE … BY x` all of it, `DELEGATE … BY x AS <template>` only what the template holds; `FORK …` hands over the conversation itself — a fork of whoever runs the flow, or `BY y` that agent on it.
- A step may carry rules — `MUST`, `NEVER`, `SHOULD`, … (write `NEVER skip a finding`, not `DO never skip a finding`) — and put some of its lines under `IF <condition>:` and its `ELSE`. A rule is not an action: the step still needs one. Written `DELEGATE … BY x:`, a delegation's own lines are what `x` is told.
- `DELEGATE~` and `FORK~` start the work in the background; `WAIT <name>, …` or `WAIT ALL` takes it back, every piece delivered or blocked — in the same step.
- `EACH <item> IN {{<list>}} MAX <n>:` runs the `DELEGATE` and `FORK` lines beneath it once per element of a list, all the runs at once — see [Orchestration](/guide/orchestration#each-one-delegation-per-item).
- The flow itself may put its `STEP` and `RUN` lines under `IF <condition>:` and its `ELSE`, or repeat them under `UNTIL <condition>:` — a fix round, a plan revision — nesting further `IF`/`ELSE`/`UNTIL` inside. The condition is prose, judged by whoever runs the flow; see [Language reference — FLOW](/reference/language#flow).

```
FLOW assess:
    STEP audit:
        DELEGATE~ score the documentation INTO docs BY docs-auditor
        DELEGATE~ run the install from scratch INTO install BY onboarding-auditor
        WAIT ALL
    STEP aggregate:
        DELEGATE combine {{docs}} and {{install}} into one verdict BY judge
```

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
