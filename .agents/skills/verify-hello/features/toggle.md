# Toggle a task

Each task row is a checkbox. Clicking it flips the task between done and not done; a done task is checked and its title is struck through. The change is stored, so every other client sees it.

## Sub-features

- `toggle-done` checks an open task and strikes its title.
- `toggle-undone` unchecks a done task and removes the strike.
- `toggle-stored` stores the `done` flag, readable from storage and from `listTasks`.

## How to get to it (user POV)

- Click the checkbox or the title next to it (the title is inside the checkbox label).

## Driving it with hello.mjs

Preconditions:

- A web instance seeded with `baseline`, doctor clean, page open.

- **Check.** Run `$H browser <id> click checkbox "Buy milk"`. The printed snapshot shows `checkbox "Buy milk" checked`; the others stay unchecked.
- **Strike.** Run `$H browser <id> eval "getComputedStyle([...document.querySelectorAll('[data-testid=tasks] span')].find(s => s.textContent === 'Buy milk')).textDecorationLine"`. The result is `line-through`. Capture `$H browser <id> screenshot $E/toggle-done.png`.
- **Read back.** Run `curl -s -X POST localhost:<server>/_parlor/actions/listTasks -H 'content-type: application/json' -d '{}'`. `seed-baseline-1` has `"done": true`.
- **Uncheck.** Run `$H browser <id> click checkbox "Buy milk"` again. The snapshot line has no `checked` and the decoration is `none`.
- **Storage.** Run `$H sql <id> "select id, done from tasks order by created_at"`. Every row is `done: false` after the second click.

## Gotchas

- The checkbox is controlled by the server response, not by the click. If the snapshot still shows the old state, wait for it with `$H browser <id> wait` on a later snapshot rather than asserting immediately.
- Clicking the title toggles too, because the label wraps both.
- `toggleTask` with an unknown id answers HTTP 500 `Internal error`, not 404. Treat that as current behavior, not as a verification failure of this feature.
