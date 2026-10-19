---
name: verify-hello
description: "Drive the Parlor hello example (examples/hello) the way a user and an external agent do: the React web UI in a real browser through chrome-devtools-axi, MCP through Claude Code headless and a raw MCP client, plain HTTP actions, and the macOS (Tauri) and iOS simulator (Capacitor) shells. Use it to launch an isolated instance, seed tasks straight into PGlite, and capture evidence whenever a Parlor change needs proof on the real app."
---

# Verify hello

`examples/hello` is the only Parlor app. One `parlor dev` process runs two servers: the app server (srvx, `server.port`) with actions at `POST /_parlor/actions/<name>`, `GET /_parlor/manifest`, sync at `POST /_parlor/sync/token` plus an SSE stream, and MCP at `/_parlor/mcp`; and Vite (`web.port`), which serves the React UI and proxies `/_parlor` to the server. The mac and iOS targets load the same Vite page in a Tauri or Capacitor webview that calls the server directly at `server.url`.

Every command below goes through one control CLI. Run it from the checkout that holds this skill:

```sh
H=.agents/skills/verify-hello/scripts/hello.mjs
$H --help
```

The CLI drives the checkout it lives in. Pass `up --source <dir>` to drive another checkout, for example a main worktree for a regression comparison.

## Isolation

Read this before starting anything.

- The server opens PGlite at `.parlor/pglite` relative to the app dir (hardcoded in `examples/hello/server.ts`), and PGlite is single-process. Two servers in one checkout would share and corrupt one database, and nothing else can open it while a server runs. So every instance is a snapshot: `up` rsyncs the checkout (without `.git`, `node_modules`, `.parlor`, `docs`, `.agents`, `.claude`) into `~/.cache/parlor-verify-hello/instances/<id>/repo`, runs `pnpm install --offline` there, and the server runs from that copy with its own data dir. Never run `pnpm dev` in the checkout itself while verifying.
- Ports are chosen per instance: server from 3300-3399, web from 5300-5399, skipping any port `lsof` shows listening and any port another instance reserved. A third port from 9300-9399 is reserved for the instance's browser (`browserCdpPort` in `$H info <id>`): the session's Chrome is launched with `--remote-debugging-port` on it so the harness can reach CDP, which chrome-devtools-axi does not expose. An instance created before this port existed has none; recreate it. The copy's `parlor.config.ts` is replaced by an overlay that imports the real config (kept as `parlor.config.source.ts`) and overrides only `server.port`, `server.url`, and `web.port`.
- A snapshot is frozen at `up`. After editing the checkout run `$H sync <id>`; doctor fails its `build` check until you do.
- One iOS instance per simulator: the app id `dev.parlor.hello` is installed once per device, so `up` refuses a second instance on the same simulator. Pass `--device` to use another. Pick a device nobody else has booted and match its full name: two booted simulators whose names share a prefix, such as "iPhone 17 Pro" and "iPhone 17 Pro Max", cannot be told apart by a window-title click guard.
- Focus and visibility are not real here. chrome-devtools-mcp, which axi drives, emulates a focused page on every tab it manages, so by default every page reports `document.hasFocus()` true and `document.visibilityState` `visible` and never receives `blur`, even in a background tab (`selectpage` changes nothing). `$H browser <id> focus off|on` overrides that for the selected tab (see Drive). `visibilityState` cannot be changed at all: it stays `visible` in both states and `visibilitychange` never fires, in headless and in headed Chrome. Anything that depends on a hidden tab (agent UI client selection by visibility) cannot be reproduced here; do not read that as an app defect without a real window.
- Starting a web instance takes about 6 seconds (measured: `up` copies the checkout and runs `pnpm install --offline` in the copy), so start one per isolation need without hesitation. A mac or iOS instance takes minutes because it builds the native app; reuse a running one across checks with `$H seed` and `$H sync` instead of starting a new one.
- Browser sessions are per instance: `$H browser <id> ...` sets `CHROME_DEVTOOLS_AXI_SESSION=hello-<id>`. Never call chrome-devtools-axi without a session name, because the default session may belong to another agent.
- Desktop builds share one cargo target dir, `~/.cache/parlor-verify-hello/cargo-target`, so only the first mac launch compiles Tauri from scratch. Concurrent mac launches wait on cargo's lock.
- The Tauri mac app can come up before the server listens and then never joins agent UI until a reload, a known sync-client issue. A mac agent UI check that finds no client is not an app defect on that evidence alone.
- Override the root with `PARLOR_VERIFY_HOME`.

