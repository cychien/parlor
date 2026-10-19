# Confirmations: deleteTask asks the user

`deleteTask` is marked `confirm: true`. When an agent calls it over MCP, the app shows a card on the client the user is looking at with `Approve` and `Decline`. The card reads `<agent> wants to delete a task`, the question `Delete the task "<title>"?`, and a muted line `deleteTask · <task id>`. For an id that no longer exists the question reads `This task no longer exists`. The call waits for the answer for at most 59 s. A call from the app's own `Delete task` button, or from plain HTTP without an agent source, never asks.

## Sub-features

- `confirm-approve` runs the delete after `Approve` and the card disappears.
- `confirm-decline` answers the agent `declined`, deletes nothing, and the card disappears.
- `confirm-escape` declines the card when `Escape` is pressed with focus inside it, and does nothing when focus is elsewhere.
- `confirm-focus` leaves focus where it was: a card that appears while the user types in `New task` does not take it.
- `confirm-announced` puts each card in a polite live region as a group named `<agent> wants to delete a task`, so a screen reader announces it.
- `confirm-timeout` answers `confirmation_timeout` between 59 and 63 s, deletes nothing, and the card is gone.
- `confirm-no-app` answers `confirmation_unavailable` within 1 s with no app open, and says to ask the user to do it in the app.
- `confirm-own-click` deletes without a card from the `Delete task` button on `/tasks/<id>` and returns to `/` within 1 s; a plain HTTP call without `x-parlor-source` deletes too.
- `confirm-target` shows the card on the focused tab only; on a tie it shows on every tied tab and the first answer wins.
- `confirm-reload` shows the card again within 3 s after a reload and runs the delete once.
- `confirm-not-blocking` leaves `ui_screen` and `ui_set` answering while a card waits.
- `confirm-policy` still asks when the ui_ tools are hidden with `agentUi: { external: false }`.
- `confirm-shutdown` answers `confirmation_unavailable` with a message saying the action did not run when the server stops while the card waits, deletes nothing, and shows no card after the restart.
- `confirm-indicator` shows "Agent is asking you to confirm" while the card is up.

## How to get to it (user POV)

- Ask an agent to "delete the task Write report" and answer the card in the app.
- Open a task and press `Delete task`.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, a page opened with `$H browser <id> open /`.

- **Approve.** Run `$H mcp <id> call deleteTask '{"id":"seed-baseline-2"}' --out $E/delete.json &`. While it waits, `$H browser <id> snapshot` shows `button "Approve"` and `button "Decline"` in a `live="polite"` container with the text `Delete the task "Write report"?` and `deleteTask · seed-baseline-2`, and `listTasks` still has three tasks. Run `$H browser <id> click button Approve`. The list loses `Write report` without a reload, and `$E/delete.json` has `isError` false.
- **Decline.** Same call, then `click button Decline`. `$E/delete.json` has `isError` true and the text parses to `{"error":{"code":"declined",...}}`; `listTasks` is unchanged.
- **Escape.** Same call, then `$H browser <id> eval "document.querySelector('.card button.primary').focus()"` and `$H browser <id> press Escape`. The card is gone and `$E/delete.json` has the code `declined`. With focus in `New task` instead, `press Escape` leaves the card up.
- **Focus.** `fill textbox "New task" "Groc"`, start the call, `wait "Delete the task"`, then `eval "document.activeElement?.name"` is still `title` and the field still reads `Groc`.
- **Announced.** With the card up, `$H browser <id> snapshot` shows a `generic live="polite"` node holding the card text and both buttons. The group's accessible name is not in the axi snapshot; read it from the full accessibility tree over CDP (`browserCdpPort` from `$H info <id>`, `Accessibility.getFullAXTree`): a `group` named `An agent wants to delete a task` and `button "Approve"` and `button "Decline"`.
- **Timeout.** Same call and no click; `ms` in `$E/delete.json` is between 59000 and 63000, the code is `confirmation_timeout`, and the card was visible at 30 s.
- **No app.** On an instance where no page was opened, the call returns `confirmation_unavailable` with `ms` under 1000.
- **Own click.** `$H browser <id> open /tasks/seed-baseline-1`, `click button "Delete task"`: no card appears, `eval "location.pathname"` is `/`, and the task is gone. `curl -s -X POST <server>/_parlor/actions/deleteTask -H 'content-type: application/json' -d '{"id":"seed-baseline-3"}'` deletes without a card; add `-H 'x-parlor-source: agent'` and it answers 503 `confirmation_unavailable` with no app open.
- **Targets.** With two tabs and `focus off` on the first (see `SKILL.md`), only the focused tab shows the card; with both focused (a tie) both show it, and approving in one clears the other within 1 s with the task deleted once.
- **Shutdown.** Start the call, wait for the card, run `$H stop <id>`, then `$H start <id>`. `$E/delete.json` has `isError` true, the code is `confirmation_unavailable` and the message contains `did not run`; `listTasks` still has three tasks and the reloaded page shows no card.
- **Reload.** Start the call, run `$H browser <id> open /`, and the card is back within 3 s; approve it and the call returns success.
- **Not blocking.** While a card waits, `$H mcp <id> call ui_screen '{}'` and a `ui_set` answer within 2 s.
- **Timing.** Read `startedAt` and `endedAt` from `--out`, and the card time with `$H browser <id> eval "performance.now()"` before and after, to compare.

## Gotchas

- A call that is never answered holds a card for 59 s; clear it with `Decline` before the next recipe, or `$H seed` and reload.
- The card names the agent from the MCP client's own name only when the client sends it with each request; the raw `$H mcp` client does not, so the card reads `An agent wants to delete a task`.
- The card follows the user: moving focus to another tab adds the card there without removing it from the first.
- A closed app fails after a 5 s grace, not 59 s; a reload inside the grace keeps the wait.
- A call for an id that does not exist still asks first; the card then reads `This task no longer exists`, and `Approve` answers the agent `not_found`.
- Approve and Decline exist once per card; with two cards open scope by the card's group, not the name alone.
- The card has no dialog role and never takes focus, so keyboard users reach it with Tab; `Escape` declines only while focus is inside it.
