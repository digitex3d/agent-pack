# Getting Started

## Requirements

- Node 20 or newer.
- `make` and a C compiler (gcc or clang): the build compiles tabeli, the engine behind `STORE`s and variables, which works on Linux (see [The apx](./apx.md#stores)).

## Install

agent-pack is not published on npm yet — `npm install -g agent-pack` is coming soon. Until then, build it from source:

```bash
git clone https://github.com/digitex3d/agent-pack && cd agent-pack && npm ci && npm run build && npm link
```

`npm link` puts the `agent-pack` command on your `PATH`; check it with `agent-pack --version`.

## Set up a project

Paste this into your coding agent, from the root of your project — it sets agent-pack up with you:

```text
Set up agent-pack in this project:
1. Check that Node is 20 or newer (`node -v`) and that `agent-pack --version` answers;
   if either fails, stop and tell me.
2. Run `agent-pack init` — it writes agent-pack.config.mjs and the .agent-pack/ directory.
3. Ask me which harness I use and set `adapters` in agent-pack.config.mjs to its name:
   'claude-code-apx' (Claude Code, each agent reads its definition on demand from its .apx),
   'claude-code' (Claude Code, the whole definition in the agent file), 'cursor' or 'junie'.
4. Ask me whether I want the two example agents — agent-pack-developer (writes and edits .ap
   files for me) and web-researcher. For each yes, copy it into agents/standalone/:
   mkdir -p agents/standalone
   cp "$(npm root -g)/agent-pack/templates/examples/<name>.ap" agents/standalone/
5. Make sure .agent-pack/ is listed in .gitignore — it holds build output.
6. Run `agent-pack bundle all` and show me the files it wrote.
```

Or by hand, from the root of your project:

```bash
agent-pack init
```

`init` writes `agent-pack.config.mjs` and `.agent-pack/`, and — in an interactive terminal — offers the two example agents. It never overwrites an existing file.

```javascript
// agent-pack.config.mjs
export default {
  // built-in adapters, by name: claude-code, claude-code-apx, cursor, junie
  adapters: ['claude-code'],
};
```

## A first agent

An agent is a `.ap` file under `agents/` holding one `EXPORT AGENT` block. Create `agents/standalone/reviewer.ap`:

```
EXPORT AGENT reviewer AS code-reviewer:
    ABOUT     Reviews a change for bugs and duplicated logic, never edits the code
    MANDATE   review the change the user points at and report what to fix
    LENS-OUT  review-report
    NEVER     edit the files under review

ROLE code-reviewer:
    ABOUT   a careful reviewer who reads before judging
    ALWAYS  quote the line a finding is about
    NEVER   report a style preference as a bug

TEMPLATE review-report:
    ABOUT  the reviewer's answer
    SLOTS:
        verdict:  ENUM[approve changes]   "approve, or ask for changes"
        findings: TEXT                    "one line per finding: file:line — what and why"
    BODY:
        verdict: {verdict}
        findings:
        {findings}
```

- `AS code-reviewer` binds the agent to its role: who it is.
- `LENS-OUT review-report` makes every answer take the template's shape.
- `ROLE` and `TEMPLATE` without `EXPORT` belong to this file only; with `EXPORT`, or in the project library (`library/`), other agents can `IMPORT` them.

## Bundle

```bash
agent-pack bundle all
```

For every agent, every configured adapter writes its file, and the agent's `.apx` is written to `.agent-pack/apx/`. The project gets `AGENTS.md` (orchestration and, when `PROJECT.ap` exists, the project context) and, for Claude Code, a `CLAUDE.md` pointing at it.

`agent-pack bundle all --watch` rebuilds on every change to a `.ap` file.

## Run it

Ask your harness to use the agent. With `claude-code-apx`, the agent file tells the agent to start from its apx:

```bash
node .agent-pack/apx/reviewer.apx start
```

It answers a short quiz on the kinds of blocks it holds, reads the introduction of any kind it missed, gets its scope, and from then on reads only the blocks the task needs. See [The apx](./apx.md).

## Next

- [Teams and flows](./teams-and-flows.md) — make agents work together.
- [Language](/reference/language) — every block and keyword.
- [Configuration](/reference/config) — libraries, adapters, bundle options.
