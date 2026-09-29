# team-example

A small team you can bundle as it is: two agents, one team with routing, one flow with two steps.

```
agents/teams/dev/
  developer.ap      # member — implements the change, answers as a change-summary (LENS-OUT)
  reviewer.ap       # member — reviews the change, never edits it
  flows.ap          # the team's purpose, its routing (WHEN … RUN) and the flow
library/templates/
  change-summary.ap # the TEMPLATE the developer answers in and the review step is handed (AS)
```

What it shows:

- a **team** as a folder under `agents/teams/`, one file per member, each with one `EXPORT AGENT` block and its `ROLE`
- **routing** — `WHEN asked to implement a change: RUN implement-and-review`
- a **flow** — `implement-and-review`: the developer implements, then the reviewer reviews
- a **context mode** — the review step runs with `CONTEXT summary`: it gets a digest of the first step, not all of it
- a **step shape** — the review step declares `AS change-summary`, so what it is handed follows that template
- a **library template** — `change-summary` lives in `library/templates/` and is imported with `IMPORT change-summary FROM @main.templates`

## Try it

From the root of your project, with agent-pack installed globally:

```bash
agent-pack init
cp -r "$(npm root -g)/agent-pack/templates/examples/team-example/agents" \
      "$(npm root -g)/agent-pack/templates/examples/team-example/library" .
agent-pack bundle all
```

`init` configures the `claude-code` adapter; set `adapters: ['claude-code-apx']` in `agent-pack.config.mjs` to get
agents that point at their `.apx`. Use one of the two — both write `.claude/agents/<agent>.md`.

`bundle all` writes `.claude/agents/developer.md` and `reviewer.md`, one `.apx` per agent under `.agent-pack/apx/`, and
the team's routing and flow into `AGENTS.md`. The routing line there gives the flow id and the command that starts it:

```bash
node .agent-pack/apx/developer.apx flow <flw-id>   # how to run the flow
node .agent-pack/apx/developer.apx get <flw-id>    # its steps, with the template the review step is handed
```

If your project already has `agents/teams/dev/` or `library/templates/change-summary.ap`, copy into a fresh directory
first.
