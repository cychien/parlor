# Notifications and deep link panels

Below the tasks, two panels show what the current shell can do. The notifications panel names the platform adapter and has a `Notify` button that asks for permission once and then shows `Hello from Parlor` with body `Running on <platform>`. The deep link panel names its adapter and lists every URL the app was opened with.

## Sub-features

- `notify-platform` shows `Notifications via web`, `tauri`, or `capacitor`, or the reason they are unavailable.
- `notify-send` shows the notification and prints `sent`, or `permission <state>` when denied.
- `deeplink-platform` shows `Deep links via web`, `tauri`, or `capacitor`.
- `deeplink-receive` appends each opened URL to the panel's list.

## How to get to it (user POV)

- Scroll below Tasks in any shell.
- Click `Notify`.
- Open a `hello://` URL from another app (iOS, macOS) or load the page URL (web, where the current URL counts as the opening link).

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, for each shell under test.

- **Web platform.** Run `$H browser <id> snapshot`. It contains `Notifications via web`, `button "Notify"`, `Deep links via web`, and the page URL `http://localhost:<web>/` as the one listed link.
- **Web notify.** Run `$H browser <id> click button "Notify"`. The isolated browser denies notification permission, so the `status` next to the button reads `permission denied`. Report a delivered notification on web as not covered by this harness.
- **Web deep link.** Run `$H browser <id> open "/?from=verify"`. The list shows `http://localhost:<web>/?from=verify`.
- **mac.** Run `$H screenshot <id> $E/mac.png`. It shows `Notifications via tauri` and `Deep links via tauri`.
- **iOS.** Run `$H screenshot <id> $E/ios.png`. It shows `Notifications via capacitor` and `Deep links via capacitor`. Run `xcrun simctl openurl <udid> 'hello://open/verify'` (udid from `$H info <id>`, with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`), then screenshot again.

## Gotchas

- iOS asks `Open in "Hello"?` before delivering a `hello://` link. This skill cannot tap the dialog, so `deeplink-receive` on iOS needs a person or a UI automation tool; report it as not covered otherwise.
- The mac app runs as a raw dev binary, not an installed bundle, so macOS may not route `hello://` links to it; `open hello://...` could launch an older installed Hello instead. Do not use it as proof.
- Clicking `Notify` cannot be automated in the mac and iOS webviews here. A `sent` status already on screen came from a person's click, not from the run.
- Notification permission prompts are system UI and outside the page; never count a missing prompt as a pass.
