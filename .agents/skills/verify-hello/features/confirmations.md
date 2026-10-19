# Confirmations: deleteTask asks the user

`deleteTask` is marked `confirm: true`. When an agent calls it over MCP, the app adds a card to the agent panel of the client the user is looking at and shows the pending count on the topbar `Agent` button; the user opens the panel (a native dialog, see [Agent panel](./agent-panel.md)) and answers with `Approve` or `Decline`. The card reads `<agent> wants to delete a task`, the question `Delete the task "<title>"?`, and a muted line `deleteTask · <task id>`. For an id that no longer exists the question reads `This task no longer exists`. The call waits for the answer for at most 59 s. A call from the app's own `Delete task` button, or from plain HTTP without an agent source, never asks.

## Sub-features

- `confirm-approve` runs the delete after `Approve` and the card disappears.
- `confirm-decline` answers the agent `declined`, deletes nothing, and the card disappears.
- `confirm-escape` declines the card when `Escape` is pressed with focus inside it and keeps the panel open; with focus elsewhere in the panel `Escape` closes the panel and declines nothing.
- `confirm-focus` leaves focus where it was: a card that appears while the user types in `New task`, or while the panel is open, does not take it, and the panel never opens by itself.
- `confirm-focus-kept` keeps focus inside the open panel when the user answers the card that holds it: focus moves to the next card (never to an `Approve` button), or to the card list when none is left, and never falls to the page body. Answering a card focus is not in leaves focus untouched.
- `confirm-pending` shows the pending count on the `Agent` button while the panel is closed (accessible name `Agent, <n> pending`) and removes it when the last card is answered.
- `confirm-announced` puts each card in a polite live region inside the panel as a group named `<agent> wants to delete a task`, so a screen reader announces it.
- `confirm-timeout` answers `confirmation_timeout` between 59 and 63 s, deletes nothing, and the card is gone.
- `confirm-no-app` answers `confirmation_unavailable` within 1 s with no app open, and says to ask the user to do it in the app.
- `confirm-own-click` deletes without a card from the `Delete task` button on `/tasks/<id>` and returns to `/` within 1 s; a plain HTTP call without `x-parlor-source` deletes too.
- `confirm-target` shows the card on the focused tab only; on a tie it shows on every tied tab and the first answer wins.
- `confirm-reload` shows the pending count again within 3 s after a reload (the panel itself starts closed) and runs the delete once.
- `confirm-not-blocking` leaves `ui_screen` and `ui_set` answering while a card waits.
- `confirm-policy` still asks when the ui_ tools are hidden with `agentUi: { external: false }`.
- `confirm-shutdown` answers `confirmation_unavailable` with a message saying the action did not run when the server stops while the card waits, deletes nothing, and shows no card after the restart.
- `confirm-indicator` shows "Agent is asking you to confirm" in the activity status while a card is pending.

## How to get to it (user POV)

- Ask an agent to "delete the task Write report", press the `Agent` button in the topbar and answer the card in the panel.
- Open a task and press `Delete task`.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, a page opened with `$H browser <id> open /`.
- The cards live in the agent panel, so open it before reading them: with a card pending, `$H browser <id> click button "Agent, 1 pending"` (the name carries the count, `Agent, 2 pending` with two). While the panel is open the page behind is inert, so a snapshot shows only the dialog.