## Launch

```sh
$H up --seed baseline                         # web, prints JSON with urls, id, log, dataDir
$H up --target mac --seed baseline            # Tauri window; first cargo build takes minutes
$H up --target ios --seed baseline            # Capacitor app on "iPhone 17 Pro" (--device NAME|UDID)
```

`up` snapshots, picks ports, seeds before the first start when `--seed` is given, starts `parlor dev --target <t>` in its own process group, and returns only when the instance is usable:

- `GET <web>/` serves the page titled `Hello`, and `POST <web>/_parlor/actions/listTasks` answers through the Vite proxy, which means migrations ran and the server listens.
- mac: a `parlor_app` process runs in the instance tree and holds a connection to the server port.
- iOS: `UIKitApplication:dev.parlor.hello` runs on the simulator and the webview holds a connection to the server port.

`up` refuses to start when the 1-minute load average exceeds the core count (override the limit with `HELLO_MAX_LOAD`) or when 3 instances are already running (`HELLO_MAX_INSTANCES`), unless `--force`. The refusal prints the load, the core count, and the running instance ids; when the load is the reason it also lists the busiest processes with pid, ppid, elapsed time, and cwd, and flags the ppid-1 ones under the harness home as leftovers that `$H reap --kill` removes. Wait for the load to drop or `down` one instead of forcing.

A launch that fails or crashes prints the log tail, then removes the instance. Add `--keep-on-failure` to keep the snapshot and log for inspection, then `$H down <id>`. Timeouts are 2 minutes for web and 30 for mac and iOS. The iOS target gets `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` automatically, so `xcode-select` can stay on the Command Line Tools. Android is not covered: this machine has no Android SDK.

`up` creates `examples/hello/.parlor/` in the snapshot. That is verification scaffolding for a real bug: on a checkout that never ran before, `parlor dev` crashes with `ENOENT ... mkdir '.parlor/pglite'` because PGlite does not create parent directories. Remove the `mkdirSync` of `.parlor` in `snapshot()` once the framework creates it.

## Seed

Datasets are SQL fixtures in `fixtures/`, applied inside one transaction straight to the instance's PGlite after the app's own migrations (`examples/hello/migrations`, applied with the same drizzle migrator the server uses). They never go through actions. Each fixture deletes every task first, so loading twice gives the same state. IDs and `created_at` are fixed, and `listTasks` orders by `created_at`, so the order is deterministic.

