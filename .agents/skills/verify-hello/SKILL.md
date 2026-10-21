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
- Ports are chosen per instance: server from 3300-3399, web from 5300-5399, skipping any port `lsof` shows listening and any port another instance reserved. A third port from 9300-9399 is reserved for the instance's browser (`browserCdpPort` in `$H info <id>`): the session's Chrome is launched with `--remote-debugging-port` on it so the harness can reach CDP, which chrome-devtools-axi does not expose. A `HELLO_BROWSER_PROFILE` browser gets its own port from the same range the first time it is used (`HELLO_BROWSER_PROFILE=bob $H info <id>` prints it as `browserCdpPort`; `browserCdpPorts` lists them all). An instance created before this port existed has none; recreate it. The copy's `parlor.config.ts` is replaced by an overlay that imports the real config (kept as `parlor.config.source.ts`) and overrides only `server.port`, `server.url`, and `web.port`.
- A snapshot is frozen at `up`. After editing the checkout run `$H sync <id>`; doctor fails its `build` check until you do.
- One iOS instance per simulator: the app id `dev.parlor.hello` is installed once per device, so `up` refuses a second instance on the same simulator. Pass `--device` to use another. Pick a device nobody else has booted and match its full name: two booted simulators whose names share a prefix, such as "iPhone 17 Pro" and "iPhone 17 Pro Max", cannot be told apart by a window-title click guard.
- Focus and visibility are not real here. chrome-devtools-mcp, which axi drives, emulates a focused page on every tab it manages, so by default every page reports `document.hasFocus()` true and `document.visibilityState` `visible` and never receives `blur`, even in a background tab (`selectpage` changes nothing). `$H browser <id> focus off|on` overrides that for the selected tab (see Drive). `visibilityState` cannot be changed at all: it stays `visible` in both states and `visibilitychange` never fires, in headless and in headed Chrome. Anything that depends on a hidden tab (agent UI client selection by visibility) cannot be reproduced here; do not read that as an app defect without a real window.
- Starting a web instance takes about 6 seconds (measured: `up` copies the checkout and runs `pnpm install --offline` in the copy), so start one per isolation need without hesitation. A mac or iOS instance takes minutes because it builds the native app; reuse a running one across checks with `$H seed` and `$H sync` instead of starting a new one.
- Browser sessions are per instance: `$H browser <id> ...` sets `CHROME_DEVTOOLS_AXI_SESSION=hello-<id>`. Never call chrome-devtools-axi without a session name, because the default session may belong to another agent. Tabs of one session share cookies, so a second signed-in user needs a second Chrome: `HELLO_BROWSER_PROFILE=bob $H browser <id> signin bob` uses session `hello-<id>-bob` with its own cookie jar and CDP port, so `focus` and `presence` work there too; stop it with `HELLO_BROWSER_PROFILE=bob $H browser <id> stop`. `down` stops every profile's browser.
- Desktop builds share one cargo target dir, `~/.cache/parlor-verify-hello/cargo-target`, so only the first mac launch compiles Tauri from scratch. Concurrent mac launches wait on cargo's lock.
- A shell or page that comes up before the server listens keeps retrying SSE negotiation with backoff (1 s doubling to 30 s) and joins agent UI within a few seconds of the server listening, with no reload.
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

`up` is refused, unless `--force`, by any of these rules, and the message says which one:

- load: the 1-minute load average is at or above 0.7 x cores; `HELLO_MAX_LOAD` replaces that limit with an absolute number.
- native: a `mac` or `ios` instance is requested while another native instance is still starting (not yet ready); web instances are never held back by it.
- instance cap: `HELLO_MAX_INSTANCES` is set and that many instances are running; it is unset by default.

A fixed instance count was either too low on an idle machine or too high under load; the load average and one native build at a time track what actually overloads the machine. The refusal prints the load, the core count, and the running instance ids; when the load is the reason it also lists the busiest processes with pid, ppid, elapsed time, and cwd, and flags the ppid-1 ones under the harness home as leftovers that `$H reap --kill` removes. Wait for the load to drop or for the native instance to be ready, or `down` one, instead of forcing.

