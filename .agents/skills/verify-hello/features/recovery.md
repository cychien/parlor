# Recovery: server restart and back-forward cache

An open tab stays reachable for an external agent across two events that interrupt its connection. When the app server restarts, the tab's sync stream drops, the stream watchdog and reconnect bring it back, and `ui_screen` finds the same client again without a reload. When the user navigates the tab to another origin and back, the tab leaves while away and is reachable again at once on return, with the same client id.

## Sub-features

- `recover-restart` finds the tab again with `ui_screen`, under the same client id and without a reload, within about 30 s of the server dying.
- `recover-away` lists no client while the tab is on another origin: `ui_screen` and `ui_navigate` answer `reachable: false` with reason `no_client`.
- `recover-bfcache` finds the same client id at once after going back, with the page's own state intact.

## How to get to it (user POV)

- Leave the app open while the server restarts (a redeploy, a crash and relaunch), and keep working in the tab.
- Follow a link out of the app to another site, then press the browser's Back button.

## Driving it with hello.mjs

Preconditions:

- A web instance seeded with `baseline`, doctor clean, a page opened with `$H browser <id> open /`, and `$H browser <id> emulate --viewport 1280x720x1`.
- `$E` is the evidence directory. `jq` is on PATH.
- Set up a helper that prints the connected client's id, or `none`:

  ```sh
  cid() { $H mcp <id> call ui_screen '{}' 2>&1 | jq -r '.content[0].text | fromjson | .client.id // "none"' 2>/dev/null; }
  ```

- Mark the page so a reload is detectable: `$H browser <id> eval "() => { window.__kept = 1; return performance.timeOrigin }"` and note the number.

- **Restart.** `$H stop` and `$H start` also kill the instance's browser, so they cannot be used with a tab open. Kill only the app server and start it again by hand; Vite keeps running, so the page is not reloaded by the dev server.

  ```sh
  INFO=$($H info <id>); APP=$(echo "$INFO" | jq -r .appDir); REPO=${APP%/examples/hello}
  S=$(echo "$INFO" | jq -r .urls.server | sed 's/.*://'); W=$(echo "$INFO" | jq -r .urls.web | sed 's/.*://')
  echo "before: $(cid)"                                   # a client id
  P=$(lsof -tiTCP:$S -sTCP:LISTEN); kill -KILL $(ps -o ppid= -p $P) $P; DEAD=$(date +%s)
  sleep 5
  (cd $APP && PORT=$S PARLOR_WEB_ORIGIN=http://localhost:$W nohup node $REPO/node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs watch $REPO/packages/cli/src/serve-entry.ts $APP/server.ts >> $(echo "$INFO" | jq -r .log) 2>&1 < /dev/null &)
  until case "$(cid)" in *-*-*-*-*) true;; *) false;; esac; do sleep 2; [ $(( $(date +%s) - DEAD )) -gt 60 ] && break; done
  echo "back after $(( $(date +%s) - DEAD )) s: $(cid)"
  ```

  The id printed at the end equals the id before, and the elapsed time is about 30 s (measured: 26 and 27 s in two runs, with the server back up after 5 s; the stream liveness window is 25 s). While it waits, `cid` prints `none` or nothing because the server is not answering. Then `$H browser <id> eval "() => [window.__kept, performance.timeOrigin]"` is `[1, <the number from before>]`: no reload happened. `$H mcp <id> call ui_navigate '{"to":"/settings"}'` now moves the tab.

- **Away and back.** Navigate the same tab to another origin with `eval`, because `$H browser <id> open` always prefixes the instance's web URL: `$H browser <id> eval "() => { location.href = 'http://127.0.0.1:<web port>/robots.txt'; return 1 }"`. `127.0.0.1` is a different origin from `localhost`. After a second, `$H mcp <id> call ui_screen '{}'` returns `{"reachable": false, "reason": "no_client"}` and `ui_navigate '{"to":"/settings"}'` returns the same with an `href` on the web port. Run `$H browser <id> back`, then at once `cid` prints the id from before, and `$H browser <id> eval "() => [location.href, window.__kept]"` is `["http://localhost:<web port>/", 1]`. `ui_navigate` to `/settings` now answers with the screen of `/settings` and the tab shows Settings.

- **Proof.** Save the `cid` outputs with their timestamps, the `__kept` and `timeOrigin` readings before and after, the `no_client` answer while away, and an ARIA snapshot after each step.

## Gotchas

- `$H sync`, `$H seed`, `$H sql`, `$H stop` and `$H start` restart or kill more than the app server: Vite reloads the page after a `sync`, and `stop` removes the instance's browser. Use them for state, not for this recipe.
- Killing only the server process leaves `tsx watch` unable to start a new one; kill both the listener and its parent, as above, then start `tsx watch` again. Edits to `server.ts` do not revive a killed one.
- `__kept` is `undefined` after the return when the browser did not restore the page from the back-forward cache and reloaded it instead. That is a different path: the tab then joins with a new client id. Re-run, or report it as not verified rather than as a pass.
- The mac and iOS shells are not covered here: there is no way to navigate their webview to another origin from the harness.
- `ui_screen` without a connected tab answers `no_client` right away, so a wait that never ends points at a tab that did not come back, not a slow call.
- The manually started server runs under the instance directory, so `$H down` kills it with the rest.