| Dataset    | Contents                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline` | `Buy milk`, `Write report`, `Call Amy` in that created order, none done (ids `seed-baseline-1..3`)                                       |
| `s30`      | `Task 01` .. `Task 30` in order, none done                                                                                               |
| `notes`    | `Buy milk` with notes `2 litres, semi-skimmed`, `Write report` with notes `Due Friday`, `Call Amy` without notes (ids `seed-notes-1..3`) |
| `large`    | `Task 0001` .. `Task 1000` in order, none done, for perf and long-list checks                                                            |

```sh
$H up --seed baseline            # before the first start
$H seed <id> large               # on a running instance: stops it, loads, starts it again
```

Because PGlite allows one process, `seed` and `sql` stop a running instance and start it again with the same ports. Reload open pages afterwards (`$H browser <id> open /`): the seed writes no sync event, so a page left open keeps its old list. Seeding a mac or iOS instance relaunches the shell. To add a dataset, add `fixtures/<name>.sql` that starts with `DELETE FROM tasks;` and list it here.

## Doctor

```sh
$H doctor <id>      # read-only, exit 1 on any FAIL
```

It checks: processes alive in the instance tree; the snapshot fingerprint matches the checkout (`build`); both ports are listened on only by processes this instance started; the page, `/_parlor/manifest` (protocol 1 and the six actions), `/_parlor/sync/token` (transport), `listTasks` through the proxy (count and first titles), MCP `tools/list`; the server's working directory is the instance app dir (so PGlite is the instance's); for mac the `parlor_app` process; for iOS the app on the simulator; for both shells a connection to the server port from outside the dev tree. There is no auth: every request runs in the `default` scope. Run doctor first and whenever anything looks off.

## Drive

Feature recipes live in `features/README.md`. The surfaces:

- **Web UI, chrome-devtools-axi.** `$H browser <id> open /` loads the page. `click ROLE NAME` and `fill ROLE NAME TEXT` find the element by ARIA role and accessible name in a fresh snapshot and fail unless exactly one matches, so refs never go stale. Handles: `textbox "New task"`, `button "Add"`, `checkbox "<task title>"` (its snapshot line shows `checked` when done), `textbox "Name"`, heading `Hello, <name>!`, `button "Notify"`, the texts `Notifications via <platform>` and `Deep links via <platform>`. Any other axi command passes through with the instance's session: `$H browser <id> wait "Call Amy"`, `screenshot FILE`, `eval "<js>"`, `console`, `pages`, `newpage <url>`, `selectpage <id>`, `closepage <id>`. axi prints its errors on stdout; the harness includes them in the failure message.
- **Browser viewport.** The default chrome-devtools-axi viewport is 2029 px tall, so a list of about 30 rows never scrolls and a scroll check passes vacuously. Run `$H browser <id> emulate --viewport 1280x720x1` first. It stays on the tab across later `open` calls.
- **Reading page state with `eval`.** `eval` runs in the selected page. A bare expression returns its value; statements need the function form. A missing value prints `undefined` (for `eval`) or `null`.

  ```sh
  $H browser <id> eval "document.activeElement?.name"                   # the focused field's name attribute: "title" after fill textbox "New task", undefined on the body
  $H browser <id> eval "document.querySelector('[data-parlor-highlight]')?.getAttribute('data-parlor-highlight') ?? null"
  $H browser <id> eval "[...document.querySelectorAll('[data-parlor-highlight]')].map(e => e.dataset.parlorHighlight)"
  $H browser <id> eval "() => ({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState })"
  ```

  `data-parlor-highlight` is the attribute the agent UI puts on the element an agent is pointing at; it is `null` until something highlights. The hello fields are named `name` and `title`. Proven here by setting the attribute by hand on the first `li` and reading `"task:seed-baseline-1"` back.

- **Browser focus.** `$H browser <id> focus off` makes the selected tab report `document.hasFocus()` false and fires `blur`; `$H browser <id> focus on` makes it report true and fires `focus`. Each prints `{"url", "focus", "hasFocus", "visibilityState"}` read back from the page and exits 1 when the page does not match. Calling it in the state already reached does nothing. Read the effect from the page and from the app:

  ```sh
  $H browser <id> eval "() => { window.__ev = []; addEventListener('blur', () => __ev.push('blur')); addEventListener('focus', () => __ev.push('focus')); document.addEventListener('visibilitychange', () => __ev.push('vis:' + document.visibilityState)); return 1 }"
  $H browser <id> focus off
  $H browser <id> eval "() => ({ hasFocus: document.hasFocus(), visibilityState: document.visibilityState, events: __ev })"
  $H mcp <id> call ui_screen '{}'          # client.focused is false, or the page is listed in otherClients with focused false
  ```

  | State                    | `document.hasFocus()` | `visibilityState` | window events | `ui_screen` `focused` / `visible` |
  | ------------------------ | --------------------- | ----------------- | ------------- | --------------------------------- |
  | default, after `open`    | true                  | `visible`         | none          | true / true                       |
  | `focus off`              | false                 | `visible`         | `blur` once   | false / true                      |
  | `focus on` (after `off`) | true                  | `visible`         | `focus` once  | true / true                       |

  How it works: it drops axi's focus emulation from a second CDP session (enabling then disabling `Emulation.setFocusEmulationEnabled`) and activates another tab with `Target.activateTarget`, which removes the tab's real focus; `on` activates the selected tab again. It finds the selected tab by setting a probe on `window` through axi `eval` and looking for it over CDP. It reaches Chrome on the instance's `browserCdpPort`, so the browser session must have been started by `$H browser <id> ...`.

  Limits, all observed on chrome-devtools-mcp 1.11.0 with chrome-devtools-axi 0.1.44: `open`, `click`, and `fill` put the tab back to focused, so run `focus off` after them. After a `click` or `fill` the tab holds real input focus that `focus off` cannot shed (it exits 1 with the recipe): close it and start a fresh tab, `$H browser <id> closepage <id>`, `$H browser <id> newpage <web url>`, then `focus off`. `focus` acts on the selected tab only; other tabs stay focused, and `selectpage` changes nothing about focus. With two app tabs open, `focus off` on one turns the `ambiguous_client` answer of `ui_navigate` into a pick of the other.

- **MCP through a real agent.** `$H agent <id> --out <dir> "<prompt>"` runs `claude -p` with an MCP config pointing at `http://localhost:<server>/_parlor/mcp` (streamable HTTP), `--strict-mcp-config`, every built-in tool removed (`--tools ""`), only `mcp__hello` allowed, user settings and hooks skipped, no session saved. It writes `agent-mcp-config.json`, `agent-command.json`, `agent-transcript.jsonl` (stream-json), and `agent-summary.json` (MCP server status, every tool call with its input, final text) into `<dir>`. Add `--model M` to pick a model.
- **Which MCP path.** Drive a check through `$H mcp` when it is about a tool's result: its fields, error codes, which client it picks, what it does under concurrency. It answers in milliseconds and spends no model. Use `$H agent` only when the check is whether an agent reads a plain request and picks the right tool and arguments, because each run costs a model turn per call and 30 to 90 seconds. The two send the same MCP requests, so the app cannot tell them apart; they differ in timing between calls (an agent pauses to think) and in which arguments get sent.
- **MCP without a model.** `$H mcp <id> tools` and `$H mcp <id> call createTask '{"title":"X"}'` use `@modelcontextprotocol/client` (2.3.1) from the snapshot. Tools: the actions `hello`, `listTasks`, `getTask`, `createTask`, `toggleTask`, `deleteTask`, plus `ui_screen`, `ui_navigate`, `ui_set` and `ui_highlight`; `readOnlyHint` is true for `hello`, `listTasks`, `getTask`, and `ui_screen`. `deleteTask` asks the user to confirm in the app before it runs, so call it with `--out FILE &` and click the card (see the confirmations recipe).
- **A call that blocks on a confirmation card.** The call does not return until the card is answered in the UI. Run `$H mcp <id> call <tool> '<json>' --out FILE &`, drive the browser to answer the card, then read FILE, which records the result with its start and end times.
- **MCP resources.** `$H mcp <id> resources` lists them; `$H mcp <id> resource parlor://manifest` reads one and prints the `resources/read` result (`contents[]` with `uri`, `mimeType`, `text`). An unknown URI prints `mcp resource failed: Resource not found: <uri>` and exits 1. To get the manifest itself: `$H mcp <id> resource parlor://manifest | jq -r '.contents[0].text | fromjson'`. `parlor://manifest` is the app's pages and views with their JSON schemas.
- **A tool call in the background.** `$H mcp <id> call TOOL '{...}' --out FILE &` runs a call that may block, such as one waiting for a click in the browser, while the shell drives the page. FILE appears only when the call ends (written whole, never partial) as `{tool, input, startedAt, endedAt, ms, isError, result}` with epoch-millisecond timestamps from `Date.now()`; `result` is the tool result, or `{error}` when the request failed (for example an unknown tool), and the command still prints the result and exits 1 on error. A call may wait up to 180 s without progress, longer if the server sends progress notifications, and at most 300 s in total; these are explicit request options, not the SDK default of 60 s. Proven with a 75 s action: the call returned `ms: 75011`, `isError: false`.

  ```sh
  $H mcp <id> call SLOW_TOOL '{}' --out "$E/slow.json" > "$E/slow.stdout" &
  # drive the browser meanwhile
  wait %1                                  # or poll: until [ -f "$E/slow.json" ]; do sleep 1; done
  jq '{isError, ms}' "$E/slow.json"
  ```

  `mcp ID tools` and `resources` take no `--out`. Right after `$H sync <id>` the server restarts and `mcp` answers `fetch failed` for a few seconds; retry.

