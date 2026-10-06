# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.27.1] - 2026-10-06

### Changed
- **The `agent-pack-developer` example writes the 0.27 syntax.** It now covers every form of `VAR` (constant, private, typed, the `VAR x:` block, `SESSION VAR` in a team's or the project's `vars.ap`, `GLOBAL` reserved), `DO … INTO x` (never after `RUN` — a procedure's result goes through `VAR x:`), reads of a variable whole or shaped `AS` a template, what each `vars.ap` level holds, the checked conditions `IF!`, `IF!!`, `UNTIL!`, `UNTIL!!` (where they are allowed, the `checks` prerequisite) and when a plain `IF` is the right choice.
- **The builtin scaffolds know the new forms.** `ap-statement` takes `IF!`, `IF!!`, `UNTIL!`, `UNTIL!!`, `IN` and `VAR`; `ap-action`, `ap-block-step` and `ap-block-flow` carry their placement rules (no `VAR` in a step or under an `UNTIL`, no checked condition at a flow's own level, a checked condition in a step only with an agent `BY`). New scaffold `ap-vars-line` for a `vars.ap` line. Existing scaffolds keep their names and slots.

## [0.27.0] - 2026-10-06

### Added
- **Checked conditions — `IF!`, `IF!!`, `UNTIL!`, `UNTIL!!` (I1).** The `!`s after a condition head say who decides it: `IF!` — the agent sees the condition, a judge decides it and wins; `IF!!` — a gate: the condition is sealed (in no prompt, no apx view) and the agent hears only open or closed; `UNTIL!`/`UNTIL!!` repeat until the gate opens, at most `rounds` rounds. `!IF` is an error. A checked condition reads at least one variable (`{{x}}`, or `{{x AS t}}`, whose template's fields guide the judge); its question (`In the state, <condition>?`, constants written in) is built at compile time and kept in the document's `meta.checks` under a stable id `cnd-<8hex>` (the answering agent + the condition's text). New apx verb **`check <cnd-id>`**: builds the state from the session's variables (`### <name>` + the value as stored), asks the judge one question, answers `open` (p ≥ threshold, exit 0) or `closed` (exit 1; 2 on a usage or config error) — closed when in doubt: below the threshold, an empty variable, a state too large for the judge, a judge that cannot answer, no session id. A checked `UNTIL` counts closed rounds per session, agent and condition; every check is recorded in the session (`checks.tbl`, behind the variables seam) with a fingerprint of the state, never the state. In a flow `STEP`, `IF!`/`IF!!` is checked by the step's `BY` agent through its own apx (`AGENTS.md`, `apx flow` and the Workflow script name it); `BY` a team, or a checked condition at a flow's own level, fails the compilation (the latter: not supported yet). Where no executable answers — a playbook, a team's routing — `IF!` reads as `IF` with a warning and `IF!!` fails. One rule decides all of it (`condCheckOf`, `src/check.ts`), for the document builder, the md of `AGENTS.md` and playbooks, and the source scan of flows.ap and playbooks. A step's `BY <role>` now names the member bound to that role in the member's document too, as `AGENTS.md` already did. New config key **`checks`** (`adapter`, `threshold` 0.7, `rounds` 3), apart from `judge`; without it `IF!` falls back to `IF` with a warning and `IF!!` fails. `bundle all` records the judge's name, threshold, rounds and the model the judge lock pins in every `.apx`. `JudgePlugin` gains an optional `maxStateChars` (`jev`: 96 000) and a check may carry its own `question`, asked as is. **With `checks` on, each check sends its question and the variables it reads to the judge.**
- **Variables (I7), private or shared by the session.** `VAR` names values known at compile time or produced while the agent works. `VAR x` declares a variable private to the agent (the default — no keyword), `SESSION VAR x` one every agent of the project shares for the session; `GLOBAL VAR x` is reserved (an error: not available yet). A scope word stands only right before `VAR`, never on a constant. Private variables are declared in the agent's own `vars.ap` or in the body of an agent, a role or a procedure (a procedure's belongs to the agent running it); `SESSION` ones only in a team's or the project's `vars.ap`. `VAR x AS <template>` types one; `VAR x:` with an indented block declares it and assigns it the block's final outcome (DO lines, a `RUN`, an `IF`/`ELSE`, an `UNTIL`, rule lines, `IN`) — or, when a `vars.ap` already declares `x`, only assigns it: how a procedure's result goes into a `SESSION` variable. `DO … INTO x` — a trailing, uppercase `INTO` on a `DO` line — assigns a declared one. A name is declared once per agent, in one scope: a second declaration, or a private variable named like a `SESSION` one (shadowing), is an error. A variable keeps one type: its template, or the result template (`AS`) of the procedure its block runs; a mismatch, or an `IF` and `ELSE` yielding different types, fails the compilation, and every step that fills a typed variable is told to shape its result as the template. `{{x}}` of a variable compiles into the apx command that prints its value. In the document a variable is a block of kind `var` (`var-…`, namespace `@main.vars`, `args.scope`); a `VAR x:` block is a `var` node, a `DO … INTO` directive carries `into`.
- **Shaped reads, `{{name AS template}}`.** A read of a variable can take a template's shape: the compiled line tells the agent to read the variable through its apx and keep only what fits the template, shaped as it (`VAR.readShaped` in the formulas). Nothing is stored. A variable already typed with that template reads plain. A constant, an unknown template or `AS!` fail the build; the rules of plain reads apply (not in a template's text, not from a shared library's block, not in a playbook). The read pattern of `src/vars.ts` carries it — `readsOf` gives every part of a read.
- **`apx get <name>` / `apx set <name> -|<value>`.** `get` shows a variable — its scope, type, where declared, who stores it, who reads it — then its value in this session, byte for byte; `set` stores it (stdin with `-`), refusing a constant, an undeclared name, and for a typed variable any value that is not JSON its template accepts. Both find the scope themselves: a private value is the agent's alone (kept across its invocations in the session), a `SESSION` value one for every agent of the session. `get` and `set` are the only way to a variable; where the values are kept sits behind one seam of the apx (`src/apx/sessionVars.ts`) — today tabeli tables under `.agent-pack/state/<session id>/`. The session id comes from the environment variable the adapter declares (`AdapterPlugin.sessionEnv`; `claude-code`: `CLAUDE_CODE_SESSION_ID`, recorded as `meta.sessionEnv`); without it, variables fail closed. `ls kind=var` and `scope` list the variables with their scope. A playbook takes no variable yet (it has no executable): a `VAR`, a `DO … INTO`, a read of a variable fail its compilation.
- **`vars.ap` at three levels**, project < team < agent: a deeper constant overrides the one above it.
- **The judge — a compile phase in which a model checks that `.ap` code is well written.** A rule is a `TEMPLATE` tagged `#judge`: its layout names the lines it applies to, its slot rules are the checks, `MUST` an error and `SHOULD` a warning. The three builtin `#judge` rules check every `DO` line: `judge-do-line`, it holds exactly one imperative verb; `judge-do-condition`, it carries no condition — a condition is an `IF` line with the `DO` under it; `judge-do-force`, it opens with no word of force — a force level is written with its primitive (`NEVER`, `ALWAYS`, `MUST`, …). The `jev` judge (TypeSafe AI, key from `TYPESAFE_API_KEY` or `~/.config/typesafe/key`) answers one request per distinct line; diagnostics land at `file:line:col` with the check id; the decisions live in the lock `agent-pack.judge.lock` (the judge, its model pinned on the first answer, human verdicts that win over the judge's, whatever the model — a clean `bundle all` lists in one line the decisions no line used, never deleting them) and the judge's work in one unit per `.ap` source, `.agent-pack/units/<source>.json` (like a C object file: the source's hash, the rules' hash, the model that answered, its verdicts by hash, its diagnostics; a library source outside the project goes under `_external/@alias/<path inside the library>.json`, any other under `_external/<dir hash>/<file>.json` — no machine path is written) — a source whose text and rules did not change is not judged again, an edited one asks only for its changed lines, a model changed in the lock reuses no verdict of another model, a single-agent `bundle` keeps a unit's earlier verdicts, a clean `bundle all` trims what it re-judges and deletes the units of sources no agent uses any more. New config key `judge` (`adapter`, `threshold`, `offline`, `lock`, `concurrency`) — absent, nothing changes; flags `--no-judge` and `--judge-strict`. **With `judge` on, the text of the `DO` lines is sent to TypeSafe.**
- **`IF` / `ELSE` inside a flow `STEP`.** A step may put some of its `DO`/`RUN` lines under `IF <condition>:` and its `ELSE`; `BY`, `CONTEXT` and `AS` stay unconditional. The step is valid when its only `DO` sits under the branch. The lint, the document (`lines()` with containers `[step, if]`), `AGENTS.md`, `apx flow` and the Workflow script carry the branch.
- **Rule lines in procedures and flow steps.** A `PROCEDURE` (at its top and under its `IF`/`ELSE` and `UNTIL`), a `STEP` and a step's `IF`/`ELSE` branch take the force-level families roles and playbooks take — `MUST`, `ALWAYS`, `NEVER`, `SHOULD`, `MAY`, their `!`/`!!` forms and aliases (`AS` in a branch and `DISTILL` in a step stay rejected; `MEM` is a procedure's, never a step's — see Changed) — so `DO never …` / `DO always …` become `NEVER …` / `ALWAYS …`. A rule line is not an action: a step still needs a `DO` or `RUN`. The lines become directive nodes with their force, render in source order in `AGENTS.md`, `apx get`, `apx flow` and the Workflow script, and appear in `lines()` with their positions. Existing sources compile byte-identically.
- **`IF` / `ELSE` and `UNTIL` in a `FLOW`.** A flow may put some of its `STEP`, `PARALLEL` and `RUN` lines under `IF <condition>:` and its `ELSE`, or repeat them under `UNTIL <condition>:` — a fix-round or plan-revision loop — and nest further `IF`/`ELSE`/`UNTIL` inside them. No new keyword: the condition is prose, judged by whoever runs the flow, and an `UNTIL` takes no mandatory bound. A flow still needs a `STEP`, directly or under a branch. This makes legal what the builder already compiled and `AGENTS.md` already rendered.
- `LintError` carries an optional `col`, `endCol`, `code`, `source` and `data`; diagnostics print `file:line:col` and `[code]` when known.
- **A flow runs as the harness's own script.** An adapter may declare `flowScript`: `bundle all` then compiles every flow into `.agent-pack/flows/<id>.<hash>.<ext>`. The claude-code adapters compile a Claude Code Workflow tool script — each `STEP` an agent of its `BY` type, `PARALLEL` a parallel group, upstream results passed by `CONTEXT` mode, a step's input `AS` enforced as the JSON Schema of the answer that feeds it. A flow run by a team, or holding anything but steps, keeps its prose.
- **`apx flow <flw-id>`** — how to run a flow: the adapter's instruction (`renderings.FLOW.run`) with the script's path when a script exists for this version of the flow, its steps otherwise. `AGENTS.md` routes every flow through it (`Run the flow … — start with \`node <member>.apx flow <id>\``), so the file stays harness-neutral. In the apx views a flow is reached by `flow`, not `get`.
- **The claude-code-apx agent file carries the agent's own definition.** Before pointing at the apx, `.claude/agents/<name>.md` now holds the agent's preamble — perimeter, team, identity, mandate, request and answer shapes, its own rules — in the same words as the `claude-code` file and `apx get <agent>` (`ApxEngine.definition()`), every reference as the apx command that fetches it. Policies, templates, procedures, stores and flows stay in the apx, read on demand.
- **`jsonSchemaOf`** (`src/shapeSchema.ts`) — a template's slots as JSON Schema, from the same grammar the validator checks; `ApDocument.slotsOf` / `slotResolver` give the apx and the adapters one way to read a document's templates.
- Community health for the public repository: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, issue and pull-request templates, and a CI workflow (build and test on Node 20 and 22).
- `package.json` declares `repository`, `homepage`, `bugs`, `keywords` and `engines` (`node >= 20`).
- **tabeli ships with agent-pack** (`tabeli/`, MIT — its engine, tests, docs and Claude Code skill packaging), so the two evolve together. `npm run build` compiles the engine with tabeli's own Makefile (`tabeli/tabeli`; building now needs `make` and a C compiler, and says so when none is found), and `npm test` runs tabeli's suite too — its v1-upgrade tests against the last v1 engine, vendored as `tabeli/test-fixtures/tabeli-v1.c`. The npm package carries the engine's source, Makefile and license and builds it on install.

### Changed
- A block of a shared or builtin library may not read a session variable — it takes its input through `LENS-IN`; constants are unchanged.
- **The apx runs the tabeli engine agent-pack builds**: `bundle all` records its path in every `.apx` (the build provenance), instead of looking for the tabeli skill in `~/.claude/skills`. An `.apx` written before records none — rewrite it with `agent-pack bundle all`.
- The apx creates a tabeli table — a store's too — only with a tabeli engine v2 or newer (v1 stored values lossily); a table created earlier keeps running the engine it carries. A store's `KEY` upsert reads tabeli's JSON answer instead of its text.
- A playbook's own file goes through the vocabulary check when it is compiled, like an agent's.
- `apx get <arg>`: an argument shaped like a block id is a block, as before; any other is a variable. The not-found error now reads `no block with id '<arg>' and no variable named so`.
- **A team's `flows.ap` takes the flow contracts a flow file takes.** Its `FLOW`, `STEP` and `PARALLEL` blocks are checked like those of a flow file: a step needs a `DO` or `RUN` (`BY` and a rule line alone are rejected), `AS` under a step's `IF` is rejected, and so is any line a flow, step or branch does not admit. Every team `flows.ap` in this repository lints clean.
- **An `AGENT` takes rule lines at every force level at its top**, from the same family list procedures and steps draw from: `SHOULD`, `MAY` and `MEM` (and their `!` forms) join `ALWAYS`, `NEVER` and `MUST`, instead of reaching an agent only through a `WHEN` or its role. `DISTILL` stays rejected there, with its reason — it marks a procedure, never an agent. The other agent rules are unchanged; existing sources compile byte-identically.
- **`MEM` is no line of a flow `STEP`, nor of its `IF`/`ELSE` branches**, like `DISTILL`: the agent a step's `BY` names may have no memory in its harness. The lint says so at the line; `MEM` stays legal in agents, roles, `WHEN` blocks and procedures.
- **The judge goes offline only when it cannot be reached or refuses the caller** — unreachable, timed out (30 s), no key, or key rejected (401/403). Any other failure — a 429, a 5xx, a 400, a malformed answer — leaves only that line "not judged yet", with its own reason, and the rest of the queue is still asked; `jev` retries a 429 or 5xx once. A judge object marks such a failure with an error whose `kind` is `'line'`. The summary counts distinct lines and rule × line checks apart, and how many were not judged.
- `bundle all` says when it finds no agents, instead of reporting only an empty orchestration.
- `--help` lists `--apx-compress`; the CLI reference documents `--version`.
- The README and the getting-started guide install from source until the npm package is published, and create `agents/standalone/` before copying an example; the README's first agent compiles on its own.

### Removed
- `APX_TABELI` and the lookup of the tabeli skill's `ensure-engine.sh`: the apx has one engine, the one agent-pack builds.
- The `RETURN` keyword, which nothing compiled any more: a `RETURN` line is now an unknown keyword.

### Fixed
- `{{a-b}}` — a hyphenated variable name — was never checked nor substituted; variable names take hyphens like every other name, through one shared pattern.
- `vars.ap` is linted: a malformed line, a duplicate name, a name shaped like a block id fail the build; `VAR x` without `=` was silently skipped.
- `{{…}}` in a template's `BODY` or `EXAMPLE` (literal text, never substituted) and `{{x.field}}` (not supported yet) fail the build; a comment line is no longer checked for undeclared variables.
- A `STORE` named like an apx verb (`set`, `ls`, `get`, …) fails the build: the apx read the verb and the store was unreachable.
- A `DISTILL` line directly in a `PROCEDURE` of a procedure file no longer raises a lint error.
- An `ELSE` not right after an `IF` in the same body is a lint error, instead of compiling as unconditional lines.
- A flow file whose header ends in a colon (`FLOW ship:`) no longer warns that its name does not match the filename.

### Security
- `js-yaml` raised to `^4.3.2` (quadratic-CPU advisories on merge keys and `!!omap`).

## [0.26.0] - 2026-09-13

### Added
- **One source for every md formulation** (`src/config/formulas.json`, read through `src/formulas.ts`). Every fixed phrase the md projection prints — control heads, RUN lines, the template scaffold, the store chapter, identity and lens lines, the OWNS fence, team membership, headings, dynamic-rule items, cross-reference rows, slot-type phrases — lives once, keyed by the construct that owns it, and is filled with that construct's data. Seventeen modules that typed prose by hand now read the table; two pairs of duplicate formulations inside agent-pack collapsed into one (`slotTypePhrase`/`phraseOf`, the RUN primitive's lines). The md output is unchanged byte for byte.
- **The structured document is self-sufficient.** `<agent>.ap.json` now records `meta.formulas` (the table above), `meta.md.layout` — the md outline, every heading in order, from `ApDocument.computeOutline()`, which `renderMd` itself walks — and `meta.md.stores`, what each store's backing makes of it (`StoreBlock.projection()`, the plugin asked once). A reader of the document alone can rebuild the md byte for byte, carrying no words of its own.
- **`claude-code-apx` adapter** — claude-code with one difference: an agent's `.claude/agents/<name>.md` keeps the same frontmatter but its body only points at the agent's executable (`.agent-pack/apx/<name>.apx`, option `apxDir`) and says to run it; the definition is read on demand instead of loaded whole. Everything else (skills, `CLAUDE.md`, invocation recipe, CONTEXT renderings) is claude-code's, by composition.
- **`apc`, the agent executable compiler** (`apc/`, a Go module, standard library only; not part of the npm package). `apc build <agent>.ap.json` turns a structured document into one self-contained executable — the binary copies itself and appends the document, tabeli-style. The executable answers `info`, `scope`, `outline` (the prompt, part by part), `get <block|#N>` (a block's section exactly as the md has it, with its references as commands), `ls`, `refs`, `find`, `md` (the sum of the parts), and serves the agent's STOREs through tabeli (`<exe> <store> <verb>`, KEY applied as an upsert). A golden test holds that the md rendered from the document equals agent-pack's, and that the parts add up to it.
- **`STORE` — a named working table an agent reads and writes.** A block kind declaring what a record looks like (`SLOTS`, the grammar `TEMPLATE` already uses), what identifies it (`KEY`), how long it lives (`LASTS session|project`) and what backs it (`TYPE`). An agent that imports a store gets a chapter carrying its field list *and the exact commands to use it*, written with that store's own field names and enum values — so the model never has to turn a generic example into its own case. This replaces discipline agents currently carry by hand ("treat X as working memory", "never carry records in context", "persist through the CLI only", "store one record per template"): what was a rule the model had to follow becomes what the mechanism does.
- **Store types are a plugin seam** (`src/storeTypes/`) — `TYPE` resolves through a registry; `tabeli` ships. A type renders the concrete usage, ships its own `.ap` procedure for creating storage of its kind (`createRecipe`, the twin of an adapter's `invocationRecipe`), and declares its limits: a tabeli record is flat `key=value`, so a slot holding a nested shape or a list is rejected at compile time with the reason instead of failing at the first write. The creation procedure lands in the bundle as a numbered runnable — once per type in use — and every store of that type cites it by `§N.M`.
- **`IN <store>:` inside a runnable** — a control-flow block grouping the steps that work in one store, rendered as `Working in \`<store>\` §N.M:` so the steps carry a jump to the commands instead of restating them. The store is a Ref, so a name resolving to nothing is called out rather than reading as prose.

### Fixed
- **An `EXPORT` block declared inside an agent file vanished in silence.** `readAgentFile` composed the bundle unit from three pieces — prologue, `ROLE`, `AGENT` body — and dropped every other exported block on the floor; `extractInlineDefinitions` then matched on the raw key, which is `EXPORT`, and skipped it too. An `EXPORT PROCEDURE` next to its agent existed in source, appeared in no bundle, and the only hint was an unrelated warning about an unresolved `RUN` target. Such a block is now visible in its agent's own scope (it stays non-importable — an agent file is not a library).
- **`lintGoal` hand-copied its declarative block contract.** Extracted into `checkBlockContract`, so adding a block kind stays what `blockContracts.ts` promises it is — one entry there, not a copy of three loops.

## [0.25.1] - 2026-07-18

### Fixed
- **`EXTENDS` could not resolve a parent role across roots** — parent resolution searched only the project library roots, so a role extending a parent that lives in the user home (e.g. `~/.agent-pack/roles/product-manager.ap`) or another aliased root bundled with a `<!-- MISSING EXTENDS: … -->` marker and silently dropped the parent's rules. `resolveParentPath` now searches `roles/<name>.ap` across every library root, aliased ones included (`@user`, `@builtin`), matching how every other importer resolves; precedence is unchanged (child's own directory first, project roots before aliased).

## [0.25.0] - 2026-07-18

### Added
- **Run log** — harness-independent run log for agents: entries go through the `agent-pack log` CLI gate, which validates them against the schema compiled from the log-entry TEMPLATE (fail closed, precise errors so the model can retry), stamps `ts`/`run_id` and appends JSONL to `.agent-pack/logs/run.jsonl`; routing stays external (promtail/Loki/Grafana). Opt-in via `logging: true|false` in the config: when on, every bundle receives the framework `log.ap` recipe so flows need no per-step LOG lines; the `LOG` primitive remains for extra author-chosen points, stripped at compile time below the threshold.

### Changed
- **Adapter contract v2** *(breaking for adapter authors)* — bundles now carry a string `kind` discriminator (`'agent' | 'playbook'`) stamped by the core, and adapters declare per-kind emitters (`AdapterEmitters`) instead of a single `output` emitter; `apiVersion` bumps to 2. The string discriminator replaces `instanceof`, which broke across module realms when the adapter resolved `agent-pack` from the project's `node_modules` while the CLI ran from a different install.
- **Junie HARNESS dropped from every built-in agent** — all agents compile native on the active adapter again instead of emitting a cross-harness delegation stub toward junie.

### Fixed
- **Global (user-home) agents were listed but never resolvable** — `agent-pack bundle <name>`, `bundle all` and the MCP `delegate` tool walked only the project and built-in roots, so an agent under `~/.agent-pack/agents` (the `global` domain shown by `agents list` via `@user`) failed with "Agent not found" — or silently resolved a built-in namesake. The bundle/discovery walk now includes the user home, with precedence mirroring the config cascade: project shadows global shadows built-in.

## [0.24.0] - 2026-07-16

### Fixed
- **Onboarding agents never compiled into the harness output** — `agent-pack init` now compiles every agent, including the built-in onboarding team (`project-scout`, `goal-scout`, `team-shaper`, `ap-developer`), into every registered adapter's destination (e.g. `.claude/agents/*.md`) right after scaffolding — a plain script step, no agent invocation involved. Previously the onboarding agents were only ever written as `.ap` sources / to `.agent-pack/compiled`, so a harness like Claude Code never saw them and `/onboarding` did not work until a manual `agent-pack bundle all` was run.

### Changed
- **`bundleAllOnce` is now exported** from `src/commands/bundle.ts` so callers other than the CLI (e.g. `init`) can compile every agent for every registered adapter without shelling out.
- Centralized `config.adapters.length` / `config.adapters.map(a => a.name)` checks into two new `src/config.ts` helpers, `hasAdapters(config)` and `adapterNames(config)`, used by `init/apply.ts` and `services/install.ts`.

## [0.23.0] - 2026-07-15

### Removed
- **Recall (Postgres-backed memory)** *(breaking)* — removed the entire recall feature: the `@memory` directive, the `--recall` bundle flag and the MCP `bundle` `recallTags` parameter, the `memory`/`database` config keys, the `agent-pack recall` docs, and the `pg`-backed memory store. Agent context is now composed exclusively from imports, tools and wiki. The feature was never used in production and remains recoverable from git history.

### Changed
- **Simpler `init` wizard** — the interactive `How do you want to proceed?` menu drops the "Accept all" option (`--yes`/`-y` remains the explicit shortcut). MCP-server registration and built-in agents/skills install unconditionally instead of asking. Adapter and library-root help is shown proactively (disable with `--no-hints`). The library-root prompt now defaults to the recommended root and explains what a library is.
- **Junie adapter invoke recipe** — `adapters/junie/invoke.ap` is now a `TEMPLATE` with an `output-format` slot (`text` / `json-stream`, plus guidance on ACP mode) and always passes `--skip-update-check`, replacing the old free-form `PROCEDURE` body.

## [0.22.0] - 2026-06-26

### Added
- **Cross-harness delegation** — an agent can delegate across harnesses via an adapter-shipped `invoke.ap` recipe (`adapters/<harness>/invoke.ap`), with native-body execution on the own harness and a CLI stub on foreign harnesses.
- **User-level config cascade + filesystem AgentSource** — agents/teams resolve through a user-level config cascade backed by a filesystem `AgentSource`, enabling standalone, team and `@user`/global roots.
- **Multi-export `.ap` modules** — the resolver registers every `EXPORT` block in a multi-export module, with recursive scope resolution and multi-`RUN` `WHEN` loading.
- **PM board capability** — board governance/procedures and card-format templates for product-management flows.
- **Architecture in the wiki** — the architect stores architecture artifacts (PlantUML) in the project wiki under one unified `KnowledgeSource` contract shared by library and wiki.
- **Team-scoped sharing** — the global manifesto is replaced by team-scoped sharing in the bundle.

### Changed
- **Flattened layout** — agent + library files are flattened and the kind-suffix dropped (e.g. `x.policy.ap` → `policies/x.ap`).
- **Slimmer CLI** — the CLI is reduced to `init` + `bundle`, with the compiler extracted into a reusable core.

### Removed
- **Legacy `templates/library` + built-in agents** *(breaking)* — dropped the legacy seed library (authoring policies, role/library procedures, ap-skeleton, board/recall/wiki tools), the five built-in playbook skills (agent-forge, agent-pack-author, on-user-rule, role-forge, wiki-add), and the `agent-manager`/`agent-optimizer` scaffolds. The `.ap` language is now explained from `agents/library`; the removed skills were legacy/unused and will be redone.
- **Legacy flowmind app** *(breaking)* — removed `api/` + `ui/`.
- **Legacy agent manifest** *(breaking)* — removed `manifest.yml` / `config.manifestPath` in favour of the filesystem AgentSource.

## [0.21.0] - 2026-06-13

### Added
- **Block-level EXPORT units** — the importable/embeddable unit is now the `EXPORT <KIND> <name>:` block (not the file), with block-scoped `ABOUT` / `TAGS` / `APPLIES` and private-by-default visibility. A single unified import resolver replaces the per-kind paths (legacy file-as-unit fallback fenced as `TRANSITIONAL`); the `@main` / `@common` libraries are migrated to the new form.
- **Semantic discovery via local embeddings** — discovery no longer depends on tag discipline: manifest v2 stores a per-export vector (local `all-MiniLM-L6-v2`, content-hash incremental reindex) queried in-process by the new `library_search` MCP tool, wired into the agent-forge discover-imports flow. Ships with an in-repo retrieval benchmark (`bench/`) and opt-in RRF fusion.
- **Dynamic `WHEN`+`RUN` loading** — triggered rules no longer travel in the bundle: a top-level `WHEN <cond>: RUN <name>` block (or an imported RUN-invocable unit with a module-level `WHEN`) renders as a one-line skeleton in the additive **Dynamic rules** chapter, and the compiled body is fetched on demand via the new `library_fetch` MCP tool — lazily and transitively along the `RUN` chain, symmetric to `library_search`'s forge-time discovery.
- **Lifecycle hooks** — `ON-AGENT-PROMPTED`, `ON-TASK-COMPLETED`, `ON-ERROR`, `ON-DELEGATE` (plus the migrated `ON-INVOKE`) are pure sugar, desugared to canonical `WHEN` via the extensible `src/config/lifecycles.json` table.
- **First-class `ROLE` blocks with `AS` binding** — agents become composable library units: identity (expertise, craft rules, behaviours) lives in a `ROLE` block, and an agent binds one via top-level `AS`, keeping only its project-local mandate, budget, ownership and workflow. The block name *is* the role, so the redundant `ROLE` attribute is gone; flows address steps `BY` role and the role index resolves them declaratively to the bound agent. The bound role folds into the rendered Identity section.

### Changed
- **`ON-INVOKE:` colon form** — fixed a latent bug where it leaked into bundles as dead prose.
- **Roles chapter** now lists only *additional* behavioural roles; the bound primary role renders inside the Identity section.

### Removed
- **`PERSONA`** — renamed to `ROLE` with **no backward compatibility** (breaking). The redundant `ROLE` attribute is dropped now that the block name carries the role.

## [0.20.0] - 2026-06-10

### Added
- **Typed TEMPLATE contracts** — a template body may declare `SLOTS:` / `BODY:` / `EXAMPLE:` regions: typed slots (`TEXT [MAX_WORDS n | MIN_WORDS n | REGEX /p/]`, `NUMBER min..max`, `ENUM[a b c]`, `<tpl>`, `LIST <tpl>`), a literal `BODY` layout with `{slot}` placeholders, and a few-shot `EXAMPLE` rendered inside `<example>` tags. Constraints render as guidance only (enforcement deferred to a future MCP validator for `strict` templates). Scalar shorthand: `TEMPLATE name: TYPE … "desc"`. Prose templates keep rendering verbatim.
- **Slot-scoped rules** — force-level lines under a slot attach to it lexically (order + uppercase keyword; indentation is style, not semantics). An orphan rule fails the bundle. Rendered as calibrated sub-bullets under the field legend.
- **Template composition** — a slot may reference another template (`<tpl>` / `LIST <tpl>` resolve to `§N.M` through the AS resolver), and a `.template.ap` file may `IMPORT` the templates it composes (transitive imports, e.g. `idea-verdict` → `score-row`).
- **`LENS <template>` agent key** — binds the agent's response shape to an imported template; sugar over a standalone `AS!` line, rendered right after the Identity block. At most one per agent.
- **Step output contracts in flows** — a flow `STEP` may declare `AS <template>` (any force-level declension: `AS` / `AS!` / `AS!!` / `!AS`) as the step's output contract — i.e. the next step's input format. The orchestration context now resolves project libraries, so a team `flows.ap` can import the templates its steps bind.
- **Centralized verbatim guard** — `markVerbatim` / `protectVerbatim` (services/text) shield `BODY` and `EXAMPLE` content from every post-emit rewrite pass.
- **product team** — `concept-shaper` (severe idea evaluation through the `idea-verdict` scorecard, composed of `score-row`) and `pm` (`pm-plan` Gantt), wired via the `shape-idea` flow with per-step shape contracts.

### Removed
- **LENS kind** — retired: a response shape *is* a TEMPLATE. The two prose lens files migrated to templates; the builtin `default` lens, the Response-lenses chapter, the `.lens.ap` extension, and `ensureDefaultLens` are gone. `lens` no longer appears in registries, contexts, or resolvers.

### Changed
- **Templates chapter intro** rewritten for the typed model (fill the layout, `{slot}` placeholders, constraints as self-enforced guidance, imitate `<example>`); **Flows intro** gains the step shape-contract rule.
- **Lint** — `.template.ap` accepts `IMPORT` (composition); `agent.ap` accepts `LENS` (≤ 1); template header tolerates the `TEMPLATE name:` block-opener form.

## [0.19.0] - 2026-05-29

### Added
- **`AS <shape>` operator** — declares a procedure's output shape, replacing the `RETURN AS` form. Documented in `file-kinds.policy` (`.procedure.ap` carries an optional `AS <shape>`).
- **Per-team FLOW in orchestration routing** — a team's `team.ap` now resolves through the same bundle pipeline as every other source, so an inline `FLOW`/`PROCEDURE`/`TEMPLATE` declared under `routing:` renders identically to one declared in an agent. Each team renders its own collected sections in an isolated child context (shared vocabulary, fresh numbering, no default-lens injection).

### Changed
- **Single source-body resolution** — every bundle path (agent, playbook, standalone, orchestration) now goes through one `resolveInlineBlocks` helper (`expandImports` → `extractInlineDefinitions`), so inline blocks hoist identically regardless of which file declares them.
- **Inline-block lexer** accepts the colon-less `FLOW <name>` opener alongside the `PROCEDURE name:` / `TEMPLATE name:` forms.
- **Control-flow rendering** adds `STEP` (→ `Step`) and `PARALLEL` (→ `In parallel`) heads.

## [0.14.0] - 2026-05-06

### Added
- **Indent-aware lexer** (`src/lexer.ts`) — single source of truth for `.ap` keyword recognition. Emits one classified token per line with `line`, `col`, `indent`, `keyword`/`rest`, `raw`. Replaces the per-pass regex scanning in lint, body rendering, metadata extraction.
- **Declarative lint engine** — `runLint(spec, …)` driven by `LintSpec` per file kind (policy/playbook/procedure/persona/template/vocabulary). Six specs share one walker; reusable handler factories (`accept`, `counts`, `flags`, `triggerHandler`, `ifElseHandler`, `headerHandler`, `checkHeaderCount`).
- **Primitive-driven body rendering** — every keyword that produces structured output is now a `PrimitiveStrategy`:
  - `WhenPrimitive` — playbook trigger with adapter-claim (claude-code → `when-to-use:` frontmatter; multi-WHEN supported).
  - `RunPrimitive` (`RUN <procedure>`) — replaces legacy `@<name>`. Inline rendering for ≤ 3 procedures (`Run procedures \`a\`, \`b\`, \`c\` (in order)`), bullet list for more.
  - `DoPrimitive` (`DO <action>`) — replaces legacy `STEP`.
  - `TermPrimitive` (`TERM <name> := <gloss>`) — vocabulary entry; renders as `\`name\` : gloss`.
  - All force-level keywords (`MUST`, `MUST!`, `MUST-NOT`, `SHOULD`, `SHOULD!`, `MAY`, `ALWAYS`, `NEVER`, `NON-NEGOTIABLE`) generated via `createBulletGroupPrimitive` factory.
- **Real `contributesFrontmatter` contract** — adapters obtain frontmatter fields by walking primitives and aggregating their contributions (`collectFrontmatter` + `serializeFrontmatter`). Eliminates the prior sentinel-based "claim" signal.
- **`bundle.metadata: Map<Keyword, string[]>`** — single uniform store replacing scattered `description`, `ownsGlobs`, `whens` fields. Aggregates across multi-file agent sources via `mergeMetadata`.
- **`SectionSpec`-based emission** — `emitChapter(ctx, spec)` renders Vocabulary, Personas, Templates, Procedures, Tools, Memory uniformly via two modes (`renderFlat` / `renderEntry`). Replaces 4 ad-hoc emitters.
- **`partitionMetadata`** — single-pass extract + strip per source file (replaces chained `extractPrimitive` + `extractPrimitives` + `stripPrimitives`).
- **`applyBodySubstitutions`** — fused regex pass for `{{var}}` + `RETURN AS` + `$term` (was three sequential passes).
- **`stripHeaderKeyword`** — strips redundant `TEMPLATE <name>` / `PROCEDURE <name>` line from collected entries (the section heading already names the entry).
- **`renderControlFlow`** — `IF`/`ELSE` rendered as `If <cond>:` / `Else:` (case-fold + trailing colon, Python/YAML idiom).
- **Vocabulary refs `$term`** — `$<name>` in playbook prose expands to `` `<name>` `` when `<name>` is a registered TERM.
- **`# Steps for <playbook-name>`** header — playbook procedural body labelled distinctly from declarations chapters. Declarations (Vocabulary / Templates / Procedures) emitted **before** the Steps so every reference is defined when the LLM reads the entry point.
- **`injectNeutralIfUnclaimed`** — shared body-vs-frontmatter decision for OWNS (agent) and WHEN (playbook); the primitive `contributesFrontmatter` decides, the bundler stays generic.

### Changed
- **DSL syntax migration** (breaking for sources, adapters unchanged):
  - Vocabulary `TERM <name>: <gloss>` → `TERM <name> := <gloss>` (assignment idiom; `:` reserved for the gloss text).
  - `STEP <action>` → `DO <action>` in playbooks and procedures.
  - Procedure invocation `@<name>` → `RUN <name>`.
  - All built-in `templates/library/...` files migrated.
- **Bundle pipeline** centralises keyword recognition through the lexer (lint, metadata extraction, body rendering, primitives all share one tokenizer; previously 7+ regexes lived in different files).
- **`NON-NEGOTIABLE` intro compressed** ~50% (`[IDENTITY CONSTRAINT] Before any other action, no exceptions; output skipping this is invalid:`); precedence + output-invalid clauses preserve the gap with `MUST!`.
- **Library relocation** — built-in agent library moved from `agents/library/` to `templates/library/agents/library/` (consistent with the `templates/library/` runtime convention).
- **Lint** — relaxed the "playbook must have exactly 1 WHEN" rule; multiple triggers are now supported and emitted as a list in claude-code `when-to-use:`.

### Fixed
- Playbook H1 (`# <name>` from source) is replaced with `# Steps for <name>` so the chapter is unambiguous and distinct from declarations.
- Top-level vs indented metadata extraction — `ABOUT`, `OWNS`, `WHEN`, `TERM`, `IMPORT` now match only at indent 0 (prevents false positives on `IMPORT` lines inside markdown code fences in playbook prose).
- `processImports` byte-equivalence — state-machine token-join replicates the legacy `\s*$` greedy behaviour around IMPORT lines (consume trailing blank line). Bundles produced by 0.14.0 are byte-identical to 0.13.0 for the same source modulo the deliberate format changes above.

### Removed
- `src/returnAs.ts` — folded into `applyBodySubstitutions`.
- Legacy `STEP` keyword — removed from lint regexes (sources migrated to `DO`).
- Sentinel `renderFrontmatter` returning `{ '<KEYWORD>': '<emitted-by-adapter>' }` — replaced by typed `contributesFrontmatter`.

## [0.12.0] - 2026-04-23

### Added
- `delegate` MCP tool — spawn headless Claude subagents from registered agents; sub-tasks are dispatched with an `agentName` and a high-level problem statement, letting the target agent run its own bootstrap lifecycle.
- `persona` primitive — 4th cognitive layer of an agent definition, sits alongside IDENTITY / SOUL / WORKFLOW.
- `vars` substitution — `{{key}}` placeholders resolved at bundle time and during `@import` expansion.
- `force level` system — bundle-time expansion of calibrated obligation keywords (`MUST`, `SHOULD`, etc.) into consistent prose formulas for clearer LLM parsing.
- `wiki-notion` plugin — Notion API as a wiki backend for the `@wiki` directive.
- Rule grammar — structured lint rules in `src/lint.ts` with reference documentation at `docs/reference/rule-grammar.md`.
- Runtime auto-injection — framework rules and built-in phases included automatically in every bundle without explicit `@import`.
- Orchestration rules and agent roster injected into `CLAUDE.md` by the `team init` command; agents are read from the project manifest at inject time.
- README.md with project pitch.

### Changed
- Agent library restructured: `task-runner` added, `typescript-senior` renamed from `senior-typescript`, `product-manager` dropped from built-in agents.
- `ABOUT` section stripped uniformly via shared `text.ts` across all compilation paths (CLI bundle, MCP tool, entrypoint generation).

## [0.9.0] - 2026-04-16

### Added
- `lens` primitive: reusable response formats stored in `agents/library/lenses/<name>.lens.ap`. The bundler reads `lenses` declared per-agent in the source manifest and, when `callerAgent` is supplied, injects the intersection of caller and target lenses into the compiled prompt as a `## Response lenses` section.
- `callerAgent` parameter on the `bundle` MCP tool and matching `--caller` flag on the CLI.
- `populate-claude` command: scans `agents/definitions/` plus `PREDEFINED_AGENTS`, regenerates `.claude/agents/<name>.md` entrypoints, writes `.claude/agents/manifest.yml`, and removes orphan entries. `--override` wipes destination first.
- `sourceManifestPath` config (default `agents/manifest.yml`): decouples the agent-pack source manifest from the Claude-facing manifest so lens declarations stay out of `.claude/`.
- Built-in `product-manager` agent definition under `agents/definitions/product-manager/` and `user-stories` lens under `agents/library/lenses/`.

### Changed
- Default `agentsDir` is now `agents/definitions` (was `.claude/agents/definitions`). Agent sources live alongside `agents/library/` and `agents/manifest.yml` at the project root; `.claude/agents/` is generated output.

## [0.10.0]

### Added
- Typed plugin system. Plugins are declared in `agent-pack.config.mjs` via the new `plugins` field and validated by a registry that checks `apiVersion`, type, and uniqueness.
- `WikiPlugin` contract (`src/plugins/types.ts`) with capability negotiation: `name`, `path`, `tag`, `backlinks`, `frontmatter`, `search`. Implementations declare which lookups they support; the bundler refuses to call methods not declared.
- Built-in `wiki-fs` plugin (`src/plugins/builtin/wiki-fs.ts`) backing the filesystem with `path` and `name` capabilities. Indexes basenames with an mtime-keyed cache.
- Built-in `wiki-obsidian` plugin (`src/plugins/builtin/wiki-obsidian.ts`) backing an Obsidian vault with all six capabilities (`path`, `name`, `tag`, `backlinks`, `frontmatter`, `search`). Parses frontmatter aliases and tags, extracts inline `#tag` and `[[wikilink]]` patterns from bodies (excluding fenced code blocks), builds an inverse index for backlinks, and supports optional recursive `![[embed]]` expansion with cycle detection and depth cap.
- New `@wiki` directive recognised by the parser. Forms: `<!-- @wiki "Note Title" -->`, `<!-- @wiki path="..." -->`, `<!-- @wiki name="..." -->`, `<!-- @wiki tag="a,b" -->`, `<!-- @wiki linksTo="..." -->`, `<!-- @wiki where="key:val ..." -->`, `<!-- @wiki search="..." -->`. Optional props: `provider`, `limit`, `format`, `depth`, `tagMode`. The bundler dispatches to the active wiki plugin and emits inline error comments on capability mismatch or missing provider.
- `defaultWikiProvider` config field to disambiguate when multiple wiki plugins are registered.
- `tagMode` option on `WikiOpts` (`'and'` default, `'or'` opt-in) to control tag intersection vs union.
- Directive handler pattern: 5 dispatchers (`dispatch/file.ts`, `dispatch/directory.ts`, `dispatch/tool.ts`, `dispatch/memory.ts`, `plugins/wiki-dispatch.ts`) each implementing a uniform `DirectiveHandler` contract. `bundleAgentToString` uses a Map-based lookup instead of an if/else chain.
- `getDirectiveRegex()` exported from `src/parser.ts` — centralised regex construction from a `DIRECTIVE_NAMES` list, returns a fresh instance per call (no shared state).
- Shared `collectFiles` helper in `src/utils/fs.ts`.
- New `agents/` directory at the repo root with a dedicated `senior-typescript` agent definition (IDENTITY/SOUL/WORKFLOW) for future self-development of the core.
- Test suite for the plugin system (`test/plugins.test.mjs`): registry validation, `wiki-fs` lookups, `wiki-obsidian` lookups (all six capabilities), parser regression, bundle end-to-end with happy and error paths. Parser test group extended with `getDirectiveRegex` assertions.

### Changed
- `bundleAgentToString` now accepts an optional `registry: PluginRegistry` in `BundleOptions`. The CLI `bundle` command and the MCP `bundle` tool both construct it via `PluginRegistry.fromConfig(config)` and pass it through.
- `parser.ts` `DIRECTIVE_RE` extended to match `@wiki`. The unquoted-path alternative now uses a negative lookahead to avoid swallowing prop syntax — `@import` and `@tool` paths continue to parse identically.
- `PluginRegistry` constructor made private; callers must use `PluginRegistry.load()` or `PluginRegistry.fromConfig()` so validation is enforced.
- `src/commands/bundle.ts` reduced from ~315 lines to ~165 lines by extracting each directive branch into its own handler module.

### Notes
- No changes to `@import`, `@tool`, or `@memory` semantics.
- No auto-injection: using `@wiki` requires an explicit wiki plugin in `agent-pack.config.mjs`.
- The MCP `bundle` tool description now advertises `@wiki` alongside `@import`/`@tool`/`@memory`.

## [0.7.0] - 2026-04-08

### Added
- Built-in agents (`product-manager`, `agent-manager`, `agent-optimizer`) loaded from `templates/` and merged into the `/api/agents` listing.
- Per-agent memory configuration (`retention` + `capacity`) persisted in `manifest.yml`.
- `PATCH /api/agents/:name/memory` endpoint to create, update, or clear an agent's memory configuration.
- `AgentSettingsView.vue` — new UI view for editing agent memory and settings.
- `memory` and `builtin` fields exposed on agent list and detail payloads.

### Changed
- `AgentDetailView` and `AgentsGraphView` now surface the `memory` and `builtin` flags.
- `product-manager` `WORKFLOW.ap` updated.
- Agent definitions updated across the roster (`agent-manager`, `agent-optimizer`, `design-system`, `devops`, `functional-analyst`, `junior-frontend`, `playwright-tester`, `product-manager`).
- `docker-compose.yml` updated to align with the new API/UI layout.

### Removed
- `.claude/agents/manifest.yml` removed from tracking (now managed at runtime).

[Unreleased]: https://github.com/digitex3d/agent-pack/compare/v0.27.1...HEAD
[0.27.1]: https://github.com/digitex3d/agent-pack/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/digitex3d/agent-pack/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/digitex3d/agent-pack/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/digitex3d/agent-pack/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/digitex3d/agent-pack/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/digitex3d/agent-pack/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/digitex3d/agent-pack/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/digitex3d/agent-pack/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/digitex3d/agent-pack/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/digitex3d/agent-pack/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/digitex3d/agent-pack/compare/v0.18.0...v0.19.0
[0.14.0]: https://github.com/digitex3d/agent-pack/compare/v0.13.0...v0.14.0
[0.12.0]: https://github.com/digitex3d/agent-pack/compare/v0.11.0...v0.12.0
[0.10.0]: https://github.com/digitex3d/agent-pack/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/digitex3d/agent-pack/compare/v0.8.3...v0.9.0
[0.7.0]: https://github.com/digitex3d/agent-pack/compare/v0.5.2...v0.7.0
