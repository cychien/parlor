# Agent Guide

Read this before changing anything. It holds what stays true across features: what the project is, the architecture skeleton, principles, the quality bar, repo conventions.

## What this is

An application framework. Apps built with it have two properties:

1. **Agent-operable.** Everything the UI can do, an agent can do through the same interface. This covers the app's built-in agent and external agents such as Claude Code or Codex.
2. **One source, many artifacts.** One React + TypeScript app ships as a web app, a desktop app, and a mobile app.

## Architecture

```
developer's app:  actions/  schema/  routes/  AGENTS.md
        │                              │
   built as server               built as static frontend
        ▼                              ▼
  Cloud backend (Nitro + Postgres)   Same frontend in each shell:
  action runtime, sync events,       Web / PWA, Capacitor (iOS, Android),
  HTTP, MCP                          Tauri (macOS, Windows, Linux)
        ▲
  external agents enter via MCP
```

| Layer      | Responsibility                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Action     | Typed server function. Defined once, exposed as UI hook, agent tool, HTTP endpoint, MCP tool             |
| Backend    | The only place business logic runs. Nitro, PostgreSQL, sync events                                       |
| Frontend   | One React app. Talks only through the action client, never raw fetch                                     |
| Shell      | Turns the static frontend into an installable app. No business logic                                     |
| Capability | Uniform API for what browsers cannot do: notifications, files, deep links. One interface, three adapters |

## Principles

Apply these when planning and when writing code. Stop and discuss before breaking one.

1. **Actions are the only entry point for business logic.** UI, agent, HTTP, and MCP always reflect the same action definition. A new surface feature lands on all four.
2. **Additive, never breaking.** New features add API. They never break an existing user app. Changing a public interface requires a deprecation path.
3. **Composed from replaceable parts.** Database driver, shell, capability, transport, and server host sit behind interfaces. Any one can be swapped without touching the others.
4. **Progressive enhancement.** Not every OS has every capability and not every deployment supports every feature, for example serverless has no SSE. Every feature has a baseline that works everywhere and upgrades itself where the platform allows more.
5. **No platform branching in application code.** No `if (isIOS)`, no `if (platform === "vercel")`. Platform differences stay inside adapters.

## Quality bar

Make every decision to a staff engineer's standard. Weigh quality, simplicity, robustness, and long-term maintainability over development cost.

- **Reproduce before fixing.** Start every bug fix with an end-to-end reproduction as close as possible to how a user hits it.
- **Verify from the user's side before calling it done.** Run the full flow in a real build. Passing unit tests is not done.
- **Fix lint, failing tests, and flaky tests on sight**, even when unrelated to the task.
- **Be picky about UI.** During E2E work, fix what clearly looks wrong even if it is off-task.
- **No comments by default.** Code explains itself through naming and structure.
- **Ask: would a staff engineer approve this?**

## Repo conventions

- pnpm workspace, strict TypeScript, ESM.
- oxlint and oxfmt. Vitest for unit tests, Playwright for E2E.
- Packages: `core`, `server`, `client`, `capabilities`, `shell-web`, `shell-mobile`, `shell-desktop`, `cli`.
- Framework HTTP routes are prefixed `/_parlor/`.
- A capability is always: one interface, three adapters (web, capacitor, tauri), one availability query, tests per adapter.
- The CLI only orchestrates Vite, Capacitor, Tauri, and Nitro CLIs. It compiles nothing itself.
- `.parlor/` in a user project is generated output. Never hand-edit it.

## Adding a feature

1. **Study first.** Read how related or similar logic is already implemented until you have the big picture.
2. **Plan.** Scope, files, public interface, verification, out of scope. Check against the principles. Get agreement if cross-cutting.
3. **Implement.** Match the coding patterns already in the codebase: file layout, naming, error handling, how adapters and tests are organized. The more consistent with existing code, the better. Keep all code for one feature in one folder.
4. **Verify end to end** on at least two shells.

## Pull requests and commits

- **One PR, one intent.** A PR should be readable as a single decision. Size is not the limit, mixed intents are. Split a large feature into stacked PRs, each with its own clear intent.
- **Few commits.** Do not commit after every small step. Commit when a coherent piece is done and the user has agreed it is right, or once before opening the PR.
- No `Co-Authored-By` or agent attribution in commits.
- No `[codex]`, `[claude]`, or similar labels in user-visible GitHub metadata.
- Plain dash, never an em dash.
- Keep proper nouns and technical terms in their original form.