- **HTTP.** Actions take a JSON body and answer `{"data": ..., "tags": [...]}`; errors answer `{"error": {"code", "message", "issues"}}` with 400, 404, or 500.

  ```sh
  curl -s -X POST localhost:<server>/_parlor/actions/createTask -H 'content-type: application/json' -d '{"title":"X"}'
  curl -s localhost:<server>/_parlor/manifest
  curl -s -X POST localhost:<server>/_parlor/sync/token
  ```

  Send `x-parlor-client: <any id>` to act as a distinct client.

- **Storage.** `$H sql <id> "select title, done from tasks order by created_at"` runs one read-only transaction against PGlite (it stops and restarts the instance). Use it as the second view of a mutation.
- **macOS desktop.** `$H screenshot <id> FILE` captures the `parlor_app` window by its window id, even when other windows cover it. There is no click automation for the WKWebView: drive state through HTTP or MCP and prove the window follows. Window title `Hello`, size 1024x768.
- **iOS simulator.** `$H screenshot <id> FILE` uses `xcrun simctl io <udid> screenshot`. Deep links: `xcrun simctl openurl <udid> 'hello://open/x'` with the udid from `$H info <id>`. There is no tap automation; drive state through HTTP or MCP.

## Evidence

```sh
E=$($H evidence)/<check-id>     # this branch's verification directory, from verify.py where
mkdir -p "$E"
```