A launch that fails or crashes prints the log tail, then removes the instance. Add `--keep-on-failure` to keep the snapshot and log for inspection, then `$H down <id>`. Timeouts are 2 minutes for web and 30 for mac and iOS. The iOS target gets `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` automatically, so `xcode-select` can stay on the Command Line Tools. Android is not covered: this machine has no Android SDK.

`up` creates `examples/hello/.parlor/` in the snapshot. That is verification scaffolding for a real bug: on a checkout that never ran before, `parlor dev` crashes with `ENOENT ... mkdir '.parlor/pglite'` because PGlite does not create parent directories. Remove the `mkdirSync` of `.parlor` in `snapshot()` once the framework creates it.

## Seed

Datasets are SQL fixtures in `fixtures/`, applied inside one transaction straight to the instance's PGlite after the app's own migrations (`examples/hello/migrations`, applied with the same drizzle migrator the server uses). They never go through actions. Each fixture deletes every task first, so loading twice gives the same state. Every task belongs to Alice (`scope = 'alice'`).

Every instance also gets, before its first start and on every `seed`, the users `alice` (Alice, alice@example.com) and `bob` (Bob, bob@example.com), both with the password `parlor-verify-hello`, and an OAuth client `verify-hello` linked to the instance's MCP resource with `skip_consent`, which is how `mcp`, `agent` and `token --kind mcp` get an access token without a consent page. The resource is the web origin (`http://localhost:<web>/_parlor/mcp`), because that is the app's public origin in dev. IDs and `created_at` are fixed, and `listTasks` orders by `created_at`, so the order is deterministic.

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

Because PGlite allows one process, `seed` and `sql` stop a running instance and start it again with the same ports. Reload open pages afterwards (`$H browser <id> open /`): the seed writes no sync event, so a page left open keeps its old list. Seeding a mac or iOS instance relaunches the shell. To add a dataset, add `fixtures/<name>.sql` that starts with `DELETE FROM tasks;`, give its tasks a `scope` (a user id), and list it here.

## Doctor

```sh
$H doctor <id>      # read-only, exit 1 on any FAIL
```

It checks: processes alive in the instance tree; the snapshot fingerprint matches the checkout (`build`); both ports are listened on only by processes this instance started; the page, `/_parlor/manifest` (protocol 1 and the six actions), `/_parlor/sync/token` (transport), `listTasks` through the proxy (count and first titles), MCP `tools/list`; the server's working directory is the instance app dir (so PGlite is the instance's); for mac the `parlor_app` process; for iOS the app on the simulator; for both shells a connection to the server port from outside the dev tree. Probes that need a user run as Alice; `auth` checks that an anonymous `listTasks` answers 401. Run doctor first and whenever anything looks off.

## Drive

Feature recipes live in `features/README.md`. The surfaces:

