# Agent UI: ui_screen and ui_navigate

An external agent can see what the user has on screen and move the app to another page. `ui_screen` returns the current route, the action queries feeding it, the tasks rendered in the viewport with which one is in the middle, and the connected clients. `ui_navigate` moves a connected client to one of the app's routes, or returns a link when no app is open. The route catalog, with each route's description, is in `ui_navigate`'s tool description, so the agent knows the pages before it calls anything.

## Sub-features

- `ui-screen` reports route `/`, a `listTasks` query, and the `task` items in screen order with title and done state.
- `ui-this` lets a plain "this task" request resolve to the task centered in the viewport.
- `ui-navigate` moves the app to `/settings` or `/tasks/<id>` from a plain-language request.
- `ui-unreachable` returns `reachable: false`, reason `no_client`, and for navigation an `href` on the web port, when no app is open.
- `ui-clients` targets a given `clientId`, lists the others, drops closed or reloaded tabs within 2 s, and rejects an unknown id with `unknown_client`.
- `ui-catalog` lists the four ui_ tools next to the actions, with the three routes in the description and as the `to` enum, and the `New task` form with its fields `title`, `notes` in `ui_set`'s description (the read-only `agentPanel` view is listed in the manifest but not in `ui_set`'s writable forms); `GET /_parlor/manifest` carries the same routes under `ui`, and the MCP resource `parlor://manifest` carries the pages and views with their schemas.
- `ui-policy` hides all four tools with `agentUi: { external: false }` and keeps only `ui_screen` with `"read-only"`; a confirm action still asks the user under `false`.
- `ui-activity` shows the app's activity status (a pill at the bottom left) while an agent request runs, with a text per operation: reading the screen, opening a page, filling in a form, pointing at something, asking to confirm; it says what happened for a moment afterwards, then goes quiet.
- `ui-panel-view` lists the read-only view `agentPanel` in `ui_screen` with `{open}` for the agent panel, and refuses `ui_set` on it with `not_writable`.

## How to get to it (user POV)

