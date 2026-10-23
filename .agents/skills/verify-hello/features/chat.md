# Chat sidebar

Alice connects a computer to her account, opens the Agent sidebar in the app header, sends a prompt, and watches the agent's reply stream into the thread, tool calls and questions included. Her threads, computers and the live stream belong to her alone; Bob sees none of it. No real agent runs here; a scripted fake computer (`$H host`) plays one over the real wire.

## Sub-features

- `chat-pair` connects a computer: the consent page as the one approval, the grant, and `/settings` listing it.
- `chat-send` sends a prompt from the composer and shows the reply growing, a tool item, and the finished turn.
- `chat-reload` reloads the tab mid-stream without losing or duplicating an item.
- `chat-cancel` stops a running turn from `button "Stop"` and keeps the text already streamed.
- `chat-ask` answers an agent's question in the thread.
- `chat-isolation` keeps Bob away from Alice's threads, computers and stream.
- `chat-revoke` revokes a computer from `/settings` and closes its link.
- `chat-errors` shows why a send, stop or answer failed (for example `<host> is offline.`) in a red line above the composer, cleared by the next one that works.

## How to get to it (user POV)

- Sign in, press `button "Agent"` in the app header: the sidebar (region `Agent`) opens with the computer picker (`combobox "Agent"`, one option per connected computer's agent, `<agent> on <host name>`), the thread log (`ol[role=log]`), `textbox "Message"` and `button "Send"`; with no computer online it shows `No computer connected` and a disabled composer. A running turn adds `button "Stop"` and the note `Working...`; a queued prompt's meta line reads `Queued`, and while its computer is offline the status line (`p.composer-status[role=status]`) reads `Waiting for {host name} to come online`.
- Escape closes the sidebar and returns focus to `button "Agent"`; answering a card returns focus to `textbox "Message"`.
- Connect a computer from the app's consent page (`Connect a computer`, with `button "Connect"` and `button "Cancel"`); it then shows under "Connected computers" on `/settings` with `button "Revoke <host name>"`.

## Driving it with hello.mjs

Preconditions: an instance with phase 3 code (`$H up --seed baseline`, `$H doctor <id>` clean), the tab signed in (`$H browser <id> signin`), `$H browser <id> emulate --viewport 1280x720x1`. Evidence goes under `$E` (see SKILL.md).

- **Pair.** `$H host <id> pair --as alice --name "Fake host" --out $E/pair` drives the consent page itself and prints the exchange. To click it by hand instead: `$H host <id> pair --as alice --name "Fake host" --no-approve > $E/pair.out &`, read the authorize URL and matching code from the first line, `$H browser <id> open <authorizeUrl>`, snapshot, `click button "Connect"`, then read the grant from `$E/pair.out`. `$H host <id> list` shows the host and its grant id.
- **Open and send.** `$H browser <id> open /`, `click button "Agent"` (the sidebar is closed after every load), `fill textbox "Message" "write a long reply"`, `click button "Send"`. Start the fake host's turn before sending: `$H host <id> play --host "Fake host" c6.script.json --out $E/play.json &` (script format in SKILL.md, "Fake host"). Without a script the turn waits for a claim and the thread shows it queued.
- **Read the thread.** The log is an ordered list; each `li` has `data-item-id`, `data-kind` (`prompt`, `reply`, `reasoning`, `tool`, `plan`, `ask`, `confirm`, `event`) and, for replies, `data-streaming` and `data-interrupted`. Dump it with `$H browser <id> eval "() => [...document.querySelectorAll('ol[role=log] > li')].map(li => ({ id: li.dataset.itemId, kind: li.dataset.kind, streaming: li.dataset.streaming, interrupted: li.dataset.interrupted, text: li.textContent }))"` and compare with the items of `$E/play.json` by id (`<turnId>.<n>`). The server's view of the same thread: `T=$($H token <id>)`, `POST /_parlor/chat/actions/open` with `{}` and `items` with `{"threadId","afterSeq":0}`.
- **Reload mid-stream.** Wait for the 20th delta in the transcript (`jq '[.events[]|select(.type=="stream")]|length' $E/play.json`), `$H browser <id> open /`, `click button "Agent"`, then sample the reply's `data-streaming` every 100 ms with one `eval` that records `Date.now()` and the text length.
- **Cancel.** Play `{"steps":[{"op":"reply","chars":400,"deltas":40,"intervalMs":50,"stopOnCancel":true},{"op":"finish"}]}`, click `button "Stop"` mid-stream, and read `cancel_seen` and the `finish` outcome (`cancelled`) in the transcript; the reply `li` has `data-interrupted="true"` and keeps its text.
- **Ask.** Play an `ask` then `waitAnswer`; the `li` with `data-kind="ask"` shows its choices as buttons; click one and read `answer_seen` in the transcript.
- **Bob.** `$H host <id> pair --as bob --name "Bob host"` signs the tab in as Bob when needed (it restarts nothing else). Call Alice's thread ids with `$H token <id> --as bob`.
- **Crafted requests.** `$H host <id> call`, `request`, `assert` and `exchange --replay|--wrong-key` send what a hostile or broken computer would (replayed or stale assertions, a turn token as the host credential); see SKILL.md.
- **Revoke.** Keep a stream open with `$H host <id> stream --host "Fake host" --out $E/stream.json &`, `click button "Revoke Fake host"` on `/settings`, and read `endedAt` and `endReason` from `$E/stream.json` against the click time.
- **Long thread.** `$H host <id> seed-thread --host "Fake host" --as alice --turns 100 --out $E/seed.json` writes 100 full turns through the wire.

## Gotchas

- `host` talks to `server.url`, never the Vite proxy; assertions are bound to the app's public origin (the web origin) plus the request's path, as a host behind a proxy signs them, so `host` rewrites a `server.url` URL to the web origin when it signs. The pair URL uses the web origin, because the browser reaches the consent page through Vite.
- Each assertion lives 60 s and is single use: mint one per request with `assert`, never reuse the printed value for a second call.
- `seed`, `sql`, `stop` and `start` restart the instance's Chrome with a fresh profile (sign in again) and the server, which forgets live turns; start a new `play` afterwards and check `host list` against the connected computers on `/settings`.
- `play` waits for a turn at the moment it starts, so start it before sending, or send first and start within the `--wait-claim` window (60 s).
- `chat-pair` needs the browser signed in as `--as`; `pair` signs in when the consent page does not show that account, which replaces the tab's session.
- A `li`'s `textContent` includes its meta line (`Stopped` under a stopped prompt, `Interrupted` under a cut-off reply); read the text from `.reply` or `.prompt` inside it. A tool item's title is `.tool-title`.
- A reply's `data-streaming` is only observable while the host holds deltas back; script `intervalMs` or `holdAfterDelta` when a check needs to see it.