- **Signing in.** Every page but `/sign-in` sends a signed-out visitor to `/sign-in`. `$H browser <id> signin [alice|bob]` signs the selected tab in through that page (signing out first when someone is signed in) and waits for the app. `seed`, `stop` and `start` restart the instance's Chrome with a fresh profile (chrome-devtools-axi runs it `--isolated`), so sign in again afterwards. `sql` keeps every browser of the instance running, so cookies, IndexedDB and virtual authenticator credentials survive it; reload the page if it must see the restarted server's state. `sql` and `seed` also keep a connected real `parlor-host` (any process whose `HOME` or working directory is under `<home>/h/`, the isolated HOMEs, with its agents and their children, so a daemon a check starts itself from the snapshot is kept too): the host rides out the server restart and claims the next turn by itself. `stop` and `down` still kill it. In the Mac window there is no click automation, but System Events keystrokes work: bring `parlor_app` to the front, Tab into Email, and type the password one character at a time with a short delay (typed at full speed, WKWebView drops characters).
- **Web UI, chrome-devtools-axi.** `$H browser <id> open /` loads the page. `click ROLE NAME` and `fill ROLE NAME TEXT` find the element by ARIA role and accessible name in a fresh snapshot and fail unless exactly one matches; when the page re-renders between that snapshot and the action (`STALE_REF`) they resolve a fresh ref and retry once. Handles: on `/sign-in` `textbox "Email"`, `textbox "Password"`, `button "Sign in"`, `button "Create an account"`; in the app `button "Sign out"` and `button "Agent"` (`button "Agent, <n> pending"` while requests wait), which toggles the Agent sidebar (`region "Agent"`, a `section.agent-sidebar`; mounted on first open) holding `combobox "Agent"` (the computer and agent picker), the thread log `ol[role=log]`, `textbox "Message"`, `button "Send"`, `button "Stop"` (only while a turn runs) and `button "Close"`; on `/settings` `button "Sign out <device>"` per session, `button "Revoke <agent>"` per connected agent and `button "Revoke <host name>"` per connected computer; `textbox "New task"`, `button "Add"`, `checkbox "<task title>"` (its snapshot line shows `checked` when done), `textbox "Name"`, heading `Hello, <name>!`, `button "Notify"`, the texts `Notifications via <platform>` and `Deep links via <platform>`. Any other axi command passes through with the instance's session: `$H browser <id> wait "Call Amy"`, `screenshot FILE`, `eval "<js>"`, `console`, `pages`, `newpage <url>`, `selectpage <id>`, `closepage <id>`. axi prints its errors on stdout; the harness includes them in the failure message.
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

- **WebAuthn presence.** `$H browser <id> presence on|off` gives every tab of the browser a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`: `ctap2`, transport `internal`, resident key, user verification), so a page's `navigator.credentials.create` and `get` are answered by it instead of Touch ID, and prints `{profile, pid, cdpPort, presence, targets, events}`. `on` answers with user presence and verification (flags UP=1 UV=1); `off` fails user verification, so a `get` that requires it rejects at once with `NotAllowedError`, like a cancelled Touch ID prompt, while one that does not still gets UP=1 UV=0. With `HELLO_BROWSER_PROFILE` it acts on that profile's browser. Start the browser first (`signin` or `open`), and turn presence on before the page's first WebAuthn call: a credential lives on the tab's authenticator.

  How it works: Chrome drops a tab's virtual authenticator, with its credentials, whenever any DevTools session attached to that tab detaches (measured on Chrome 155: one short-lived `Runtime.evaluate` connection is enough), so the authenticators belong to a detached holder, `scripts/presence-holder.mjs`, that keeps its own sessions open for as long as the browser runs, attaches to every new tab, snapshots each authenticator's credentials and restores them (same ids and keys) within 250 ms when another client's detach wipes them; `focus` does that, and the holder's `events` show each `restored`. The holder exits with its browser; `down` stops it. A `get` started while the environment is wiped fails with `NotAllowedError`.

- **MCP through a real agent.** `$H agent <id> --out <dir> "<prompt>"` runs `claude -p` with an MCP config pointing at `http://localhost:<web>/_parlor/mcp` (streamable HTTP) with an `Authorization: Bearer` access token for Alice (`--as bob` for Bob), `--strict-mcp-config`, every built-in tool removed (`--tools ""`), only `mcp__hello` allowed, user settings and hooks skipped, no session saved. It writes `agent-mcp-config.json`, `agent-command.json`, `agent-transcript.jsonl` (stream-json), and `agent-summary.json` (MCP server status, every tool call with its input, final text) into `<dir>`. Add `--model M` to pick a model.
- **Which MCP path.** Drive a check through `$H mcp` when it is about a tool's result: its fields, error codes, which client it picks, what it does under concurrency. It answers in milliseconds and spends no model. Use `$H agent` only when the check is whether an agent reads a plain request and picks the right tool and arguments, because each run costs a model turn per call and 30 to 90 seconds. The two send the same MCP requests, so the app cannot tell them apart; they differ in timing between calls (an agent pauses to think) and in which arguments get sent.
- **MCP without a model.** `$H mcp <id> tools` and `$H mcp <id> call createTask '{"title":"X"}'` use `@modelcontextprotocol/client` (2.3.1) from the snapshot, as Alice unless `--as bob`; the access token is cached in the instance state until a minute before it expires. Tools: the actions `hello`, `listTasks`, `getTask`, `createTask`, `toggleTask`, `deleteTask`, plus `ui_screen`, `ui_navigate`, `ui_set` and `ui_highlight`; `readOnlyHint` is true for `hello`, `listTasks`, `getTask`, and `ui_screen`. `deleteTask` asks the user to confirm in the app before it runs, so call it with `--out FILE &` and click the card (see the confirmations recipe).
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