- **Approve.** Run `$H mcp <id> call deleteTask '{"id":"seed-baseline-2"}' --out $E/delete.json &`. While it waits, the `Agent` button reads `Agent, 1 pending`; after opening the panel `$H browser <id> snapshot` shows `button "Approve"` and `button "Decline"` in a `live="polite"` container with the text `Delete the task "Write report"?` and `deleteTask · seed-baseline-2`, and `listTasks` still has three tasks. Run `$H browser <id> click button Approve`. Close the panel with `press Escape`; the list loses `Write report` without a reload, the button reads `Agent` again, and `$E/delete.json` has `isError` false.
- **Decline.** Same call, then `click button Decline`. `$E/delete.json` has `isError` true and the text parses to `{"error":{"code":"declined",...}}`; `listTasks` is unchanged.
- **Escape.** Same call with the panel open, then press `Tab` once (focus moves from `Close` to the card's `Approve`) and `$H browser <id> press Escape`. The card is gone, `eval "document.querySelector('dialog.agent-panel').open"` is still `true`, and `$E/delete.json` has the code `declined`. With focus on `Close` or on the dialog itself, `press Escape` closes the panel and the card stays pending.
- **Focus.** `fill textbox "New task" "Groc"`, start the call, `wait "Agent, 1 pending"`, then `eval "document.activeElement?.name"` is still `title`, the field still reads `Groc`, and `eval "document.querySelector('dialog.agent-panel').open"` is `false`. With the panel open, a call that arrives leaves `document.activeElement` on the same element.
- **Focus kept.** With the panel open, start two calls (`seed-baseline-2` and `seed-baseline-3`) and click `Decline` on the first card: `eval "document.activeElement.getAttribute('role')"` is `group` (the second card, inside the dialog), never `BODY` or a button. Answer that one too: `eval "document.activeElement.className"` is `confirmations`.
- **Announced.** With the card up and the panel open, `$H browser <id> snapshot` shows a `dialog "Agent" modal` holding a `generic live="polite"` node with the card text and both buttons. The group's accessible name is not in the axi snapshot; read it from the full accessibility tree over CDP (`browserCdpPort` from `$H info <id>`, `Accessibility.getFullAXTree`): a `group` named `An agent wants to delete a task` and `button "Approve"` and `button "Decline"`.
- **Timeout.** Same call and no click; `ms` in `$E/delete.json` is between 59000 and 63000, the code is `confirmation_timeout`, the button read `Agent, 1 pending` at 30 s, and it reads `Agent` afterwards.
- **No app.** On an instance where no page was opened, the call returns `confirmation_unavailable` with `ms` under 1000.
- **Own click.** `$H browser <id> open /tasks/seed-baseline-1`, `click button "Delete task"`: no card appears, `eval "location.pathname"` is `/`, and the task is gone. `curl -s -X POST <server>/_parlor/actions/deleteTask -H 'content-type: application/json' -H "authorization: Bearer $($H token <id>)" -d '{"id":"seed-baseline-3"}'` deletes without a card; add `-H 'x-parlor-source: agent'` and it answers 503 `confirmation_unavailable` with no app open.
- **Targets.** With two tabs and `focus off` on the first (see `SKILL.md`), only the focused tab's `Agent` button shows the count; with both focused (a tie) both show it, and approving in one clears the other within 1 s with the task deleted once.
- **Shutdown.** Start the call, wait for the card, run `$H stop <id>`, then `$H start <id>`. `$E/delete.json` has `isError` true, the code is `confirmation_unavailable` and the message contains `did not run`; `listTasks` still has three tasks and the reloaded page's `Agent` button shows no count.
- **Reload.** Start the call, run `$H browser <id> open /`, and the button reads `Agent, 1 pending` again within 3 s with the panel closed; open it, approve the card and the call returns success.
- **Not blocking.** While a card waits, `$H mcp <id> call ui_screen '{}'` and a `ui_set` answer within 2 s.
- **Timing.** Read `startedAt` and `endedAt` from `--out`, and the card time with `$H browser <id> eval "performance.now()"` before and after, to compare.

## Gotchas

- A call that is never answered holds a card for 59 s; clear it with `Decline` before the next recipe, or `$H seed` and reload.
- `click button Approve` or `Decline` needs exactly one match; with two cards open use `eval` to find each card's button, or answer one card at a time. A real pointer click on a button in the open panel works too.
- Answering the last card leaves focus on the page body inside the open modal; press `Escape` to close the panel, or `Tab` to reach `Close`.
- The card names the agent from the MCP client's own name only when the client sends it with each request; the raw `$H mcp` client does not, so the card reads `An agent wants to delete a task`.
- The card follows the user: moving focus to another tab adds the card to that tab's panel without removing it from the first.
- A closed app fails after a 5 s grace, not 59 s; a reload inside the grace keeps the wait.
- A call for an id that does not exist still asks first; the card then reads `This task no longer exists`, and `Approve` answers the agent `not_found`.
- Approve and Decline exist once per card; with two cards open scope by the card's group, not the name alone.
- The card is a `group` inside the panel dialog and never takes focus, so keyboard users reach it with Tab from `Close`; `Escape` declines only while focus is inside the card, and the panel closes on `Escape` otherwise.
- A pending card does not open the panel by itself; the activity status and the count on the `Agent` button are the only signs while it is closed.
