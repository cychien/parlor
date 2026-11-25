# Live sync from an external writer

When anything else writes tasks (an HTTP client, an MCP agent, another browser window), every open page updates its list within a moment, without a reload. The page holds an SSE stream to `/_parlor/sync/stream` and refetches what a write invalidated.

## Sub-features

- `sync-http` shows a task created over HTTP.
- `sync-mcp` shows a task created by an MCP agent.
- `sync-window` shows a toggle made in a second browser window.

## How to get to it (user POV)

- Keep the app open while another client writes; the user does nothing.

## Driving it with hello.mjs

Preconditions:

- An instance seeded with `baseline`, doctor clean, page open and showing the three tasks.
- `$H doctor <id>` reports `sync: transport sse`.

- **HTTP writer.** Run `curl -s -X POST localhost:<server>/_parlor/actions/createTask -H 'content-type: application/json' -H "authorization: Bearer $($H token <id>)" -H 'x-parlor-client: verify' -d '{"title":"Written over HTTP"}'`, then `$H browser <id> wait "Written over HTTP"`. The wait succeeds without any `open` or reload in between.
- **MCP writer.** Run `$H agent <id> --out $E/agent "Create a task titled 'Added by Claude' with the hello tools."`, then `$H browser <id> wait "Added by Claude"`.
- **Second window.** Run `$H browser <id> newpage <web>/`, click `checkbox "Call Amy"` there, then `$H browser <id> selectpage <first page id>` (ids from `$H browser <id> pages`) and confirm `checkbox "Call Amy" checked` in a snapshot.
- **Proof.** Save the curl response, the agent summary, and an ARIA snapshot plus screenshot after each wait.

## Gotchas

- A seed writes no sync event. After `$H seed`, reopen the page; do not expect it to update by itself.
- A page that loaded before a restart (`seed`, `sql`, `stop`/`start`) reconnects its stream, but reopen it anyway before starting a sync check so the starting state is known.
- `PARLOR_SYNC_TRANSPORT=poll` in the environment switches to polling every two seconds; the checks still pass but slower. Doctor prints the transport in use.