- **MCP through Claude Code's own OAuth.** To prove the real authorization flow rather than the harness token: in an empty directory under the scratchpad run `claude mcp add --transport http --scope local hello http://localhost:<web>/_parlor/mcp`, then `script -q OUT claude mcp login hello --no-browser < /dev/null &`; OUT gets the authorize URL (Claude Code uses its CIMD client id `https://claude.ai/oauth/claude-code-client-metadata`, which the server fetches over the internet). Open it with `$H browser <id> open` in a tab signed in as Alice, click `button "Allow"`, and OUT ends with `Authenticated with "hello"`. Then `claude -p` in that directory uses the stored token. Clean up with `claude mcp logout hello` and `claude mcp remove hello --scope local`.
- **HTTP.** Every action but a `public` one needs a session: `$H token <id> [--as bob]` prints a fresh bearer session, `--kind mcp` an MCP access token. Actions take a JSON body and answer `{"data": ..., "tags": [...]}`; errors answer `{"error": {"code", "message", "issues"}}` with 400, 401, 403, 404, or 500.

  ```sh
  T=$($H token <id>)
  curl -s -X POST localhost:<server>/_parlor/actions/createTask -H 'content-type: application/json' -H "authorization: Bearer $T" -d '{"title":"X"}'
  curl -s localhost:<server>/_parlor/manifest -H "authorization: Bearer $T"
  curl -s -X POST localhost:<server>/_parlor/sync/token -H "authorization: Bearer $T"
  curl -s -X POST localhost:<server>/_parlor/auth/actions/sessions -H 'content-type: application/json' -H "authorization: Bearer $T" -d '{}'
  ```

  Send `x-parlor-client: <any id>` to act as a distinct client.

- **Storage.** `$H sql <id> "select title, done from tasks order by created_at"` runs one read-only transaction against PGlite (it stops and restarts the instance, but not its browsers). Use it as the second view of a mutation. `$H sql <id> --write "update ... returning id"` runs one read-write transaction instead and prints `{"affectedRows", "rows"}`, for a check that plays a tampering backend; never use it to set up state a check could reach through the app.
- **macOS desktop.** `$H screenshot <id> FILE` captures the `parlor_app` window by its window id, even when other windows cover it. There is no click automation for the WKWebView: drive state through HTTP or MCP and prove the window follows. Window title `Hello`, size 1024x768.
- **iOS simulator.** `$H screenshot <id> FILE` uses `xcrun simctl io <udid> screenshot`. Deep links: `xcrun simctl openurl <udid> 'hello://open/x'` with the udid from `$H info <id>`. There is no tap automation; drive state through HTTP or MCP.

## Fake host

`$H host <id> ...` plays the part of a user's computer running Parlor Host, over the real wire, without an agent. It runs `createFakeHost` from `@parlor/chat/testing` resolved from the instance snapshot (through the snapshot's `tsx`), and does the pairing and the assertion signing itself with WebCrypto (ES256, no dependency), so a check can also craft bad requests. Until the checkout holds phase 3 code, a command that needs the fake host fails with `this snapshot has no @parlor/chat/testing`, and `pair` fails at the consent page because the snapshot serves no host authorize route; `host selfcheck` needs no instance and verifies the signing helpers.

Each paired host (name, user, key pair as JWK, grant id, host id, server origin) is kept in `<instance>/hosts.json` by host name, so later commands name it with `--host NAME`. A fake host always talks to `server.url`, never through Vite.

