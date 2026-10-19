# Agent panel

The topbar has an `Agent` button that opens the agent panel: a native modal dialog titled `Agent` that holds the requests agents wait on the user to approve, or the sentence `No requests from agents.` when there are none. From 640 px wide the panel is a centered dialog; below that it is a sheet fixed to the bottom edge of the screen. It follows the light or dark color scheme of the device. While requests are pending the button shows their count and its accessible name says `Agent, <n> pending`. The panel's open state is the read-only agent view `agentPanel`.

## Sub-features

- `panel-open` opens a centered modal dialog at 1280 px wide, makes the page behind inert, and sets `aria-expanded` true on the button.
- `panel-close` closes with the `Close` button or `Escape` and returns focus to the `Agent` button.
- `panel-sheet` shows the panel as a bottom sheet at 390 px wide: left 0, full width, bottom at the screen edge.
- `panel-count` shows the pending count on the closed button and removes it when none are left.
- `panel-empty` shows the empty sentence with no cards.
- `panel-scheme` has a visible backdrop and boundary, and no horizontal overflow, in both color schemes and at both sizes.
- `panel-view` reports `{open}` to `ui_screen` and refuses `ui_set` with `not_writable`.

## How to get to it (user POV)

- Press `Agent` in the topbar on any page.
- Ask an agent to delete a task and open the panel to answer.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, a page opened with `$H browser <id> open /` and `$H browser <id> emulate --viewport 1280x800x1`.

- **Open and close.** `$H browser <id> click button "Agent"`; `eval "() => { const r = document.querySelector('dialog.agent-panel').getBoundingClientRect(); return { open: document.querySelector('dialog.agent-panel').open, center: (r.left + r.right) / 2 } }"` reports `open` true and a center of 640. Press `Escape`: `open` is false and `eval "document.activeElement?.className"` is `agent-button`.
- **Inert page.** With the panel open, a real pointer click on the `Settings` link (CDP `Input.dispatchMouseEvent` at its coordinates; `click link Settings` cannot find it because the snapshot holds only the dialog) leaves `location.pathname` at `/`.
- **Sheet.** `$H browser <id> emulate --viewport 390x844x2,mobile,touch`, reload, open the panel: after about 300 ms the dialog's rect has left 0, width 390, bottom 844. `click button "Close"` closes it and focus is on `.agent-button`.
- **Count.** Start two `deleteTask` calls with `--out`; `eval "document.querySelector('.agent-button').dataset.pending"` is `1` then `2` and the accessible name is `Agent, 2 pending`; the panel stays closed.
- **Color scheme.** `$H browser <id> emulate --color-scheme dark` (and `light`, `auto` to undo), reload, open the panel and screenshot; read `scrollWidth` and `clientWidth` of `dialog.agent-panel` and each `[role=group]`.
- **Dark badge.** With `emulate --color-scheme dark` and a pending request, the `.badge` inside `.agent-button` is a light circle with a dark digit (`getComputedStyle` background `rgb(199, 210, 254)`); in light it is dark indigo with a white digit.
- **View.** See `panel-view` in [Agent UI](./agent-ui.md).

## Gotchas

- `emulate` and the color scheme stay on the tab across later `open` calls; reset with `--viewport 1280x800x1 --color-scheme auto`.
- The open panel is a modal: the page behind is inert, the snapshot lists only the dialog, and `click` on page elements fails until it closes.
- The sheet animates in for 160 ms; read its rect after that.
- Closing the panel never answers a pending card; the count stays on the button.
- The `Agent` button's accessible name is `Agent` with nothing pending and `Agent, <n> pending` otherwise, so `click button "Agent"` fails while a request waits.