- Open the app on any route, connect an agent to `http://localhost:<server>/_parlor/mcp`, and ask "what am I looking at?", "mark this task as done", "where do I change the settings? take me there", or "open the task Write report".
- With the app closed, ask the same navigation question and open the link the agent returns.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline` (or `s30` for `ui-this`), doctor clean, and a page opened with `$H browser <id> open /` so a client is connected. For mac or iOS use `--target mac` or `--target ios`; the app window is the client.
- `claude` is on PATH and logged in.

- **Catalog.** Run `$H mcp <id> resources` (one resource, `parlor://manifest`) and `$H mcp <id> resource parlor://manifest | jq -r '.contents[0].text | fromjson'` for the pages and views. Run `$H mcp <id> tools > $E/tools.json`. It lists every action plus `ui_screen`, `ui_navigate`, `ui_set` and `ui_highlight`; `ui_navigate`'s description names `/`, `/tasks/$taskId`, `/settings` with their descriptions and its `to` schema is an enum of exactly those three. `curl -s <web>/_parlor/manifest` has `ui.routes` with the same paths.
- **Screen.** Run `$H mcp <id> call ui_screen '{}'`. `route.path` is `/`, `queries` includes `listTasks`, and `views.task.items` lists `Buy milk`, `Write report`, `Call Amy` in that order; `client.platform` is `web`, `tauri`, or `capacitor` by target.
- **This task.** Load `s30`, open `/`, then `$H browser <id> eval "document.querySelectorAll('li')[14].scrollIntoView({block:'center'})"` so `Task 15` is centered. Run `$H agent <id> --out $E/agent "mark this task as done"`. Read back with `$H mcp <id> call listTasks '{}'`: only `Task 15` is done, and the page shows it checked without a reload.
- **Navigate.** Run `$H agent <id> --out $E/agent "where do I change the app settings? take me there"`. The transcript shows `mcp__hello__ui_navigate` with `to: "/settings"`; `$H browser <id> snapshot` shows heading `Settings` and the URL path `/settings`. For a param route ask "open the task Write report"; the URL path becomes `/tasks/seed-baseline-2`.
- **Unreachable.** Use an instance where no page was opened (skip `$H browser <id> open`), then `$H mcp <id> call ui_navigate '{"to":"/settings"}'`. The result has `reachable: false`, `reason: "no_client"`, and an `href` on the web port; opening that href shows Settings.
- **Clients.** Open a second tab on `/settings` through the axi pass-through, then call `ui_screen` with and without `clientId`. With an id the result's `client.id` matches it; without one `otherClients` lists the rest. To make one tab the unfocused one, select it and run `$H browser <id> focus off` (and `focus on` to undo): `ui_screen` then lists it with `focused: false` and `ui_navigate` without `clientId` picks the other instead of answering `ambiguous_client`. Run `focus off` after the tab's last `open`, `click`, or `fill`, which put it back to focused; see the browser focus entry in `SKILL.md`. Close or reload a tab and call again after 2 s: it is gone. `$H mcp <id> call ui_screen '{"clientId":"does-not-exist"}'` is an error with code `unknown_client` that lists the connected ids.
- **Related recipes.** Filling forms and pointing are in [Agent forms and pointing](./agent-forms.md); asking the user to approve an action is in [Confirmations](./confirmations.md).
- **Policy.** Find the snapshot with `$H info <id>`, edit its `examples/hello/server.ts` to pass `agentUi: { external: false }` or `agentUi: { external: "read-only" }` to `createServer`, restart with `$H stop <id> && $H start <id>`, and list tools again: `true` lists four ui_ tools, `"read-only"` lists `ui_screen` only, `false` none; the action tools are identical in all three. Never edit the checkout itself for this.
- **Reading the page.** `$H browser <id> eval "document.activeElement?.name"` is the focused field's name (`title` after `fill textbox "New task"`), and `$H browser <id> eval "document.querySelector('[data-parlor-highlight]')?.getAttribute('data-parlor-highlight') ?? null"` is the highlighted element's value or `null`; list all with `[...document.querySelectorAll('[data-parlor-highlight]')].map(e => e.dataset.parlorHighlight)`.
- **A call that waits.** For an action that blocks until the user acts in the browser, start it with `$H mcp <id> call TOOL '{...}' --out $E/call.json &`, drive the page, then read `$E/call.json` (`isError`, `startedAt`, `endedAt`, `ms`, `result`) once it exists. Calls may wait up to 180 s without progress and 300 s in total; a confirm call waits at most 59 s on the server.
- **Activity.** Throttle the page (axi network throttling, Slow 3G), call `ui_navigate` to `/tasks/seed-baseline-1`, and screenshot during the call: the status reads "Agent is opening a page", then "Agent opened this page", then disappears 2 s later. `eval "document.querySelector('.agent-status').dataset.state"` is `busy`, `done`, then `idle`; a refused call reads `refused`.
- **Panel view.** `$H mcp <id> call ui_screen '{}'` has `views.agentPanel.value` `{"open":false}`; after `$H browser <id> click button "Agent"` it is `{"open":true}`. `ui_set` `{"view":"agentPanel","value":{"open":false}}` answers `not_writable` and the panel stays open.

## Gotchas

- By default two open tabs both report focused and visible, so `ui_navigate` without `clientId` answers `ambiguous_client`. That is the designed answer to a tie; pass a `clientId`, or break the tie with `focus off` on one tab.
- `focus off` changes `hasFocus` and fires `blur`, but `visibilityState` stays `visible` and `visibilitychange` never fires, so a hidden tab cannot be reproduced; `ui_screen` `visible` is always true for a browser tab here.
- After a `click` or `fill` a tab keeps real input focus and `focus off` fails on it (exit 1); close the tab, `newpage <web url>`, then `focus off`.
- The ui_ tools show the activity status for up to 3 s; the status is `position: fixed` and does not move the page, so a `click` or `fill` is safe, but wait for `data-state` `idle` before reading its text as quiet.
- A mac window behind the terminal reports `visible: false`; the screenshot still captures it by window id.
- Navigation to `/settings` finishes within one frame, so a `busy` activity status is only observable on a slowed page.
- While the agent panel is open the page behind is inert, so `ui_navigate` still works but a `click` on the page fails until the panel is closed.
- The agent may answer in another language; assert on tool calls, results, and the stored state, not on its wording.
