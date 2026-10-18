# Tasks list and create

The Tasks section lists every task oldest first, each as a checkbox labelled with its title. A user types a title into `New task` and presses `Add`; the task appears at the end of the list and the field clears. Blank titles are ignored.

## Sub-features

- `tasks-list` shows every stored task in created order with its done state.
- `tasks-create` adds a task from the form and clears the field.
- `tasks-create-blank` ignores a title that is empty or only spaces.
- `tasks-persist` keeps created tasks across a server restart.
- `tasks-large` renders one thousand tasks.

## How to get to it (user POV)

- Open the app in a browser at the instance's web URL; the Tasks section is on the only page.
- Open the macOS app or the iOS app; the same page is the whole window.
- Press Enter in `New task` instead of clicking `Add` (it is a form).

## Driving it with hello.mjs

Preconditions:

- A web instance seeded with `baseline`, doctor clean.
- No task titled `Pick up parcel`.

- **List.** Run `$H browser <id> open /` and `$H browser <id> snapshot $E/list.aria.txt`. The snapshot has `checkbox "Buy milk"`, `checkbox "Write report"`, `checkbox "Call Amy"` in that order, none `checked`.
- **Create.** Run `$H browser <id> fill textbox "New task" "Pick up parcel"`, then `$H browser <id> click button "Add"`. The printed snapshot ends the list with `checkbox "Pick up parcel"` and `textbox "New task"` has no value.
- **Enter key.** Run `$H browser <id> fill textbox "New task" "Via enter"` and `$H browser <id> press Enter`. `Via enter` appears last.
- **Blank title.** Run `$H browser <id> fill textbox "New task" "   "` and `$H browser <id> click button "Add"`. The list is unchanged.
- **Second view.** Run `$H sql <id> "select title, done from tasks order by created_at"`. The rows end with `Pick up parcel` and `Via enter`, both `done: false`. This also restarts the instance; reopen the page and the list is the same, which proves `tasks-persist`.
- **Large.** Run `$H seed <id> large`, `$H browser <id> open /`, `$H browser <id> wait "Task 1000"`, and `$H browser <id> eval "document.querySelectorAll('[data-testid=tasks] li').length"`. The result is `1000` and the first item is `Task 0001`.
- **Proof.** `$H browser <id> screenshot $E/tasks.png` with the snapshot from each step.

## Gotchas

- `New task` and `Add` have no data-testid; use role and name. The list itself is `ul[data-testid=tasks]`.
- The `Add` button is disabled while a create is pending; click once and wait for the title.
- New tasks get the current time as `created_at`, so they sort after every seeded task, whose timestamps are in January 2026.
- `$H sql` stops and restarts the instance. Run it after the browser steps, then reopen the page.
- The mac and iOS webviews cannot be clicked from this skill. On those shells, create through MCP or HTTP and prove the list with `$H screenshot`, and report UI creation on those shells as not covered.