Keep every artifact there, named by check, never inside the repo or the instance dir. For a proof:

- Drive the user path: the browser for UI claims, `agent` for agent claims, the shell window for shell claims. Never call an action over HTTP to stand in for a UI click.
- Capture the action and the resulting state: an ARIA snapshot (`$H browser <id> snapshot $E/x.aria.txt`) and a screenshot before and after, the agent's transcript and summary, the HTTP response body.
- Read the side effect back from a second view: `$H sql` for stored rows, `listTasks` over HTTP or MCP, or a second surface (a write from MCP showing up in the browser without reload).
- Save the doctor output and, at the end, the dev log (`down --save-log`).
- Mock nothing: every piece runs locally, including PGlite.

## Cleanup

```sh
$H down <id> --save-log "$E/dev.log"     # or: $H down --all
$H reap                                   # exit 0 and [] when nothing runs from the home
```

`$H list` printing `[]` is not proof that nothing survives, because a server whose instance directory is gone has no state file; `list` now also prints stray processes under the home, and `reap` is the check that exits non-zero while any remain. `$H reap --kill` sweeps strays: it sends SIGTERM, then SIGKILL after 10 seconds, to every process whose cwd (deleted cwds included) or command is under `~/.cache/parlor-verify-hello/instances`, and rescans. It also kills live instances, so run it only when none is in use.

`down` stops the instance's browser session, sends SIGTERM to each process group the instance started, then SIGKILL to what is left after 10 seconds, terminates the iOS app and shuts the simulator down if `up` booted it, and deletes the snapshot only when its postcondition holds. It first re-records the instance's processes, so children started after readiness are included, and finds them by recorded pids, process groups, and descendants. It then rescans the whole process table for any process whose cwd or command is under the instance dir and for any listener on the instance's server, web, and browser ports, and SIGKILLs what it finds. If anything still survives, `down` prints each survivor, keeps the instance dir and its recorded processes, and exits 1: never treat a `down` that failed as down. It matches by path and port, never by process name, so other node or Vite processes on the machine are untouched. Evidence is never under the instance dir, so it survives. The shared cargo target dir is a build cache and stays; delete `~/.cache/parlor-verify-hello/cargo-target` by hand to reclaim its space.

## Helpers

- `scripts/hello.mjs` is the whole control CLI: `up`, `doctor`, `seed`, `sql`, `stop`, `start`, `sync`, `browser`, `mcp`, `agent`, `screenshot`, `info`, `list`, `reap`, `down`, `evidence`. `$H --help` prints usage, datasets, and the home dir.
- `fixtures/*.sql` are the datasets.
- `features/` is the feature map. Keep it current with the **maintain-verification-skill** skill.
