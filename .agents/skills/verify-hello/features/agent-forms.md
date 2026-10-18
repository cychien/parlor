# Agent forms and pointing: ui_set and ui_highlight

An external agent can fill in the New task form for the user and point at things on screen. `ui_set` writes `title` and `notes` of the view `newTask`; the written fields get the app's agent-filled marking (`data-agent-filled`, a tinted background) until the user edits them, and the user presses `Add` themselves. `ui_highlight` scrolls a task row or a form field to the middle of the screen, focuses the field where the primary pointer is fine (a mouse or trackpad, so the web and the mac shell, not a touch screen), and marks it with `data-parlor-highlight` for 2 s. Neither is ever treated as the user's own attention, and the focus an agent places is not the user typing until they pointerdown, keydown or input in that field.

## Sub-features

- `set-fill` fills `title` and `notes`, returns the value read back and `agentFields`, and leaves the task list unchanged until the user presses `Add`.
- `set-merge` merges field by field: a second call changes only the fields it sends.
- `set-user-edit` takes a field back from the agent when the user edits it, and shows it unmarked.
- `set-user-editing` refuses a field the user has the caret in while the window has focus (`user_editing`) and writes once the window loses focus.
- `set-refusals` answers `not_writable`, `invalid_value` and `not_mounted` with a precise code and changes nothing.
- `set-submit` creates the task with its notes when the user presses `Add`, clears the form, and drops every marking.
- `highlight-row` scrolls `task` row `Task 25` to within 200 px of the vertical centre and marks it for 2 s.
- `highlight-field` focuses the `notes` field of `newTask` and marks it where the primary pointer is fine; on a touch screen (iOS) it marks the field without focusing it, so no software keyboard opens.
- `highlight-then-set` lets `ui_set` write `title` and `notes` right after `ui_highlight` pointed at `notes`; once the user types in a field, `ui_set` on it answers `user_editing` again.
- `highlight-not-attention` leaves `attention.lastInteracted` and `attention.lastEntered` unchanged.
- `highlight-missing` answers `not_mounted` for an unknown key.
- `notes-page` shows a task's notes on its page.
- `long-words-wrap` keeps a 60-character unbroken word in a title or notes inside a 390 px screen, with no horizontal scroll on any page.

## How to get to it (user POV)

- Ask an agent to "fill in a new task called Buy stamps with the note for the tax letter, but don't add it yet", then press `Add` in the app.
- Ask an agent to "show me Task 25" or "put the cursor in the notes box".
- Open a task that has notes at `/tasks/<id>`.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline` (`s30` for the row recipes, `notes` for the notes page), doctor clean, a page opened with `$H browser <id> open /`.
- `$E` is the evidence directory.

- **Fill.** Run `$H mcp <id> call ui_set '{"view":"newTask","value":{"title":"Buy stamps","notes":"for the tax letter"}}'`. `structuredContent` has `value` `{title, notes}` and `agentFields` `["title","notes"]`. `$H browser <id> snapshot` shows `textbox "New task" value="Buy stamps"` and `textbox "Notes"` with the note. `$H browser <id> eval "[...document.querySelectorAll('[data-agent-filled]')].map(e => e.name)"` is `["title","notes"]`. `listTasks` still returns the seed tasks only.
- **Submit.** Run `$H browser <id> click button "Add"`. `listTasks` has a last task `Buy stamps` with notes `for the tax letter`, both fields are empty, and the eval above returns `[]`.
- **Merge and take back.** Call `ui_set` with only `title`, then only `notes`: the second result's `value` has both. Run `$H browser <id> fill textbox "New task" "Plan trip!"` then click outside; a third call with only `notes` returns `agentFields` `["notes"]`, and the eval shows only the notes field marked.
- **User editing.** `fill textbox "New task" "Groc"` leaves the caret in the field with the window focused: `ui_set` with `title` answers `user_editing` and the field still reads `Groc`. Run `$H browser <id> focus off` (a fresh tab if the fill left real input focus, see `SKILL.md`) and the same call succeeds.
- **Refusals.** `ui_set` `{"view":"task","key":"seed-baseline-1","value":{"title":"x"}}` and `{"view":"newTask","value":{"due":"tomorrow"}}` answer `not_writable`; `{"view":"newTask","value":{"title":42}}` answers `invalid_value` with an issue path `title`; after `$H browser <id> open /settings`, `{"view":"newTask","value":{"title":"x"}}` and view `nope` answer `not_mounted`. None is a protocol error and the form is unchanged.
- **Highlight a row.** With `s30` on `/` scrolled to the top, run `$H mcp <id> call ui_highlight '{"view":"task","key":"seed-s30-25"}'`; `shown` is 1 and `$H browser <id> eval "(() => { const r = document.querySelector('[data-parlor-highlight]').getBoundingClientRect(); return [r.top, r.bottom, innerHeight] })()"` puts the row within 200 px of the centre. At 3 s `document.querySelector('[data-parlor-highlight]')` is `null`.
- **Highlight a field.** `ui_highlight` `{"view":"newTask","field":"notes"}`: `$H browser <id> eval "document.activeElement?.name"` is `notes` and the field carries the attribute. After `$H browser <id> emulate --viewport 390x844x3,mobile,touch` and a reload, `matchMedia('(pointer: fine)').matches` is false, the attribute is set and `document.activeElement` is the body. The iOS shell (`--target ios`) shows the same with no software keyboard in `$H screenshot`.
- **Point, then fill.** Right after the highlight above, `ui_set` `{"view":"newTask","value":{"title":"After pointing","notes":"written after pointing"}}` succeeds with `agentFields` `["title","notes"]`. Then `click textbox "New task"`, `press End`, `type "x"`: `ui_set` with `title` answers `user_editing` and the title still ends with `x`.
- **Attention.** Before and after a highlight, `ui_screen` `attention.lastInteracted` and `lastEntered` are equal.
- **Notes page.** With `notes`, open `/tasks/seed-notes-1`: the page shows `2 litres, semi-skimmed`.
- **Long words.** Create a task whose title and notes hold a 60-character word with no spaces, run `$H browser <id> emulate --viewport 390x844x3,mobile,touch`, and open `/`, `/settings` and `/tasks/<id>`: `eval "document.documentElement.scrollWidth"` equals `clientWidth` (390) on each and no text is clipped in a screenshot.

## Gotchas

- The attribute lives 2 s from when the scroll settles, so read it at once after the call and again after 3 s.
- Every tab reports focused here, so `user_editing` needs `focus off` on the tab to see the success branch; `fill` puts the tab back to focused.
- `ui_set` refuses with `ambiguous_client` when two tabs tie; close one or pass `clientId`.
- The field marking is derived from the agent's last write and the field's current value, and typing in a field drops the agent's claim for good: retyping the agent's exact value does not mark the field again until the agent writes it again.
- Focus is a pointer feature. A desktop browser reports `(pointer: fine)`, so `ui_highlight` focuses the field; `emulate` with `touch` turns it into `(pointer: coarse)` and the field stays unfocused. Reload after `emulate`.
- Reload the page after `$H seed`, which writes no sync event.
