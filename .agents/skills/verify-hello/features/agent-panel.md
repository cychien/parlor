# Agent sidebar

The topbar `Agent` button opens the Agent sidebar: a docked, non-modal region named `Agent` fixed to the right edge of the screen. It holds the chat with the inline agent (computer picker, thread log, composer; see [Chat sidebar](./chat.md)) and, above the thread, the requests external agents wait on the user to approve. From 900 px wide it is 400 px wide beside the page; below that it covers the full width. It follows the light or dark color scheme of the device. While requests are pending the button shows their count and its accessible name says `Agent, <n> pending`. The sidebar's open state is the read-only agent view `agentPanel`.

## Sub-features

- `panel-open` opens the sidebar at 1280 px wide: region `Agent` 400 px wide against the right edge, the page behind stays interactive, `aria-expanded` true on the button, focus in `textbox "Message"`.
- `panel-close` closes with `button "Close"` or by pressing `Agent` again and returns focus to the `Agent` button.
- `panel-full` shows the sidebar at 390 px wide as a full-width layer: left 0, width 390, top 0 to the screen bottom.
- `panel-count` shows the pending count on the closed button and removes it when none are left.
- `panel-empty` with no computer shows `No computer connected` and the sentence `Connect a computer to your account to chat with an agent here.`; the composer is disabled.
- `panel-scheme` has a visible boundary and no horizontal overflow in both color schemes and at both sizes.
- `panel-view` reports `{open}` to `ui_screen` and refuses `ui_set` with `not_writable`.

## How to get to it (user POV)

- Press `Agent` in the topbar on any page.
- Ask an agent to delete a task and open the sidebar to answer.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, a page opened with `$H browser <id> open /` and `$H browser <id> emulate --viewport 1280x800x1`.

- **Open and close.** `$H browser <id> click button "Agent"`; `eval "() => { const r = document.querySelector('section.agent-sidebar').getBoundingClientRect(); return { hidden: document.querySelector('section.agent-sidebar').hidden, right: r.right, width: r.width } }"` reports `hidden` false, `right` 1280 and `width` 400. `click button "Close"`: `hidden` is true and `eval "document.activeElement?.className"` is `agent-button`.
- **Page stays live.** With the sidebar open `click button "Add"` and `fill textbox "New task" ...` still work; the sidebar does not make the page inert.
- **Full width.** `$H browser <id> emulate --viewport 390x844x2,mobile,touch`, reload, open the sidebar: the region's rect has left 0 and width 390.
- **Count.** Start two `deleteTask` calls with `--out`; `eval "document.querySelector('.agent-button').dataset.pending"` is `1` then `2` and the accessible name is `Agent, 2 pending`; the sidebar stays closed.
- **Color scheme.** `$H browser <id> emulate --color-scheme dark` (and `light`, `auto` to undo), reload, open the sidebar and screenshot; read `scrollWidth` and `clientWidth` of `section.agent-sidebar` and each `[role=group]`.
- **Dark badge.** With `emulate --color-scheme dark` and a pending request, the `.badge` inside `.agent-button` is a light circle with a dark digit (`getComputedStyle` background `rgb(199, 210, 254)`); in light it is dark indigo with a white digit.
- **View.** See `panel-view` in [Agent UI](./agent-ui.md).

## Gotchas

- `emulate` and the color scheme stay on the tab across later `open` calls; reset with `--viewport 1280x800x1 --color-scheme auto`.
- The sidebar is mounted on the first open and only hidden afterwards, so its snapshot lists the region only while it is open; the page behind stays in every snapshot.
- The snapshot region is `region "Agent"` (a `section` with `aria-labelledby`), not a `dialog`; `Escape` does nothing.
- Closing the sidebar never answers a pending card; the count stays on the button.
- The `Agent` button's accessible name is `Agent` with nothing pending and `Agent, <n> pending` otherwise, so `click button "Agent"` fails while a request waits.
- The thread picker is `combobox "Agent"` inside the region; `button "Close"` is unique only while the region is the sole holder of that name.
