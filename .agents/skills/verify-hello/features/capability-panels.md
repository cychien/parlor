# Notifications and deep link panels

On `/settings`, under `This device`, two panels show what the browser can do. The notifications panel reads `Notifications: available` (or the reason they are not) and has a `Notify` button that asks for permission once and then shows `Hello from Parlor` with body `Sent from this browser`. The deep link panel reads `Deep links: available` and lists every URL the app was opened with.

## Sub-features

- `notify-available` shows `Notifications: available`, or `Notifications: <reason>` when the browser has none.
- `notify-send` shows the notification and prints `sent`, or `permission <state>` when denied.
- `deeplink-available` shows `Deep links: available`.
- `deeplink-receive` lists the URL the page was opened with.

## How to get to it (user POV)

- Open `/settings` and scroll to `This device`.
- Click `Notify`.
- Load a page URL; on web the current URL counts as the opening link.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, the tab signed in.

- **Panels.** Run `$H browser <id> open /settings` and `$H browser <id> snapshot`. It contains `"Notifications: available"`, `button "Notify"`, `"Deep links: available"`, and the page URL `http://localhost:<web>/settings` as the one listed link.
- **Notify.** Run `$H browser <id> click button "Notify"`. The isolated browser denies notification permission, so the `status` next to the button reads `permission denied`. Report a delivered notification as not covered by this harness.
- **Deep link.** Run `$H browser <id> open "/settings?from=verify"`. The list shows `http://localhost:<web>/settings?from=verify`.

## Gotchas

- Notification permission prompts are browser UI outside the page; never count a missing prompt as a pass.
