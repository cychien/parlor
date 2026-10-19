# Hello verification map

This directory is the maintained source for verifying the user-facing behavior of the Parlor hello example. Read the index before driving the app, then use the matching feature file as the recipe. `$H` is `.agents/skills/verify-hello/scripts/hello.mjs`, run from the checkout root.

## Baseline preconditions

- Start an instance with `$H up --seed baseline` (add `--target mac` or `--target ios` for a shell) and note its `id` and `urls` from the printed JSON.
- `$H doctor <id>` prints no `FAIL`.
- Sign the tab in with `$H browser <id> signin` (Alice); the page lists `Buy milk`, `Write report`, `Call Amy` in that order, all unchecked.
- Never drive an instance this run did not start, and never run chrome-devtools-axi outside `$H browser <id>`.

## Driving conventions

- Start every recipe from `baseline` unless its preconditions name another dataset. Reload it with `$H seed <id> baseline`, then `$H browser <id> signin` (the seed restarts Chrome with a fresh profile) and `$H browser <id> open /`.
- Every request needs a user. The browser is Alice after `signin`; `$H mcp` and `$H agent` act as Alice unless `--as bob`; curl carries `-H "authorization: Bearer $($H token <id>)"`.
- Find UI elements by ARIA role and accessible name through `$H browser <id> click|fill ROLE NAME`, never by ref numbers copied from an old snapshot or by position.
- Drive the surface the claim is about. A UI claim is driven in the browser or shell window, an agent claim through `$H agent`, an HTTP claim with curl.
- Read every mutation back from a second view: `$H sql`, `listTasks` over HTTP or MCP, or another surface.
- Wait for text with `$H browser <id> wait "<text>"`, never a fixed sleep.

## Proof and skip reporting

- Put artifacts under `$($H evidence)/<check-id>/`.
- UI proof is an ARIA snapshot plus a screenshot, before and after the action.
- Agent proof is `agent-summary.json` and `agent-transcript.jsonl` plus the state read back afterwards.
- HTTP proof is the request and the response body with its status code.
- Shell proof (mac, iOS) is `$H doctor` output and `$H screenshot` images, because the webviews cannot be clicked from here.
- Report an unreachable entry point with the command tried and the unmet precondition. Never report it as verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with hello.mjs`, `Gotchas`. Keep implementation details out. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Tasks list and create](./tasks.md) covers the ordered list, adding from the form, the empty-title guard, and persistence across a restart.
- [Toggle a task](./toggle.md) covers checking and unchecking a task and the stored `done` flag.
- [Live sync from an external writer](./live-sync.md) covers writes from HTTP, MCP, or another window appearing without a reload, on web, mac, and iOS.
- [MCP tools](./mcp-tools.md) covers tool discovery and calls from Claude Code headless and a raw MCP client.
- [Notifications and deep link panels](./capability-panels.md) covers the platform each panel reports, sending a notification, and receiving a deep link.
- [Agent UI](./agent-ui.md) covers `ui_screen` and `ui_navigate`: what the agent sees, resolving "this task", navigation, the no-app link, client targeting, the route catalog, the external policy, the activity status, and the `agentPanel` view.
- [Agent forms and pointing](./agent-forms.md) covers `ui_set` filling the New task form, the agent-filled marking, the refusals, and `ui_highlight`.
- [Agent panel](./agent-panel.md) covers the topbar `Agent` button and its dialog: a centered modal on desktop, a bottom sheet on a phone, the pending count, the empty state, both color schemes, and the `agentPanel` view.
- [Confirmations](./confirmations.md) covers `deleteTask` asking the user in the agent panel, approve, decline, timeout, no app, ties, reload, and the user's own Delete button.
- [Accounts](./accounts.md) covers signing in, keeping Alice and Bob apart on every surface, signing a device out from settings, and connecting, refusing and revoking an MCP agent through OAuth.
- [Recovery](./recovery.md) covers an open tab reconnecting after the app server restarts and staying reachable across a navigation to another origin and back (back-forward cache).