```sh
$H host <id> pair --as alice --name "Test Mac" [--out DIR] [--no-approve] [--no-exchange] [--timeout S]
$H host <id> exchange --host NAME [--replay | --wrong-key] [--out FILE]
$H host <id> list
$H host <id> assert --host NAME --method POST --url URL [--iat-offset SECONDS] [--jti J]
$H host <id> call --host NAME hostHello|hostClaim|... '<json>' [--out FILE]
$H host <id> request --host NAME --url URL [--method M] [--body JSON] [--auth host|none|"<literal authorization>"] [--assert-url URL] [--iat-offset S] [--jti J] [--header k=v] [--out FILE]
$H host <id> hello --host NAME
$H host <id> online --host NAME [--seconds S]
$H host <id> play --host NAME SCRIPT.json [--out FILE] [--wait-claim SECONDS] [--turns N] [--poll-ms MS]
$H host <id> send --host NAME [--as USER] [--text T] [--thread ID] [--turn ID] [--item ID] [--client-id C] [--out FILE]
$H host <id> stream --host NAME [--out FILE] [--seconds S] [--since V]
$H host <id> seed-thread --host NAME --as alice --turns 100 [--script FILE] [--out FILE]
```

- **pair.** Host-initiated: it makes a key, a PKCE verifier, `state` and a matching code, listens on `127.0.0.1:<free port>/callback`, and prints the authorize URL and the matching code as the first output line. By default it drives the instance browser to the URL (signing in as `--as` when the consent page does not show that account), writes `consent.aria.txt` and `consent.png` into `--out`, clicks `button "Connect"`, exchanges the code at `/hosts/token`, and prints the host summary, the `HostGrantResponse` and a step transcript (`pair-transcript.json` in `--out`). `--no-approve` only prints the URL and waits for the callback (`--timeout`, 120 s), so a check can open the page, click `Connect` or `Cancel` itself. `--no-exchange` stops after the callback and keeps the code, for `exchange`. A denied consent prints `{error: "access_denied", transcript}` and exits 1.
- **exchange.** Without flags it redeems the pending code. `--replay` sends the last exchange again (same code, verifier and proof); the code is single use, so the server must answer 400 `invalid_grant`. `--wrong-key` redeems the pending code with a proof signed by a different key (T3-01). Both print status and body without touching the grant.
- **assert** prints a fresh `ParlorHost <jws>` header value; `--iat-offset -120` backdates it, `--jti` pins the id for a replay, any `--url` or `--method` signs for another request.
- **call** is one host action with a fresh assertion: `request.url` is `<server>/_parlor/chat/actions/<name>`; it prints `{request, startedAt, endedAt, status, headers, body}`. **request** sends any request with a host assertion, with `--assert-url`/`--assert-method` to sign for something else, `--auth none` for no credential, or `--auth "Bearer ..."` for a literal header (a turn token or a user session).
- **hello** runs `hostHello` and prints the welcome; **online** says hello, heartbeats at the welcome's `heartbeatMs`, and on SIGTERM or `--seconds` reports offline.
- **send** sends a prompt as the user (`--as`, default the host's user) to the host's first agent over HTTP, like the sidebar's Send. It prints `{threadId, turnId, itemId, status, body}`; ids are generated unless given.
- **play** says hello, heartbeats, waits for a turn (`--wait-claim`, 60 s), claims it, plays the script, and repeats for `--turns` (or the script's `turns`). Start it in the background before the user sends, `$H host <id> play ... --out FILE &`. SIGTERM writes a final `terminated` event. Exit 1 when any request failed.
- **stream** opens the host's sync stream (`GET /_parlor/sync/stream` with an assertion), records each event and when the stream ends (`endReason`: `server_closed`, `timeout`, `terminated` or `error: ...`), and writes FILE continuously, so a check can revoke the host and read when the stream closed.
- **seed-thread** drives N full turns through the real wire, one at a time: send as the user, claim, play the script (default: a 200 char reply in 50 deltas, a `createTask` tool item, finish), finish. It prints a summary with the median and max turn time. Add `--script` to change the turn.

### Play script

```json
{
  "steps": [
    { "op": "reply", "chars": 400, "deltas": 40, "intervalMs": 50 },
    {
      "op": "tool",
      "title": "Created task",
      "name": "createTask",
      "kind": "app",
      "status": "done"
    },
    { "op": "ask", "question": "Run it?", "as": "a1" },
    { "op": "waitAnswer", "ask": "a1", "timeoutMs": 60000 },
    {
      "op": "mcp",
      "tool": "deleteTask",
      "input": { "id": "x" },
      "headers": { "x-parlor-source": "ui" },
      "as": "forged"
    },
    { "op": "finish" }
  ]
}
```

Item ids are `<turnId>.<n>` unless a step has `id`. Ops:

| op           | Fields (defaults)                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reply`      | `kind` (`reply` or `reasoning`), `text` or `chars` (200), `deltas` (10), `intervalMs` (0, steady from the first delta), `stopOnCancel` (stop streaming as soon as a cancel is seen and append the text sent so far with `interrupted: true`), `holdAfterDelta: {n, ms}`, `persist: false` (stream only, no durable item) |
| `tool`       | `title`, `name`, `kind` (`app` or `local`), `status` (`done`), `detail`, `runningMs` (when set, a `running` tool frame first, then the durable item)                                                                                                                                                                     |
| `ask`        | `question`, `choices` (allow/reject), `approval` (`computer`), `form`, `as` (a label for `waitAnswer`)                                                                                                                                                                                                                   |
| `waitAnswer` | `ask` (label or item id; default the last ask), `timeoutMs` (60000)                                                                                                                                                                                                                                                      |
| `waitCancel` | `timeoutMs` (60000)                                                                                                                                                                                                                                                                                                      |
| `mcp`        | `tool`, `input`, `headers`, `auth` (`turn` sends the claim's turn token as Bearer, `none`), `via` (`server` is `<server>/_parlor/mcp`, `web` the Vite proxy), `wait: false` (do not block the script; joined at finish), `as`                                                                                            |
| `pause`      | `ms`                                                                                                                                                                                                                                                                                                                     |
| `frames`     | raw `frames` (host frames), `repeat`                                                                                                                                                                                                                                                                                     |
| `append`     | raw `items` (host item drafts), `repeat`                                                                                                                                                                                                                                                                                 |
| `finish`     | `outcome` (`{"state":"done","stopReason":"end_turn"}`, `{"state":"cancelled"}`, `{"state":"failed","reason":"agent_exited"}`; default: cancelled when a cancel was seen, else done)                                                                                                                                      |

Top level also takes `agents` (the `hostHello` agent list; default one ready agent `fake`) and `turns`. While a turn plays, `hostSignals` is polled every `--poll-ms` (100) and the token from `hostAppend` replaces the turn token.

### Transcript

`--out FILE` holds `{host, user, server, startedAt, endedAt, script, events}`; every event is `{at, type, ...}` with `at` from `Date.now()`, and per-turn events also carry `turn` (1-based) and `turnId`:

- `hello` (`status`, `welcome`), `heartbeat` (`status`), `claim_wait`, `claim` (`turn` is the whole `ClaimedTurn`, token included), `claim_timeout`, `claim_error`.
- `stream` (`status`, `frames`: `{type, itemId, kind, offset, chars, status}` per frame), `append` (`status`, `items`: `{id, kind, toolStatus, interrupted, chars}`, `leaseUntil`).
- `signals` (`seen`: the signal items of that poll), `cancel_seen` and `answer_seen` (first time seen, with the item id), `wait`, `pause`.
- `mcp_start`, `mcp_result` (`startedAt`, `ms`, `isError`, `result`), `finish` (`outcome`, `status`), `error`, `terminated`.

Reading a thread afterwards: `$H host <id> call --host NAME` only reaches host actions; the user view is `POST /_parlor/chat/actions/open` or `items` with `$H token <id> --as alice`, or the thread log in the page (see `features/chat.md`).

## Real host (Parlor Host)

`$H host` plays a computer without an agent. To run the real `parlor-host` with Claude Code and Codex, give it an isolated HOME so the developer's own `~/.parlor` is never touched:

```sh
$H agent-home HOME                    # creates HOME, prints whether claude and codex are logged in under it
$H parlor-host ID HOME connect URL    # the unpublished host CLI from instance ID's snapshot, as parlor-host, with HOME=HOME
$H up --no-auth --home HOME           # hello without auth under plain parlor dev; the dev host it spawns runs in HOME
```

- `agent-home` creates an empty `HOME/.parlor`, links `HOME/.codex/auth.json` to the developer's Codex file login and `HOME/Library/Keychains` to the login Keychain (Claude Code keeps its login there, and macOS finds that Keychain under `$HOME/Library/Keychains`), and writes `HOME/bin/open`, a shim that appends the URL it is given to `HOME/opened-urls.log` instead of opening a browser. The host's own Keychain items (service `dev.parlor.host`, account the app origin) land in the developer's login Keychain: delete them with `security delete-generic-password -s dev.parlor.host -a ORIGIN`.
- Everything the isolated host starts gets `HOME`, the shim first on `PATH`, and no inherited `CLAUDE*`, `ANTHROPIC_*`, `CODEX_*` or `OPENAI_*` variable.
- Keep HOME short, such as `~/.cache/parlor-verify-hello/h/<id>`: the control socket path under it must stay below 104 bytes.
- `up --no-auth` rewrites `server.ts` in the snapshot, removing the `auth` option and the imports only it used, and is refused without `--home`. The instance has no users: `signin`, `token`, `mcp` and `doctor` do not apply to it.
- `scripts/phase5-kit.mjs` extends it for the phase 5 scripts: `presence` and `profileBrowser` (WebAuthn presence before sign-in), `sqlWrite`, `openThread`, and the host's local dialogs (`dialogProcesses` finds the `osascript` processes the host of a HOME started, `readDialog`, `clickDialog` and `screenshotDialog` act on one by pid through System Events, `answerDeviceDialog` and `sendApproving` answer a device approval).
- **Dialog lock.** Local dialogs belong to the whole machine, so scripts running at once must not read or click each other's. `withDialogLock(fn)` (`scripts/dialog-lock.mjs`, re-exported by the phase 5 kit) takes an exclusive lock on `~/.cache/parlor-verify-hello/dialog.lock` for the span of `fn`. It is a file created with its owner's pid: a holder that died is taken over, and it is re-entrant inside `fn` and exclusive between the async tasks of one script. Waiting is bounded at 120 s, then it throws, naming the holder. `readDialog`, `clickDialog`, `screenshotDialog`, `waitDialog` (one look per poll, so a waiting script blocks nobody), `answerDeviceDialog` (find, screenshot and click in one hold), `watchDialogs` (one scan per poll) and the dialog step of `sendApproving` all take it, so a script that touches a dialog by `osascript` itself wraps the find-and-act in `withDialogLock` too. Keep the span to "find my dialog, act on it": never hold it across a prompt send, a settle wait or a sleep.
- **Attacker send.** `attackerSend(info, { deviceId, privateKey, publicJwk, threadId, agent, text, user = "alice" })` plays a backend that holds `user`'s session and sends a prompt for `deviceId` signed with a key the check holds, such as one it swapped into `parlor_auth_devices.signing_key` with `sqlWrite`. It builds the prompt statement (`v`, `kind: "prompt"`, `app` the web URL, `threadId`, a fresh `turnId`, `agent` as `hostId/agentId`, `digest` the base64url SHA-256 of the text, `at`), signs its canonical bytes (keys sorted at every level, no whitespace) with ES256 as raw `r||s`, sets `keyId` to the base64url SHA-256 of `{crv,kty,x,y}` of `publicJwk`, and posts `/_parlor/chat/actions/send` with `user`'s session token. `agent` is the `{hostId, agentId}` of the thread's agent, as a prompt item carries it in `body.agent`. It returns `{statement, body, status, response}`; save it as evidence. Attacker prompts go through this helper, not through hand-built requests. `signPromptStatement`, `signingKeyId` and `canonicalJson` are exported for checks that need to forge a variant.
- `scripts/phase4-kit.mjs` is the library of the phase 4 check scripts: instance and host lifecycle, the pty terminal (`Terminal`), the consent flow (`connectHost`), the browser helpers (`Browser`, in-page helpers for the sidebar), the proxy client and the cleanup that removes homes, Keychain items and leftover processes.

### Agent tiers

A check that runs an agent through the real host says in its plan which agent it needs:

- `Agent: fake` runs once with the fake ACP agent of `packages/agent-host` (`bin/fake-agent.mjs`, `FakeAgentScript` in `src/testing/fake-agent.ts`). Use it for everything the host, the server, the wire and the UI decide: streaming, tool and permission items, cancel, app calls through the MCP proxy, plans, an agent that exits. A prompt names its step list by its whole text or its last line; steps are `reply`, `thought`, `tool` (with or without `askPermission`), `call_app` (an app tool through the MCP server the host passed in `session/new`; the host allows app tools without asking), `plan`, `wait_for_cancel`, `exit` and `stop`.
- `Agent: real` runs with Claude Code and with Codex, only when the predicate depends on what a real adapter does: whether it reads a plain request and picks the right tool, how it phrases a permission ask, its own session or resume behavior.

Both go through `forEachAgentOnOneHost(check, options, body)`: one instance with Alice signed in, one pairing, then `body(agent, session)` for each agent in turn on that instance and host. Before each run after the first it clicks `New chat`, and before every run it picks `{agent} on {hostName}` in the picker, so each run starts in its own thread. The runs share one database: give each run its own rows, such as a title with the agent's name, never a row another run also reads or changes. Keep `forEachAgent` (one instance per agent) for checks whose runs cannot share a database. Measured on hello: the fake tier took 49 s end to end (35 s to start, sign in and pair, 7 s for the turn); both real agents on one host took 103 s (35 s setup once, 29 s Claude Code, 27 s Codex).

```js
const script = {
  steps: {
    "add tier task": [
      { kind: "call_app", tool: "createTask", input: { title: "Tier check" } },
      { kind: "reply", chunks: ["Added it."] },
      { kind: "stop", reason: "end_turn" },
    ],
  },
};
await forEachAgentOnOneHost(
  check,
  { tag: "c9", fake: { script, log: true } },
  async (agent, s) => {
    await s.browser.send("add tier task");
    await s.browser.waitSettled({ prompts: 1, ms: 30_000 });
    check.expect(
      "the agent got the prompt",
      agent.messages().some((m) => m.method === "session/prompt"),
    );
  },
);

await forEachAgentOnOneHost(check, { tag: "c4" }, async (agent, s) => {
  await s.browser.send(`add a task called Tier check ${agent.name}`);
  await s.browser.waitSettled({ prompts: 1, ms: 180_000 });
});
```

`options` are `tag`, `agents` (default `selectedAgents()`, so `P4_AGENTS=claude` narrows a run), `seed`, `extraEnv` and `fake`; with `fake` (`{ script, log }`) the fake agent runs alone. Underneath, `addFakeAgent(check, session, { script, log })` writes the script to the check dir and the `Fake agent` profile (absolute `node` and entry paths, from the instance snapshot) to the isolated HOME's `~/.parlor/host/agents.json` through `writeAgentProfiles`, sets `FAKE_AGENT_LOG` on the host when `log` is given (true, or a file name in the check dir), and returns `{id: "fake", name: "Fake agent", profile, scriptFile, logFile, env, messages}`, shaped like the entries of `AGENTS`. Call it after `standUp` and before `connectHost`, or pass `fake` to `connectedSession`, which returns it as `fake`.

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

- `scripts/hello.mjs` is the whole control CLI: `up`, `doctor`, `seed`, `sql`, `stop`, `start`, `sync`, `browser`, `mcp`, `agent`, `host`, `screenshot`, `info`, `list`, `reap`, `down`, `evidence`. `$H --help` prints usage, datasets, and the home dir.
- `scripts/presence-holder.mjs` holds the virtual authenticators of `browser <id> presence` (see Drive).
- `scripts/host.mjs` is the `host` command family (the fake computer); `$H host selfcheck` verifies its signing helpers without an instance.
- `fixtures/*.sql` are the datasets.
- `features/` is the feature map. Keep it current with the **maintain-verification-skill** skill.
