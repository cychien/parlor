---
title: "@parlor/client/react"
description: FrameworkProvider, the action hooks, sessions, capabilities and the chat primitives.
---

```ts
import { useActionQuery } from "@parlor/client/react";
//       ^?
```

```ts
import { useActionMutation } from "@parlor/client/react";
//       ^?
```

TanStack Query's `useQuery` and `useMutation` over actions. Queries refetch when any caller runs an action that writes what they read, and their data counts as fresh until then, unless the `QueryClient` sets a `staleTime` default or the hook is given one. See [Pages and hooks](/parlor/guides/pages-and-hooks/).

```ts
import { useActionSuspenseQuery } from "@parlor/client/react";
//       ^?
```

`useActionQuery` as a `useSuspenseQuery`: `data` is always set. It suspends until the action answers, unless a route loader already ensured the data.

```ts
import { ensureActionQueryData } from "@parlor/client/react";
//       ^?
```

For route loaders: the action's cached data, fetched first when there is none or a write it reads has made it out of date. `context` is the router context `createParlorRouter` gives every loader, `{ client, queryClient }`. The data lands in the entry `useActionQuery` and `useActionSuspenseQuery` read, with its read tags, so it stays fresh like theirs. Rejects with the action's `ActionError`. See [Load a page's data in its loader](/parlor/guides/pages-and-hooks/#load-a-pages-data-in-its-loader).

```ts
import { actionQueryOptions } from "@parlor/client/react";
//       ^?
```

The query behind the hooks and `ensureActionQueryData`, for `queryClient.prefetchQuery`, `useQueries` and the like. Its data stays fresh until a write invalidates it, unless the `QueryClient` sets a `staleTime` default.

```ts
import { FrameworkProvider } from "@parlor/client/react";
//       ^?
```

Wraps the app: `client` (the action client), `router` (the TanStack router) and, with sign-in, `auth` (the auth client from `@parlor/auth/client`). It uses `queryClient` when given, else the router's `context.queryClient`, else a new one. When the signed-in user changes, it clears cached queries and runs the router's loaders again. With `auth`, live updates run only while someone is signed in, or while the server signs nobody in (`anonymous`): a signed-out visitor never opens a sync connection, and one the server refuses waits for the session to change instead of retrying.

## Sessions and capabilities

- `useSession()`: `{ status: "loading" | "signed-in" | "signed-out" | "anonymous", user? }`.
- `useCapability(definition)`: resolves a capability from `@parlor/capabilities` on the current platform; `{ available: true, api }` or `{ available: false, reason }`.
- `useActionClient()`: the client from the provider.

## Agents

- `useAgentView(view, { get })`: exposes a view to the agent while its element is on screen; attach the returned `ref`.
- `useAgentConfirmations()`: the agent calls waiting for the user's approval.
- `useAgentActivity()`: what the agent is doing in the app right now.
- `useChat()`: the sidebar's state and commands; `status` is `"unavailable"` when the server has no chat or will not serve this user, and `unavailable.reason` says which: `"forbidden"` when `chat({ access })` refuses the user, `"not_found"` when the server has no chat, `"unauthenticated"`, or `"error"` while a failed read is retried. `Chat.Status` carries it as `data-unavailable`.
- `useChat().link` and `startLink()`: whether this device may send (`linked`, `checking`, or `unlinked`). Send stays disabled until it is linked. Once `startLink` made a code, `unlinked` carries the `code`, the `qr` URL a linked phone's camera opens (`<app>/link#d=<device>&c=<commitment>`; the fragment never reaches a server, so render it with any QR library), and the `command` that links it on the computer instead. When the code runs out it is dropped and `expired` is true until the next `startLink`. `onlyComputer` is true while no other device is linked, so only `command` can link this one.
- `useChat().hasOlder` and `loadOlder()`: the thread has items before the first one shown, and reads the next earlier page; `moreThreads` and `loadMoreThreads()` do the same for the conversation list past its first 200. `loadingOlder` is set while either reads.
- `useChat().presenceDue`: the chosen agent's computer wants this device to confirm it is the user again (every 18 hours by default), so the next send asks for Face ID or Touch ID first; `Chat.Status` says so. A cancelled check leaves the draft and sets `error`.
- `useLinkDevice()`: for **Link a device** on a linked device: `check(code)` finds the device and checks its keys against the code (or `check({ deviceId, commitment })`, from a scanned QR, against the whole commitment), `confirm()` vouches for it with Face ID or Touch ID; a device without a passkey gets the `parlor-host link` command instead.
- `useDevices()`: the account's `devices` (read again whenever one is added, linked or removed), the ones another device `linked` while the page was open for a notice (`dismiss(id)` hides one), and `remove(id)`, which confirms with Face ID or Touch ID and answers whether it removed the device. `removal` says what removing is doing; a device without a passkey gets the `parlor-host devices --remove` command instead.
- `useDeviceSetup()`: deprecated; the link card replaces it. For a card that explains setting up a browser. While it is mounted, the first prompt on a browser that would create a passkey waits in `setup` until the user calls `setUpDevice({ passkey })` or `dismissSetup()`. Without it, the first prompt opens the browser's passkey prompt directly.

## Chat primitives

Unstyled components the template's sidebar is built from, under the `Chat` namespace: `Chat.Root`, `Chat.Thread`, `Chat.LoadOlder`, `Chat.Confirmations`, `Chat.Composer`, `Chat.Input`, `Chat.Send`, `Chat.Stop`, `Chat.Status`, `Chat.Ask`, `Chat.AskForm` and `Chat.AskChoice`. A thread first shows its last 200 items; `Chat.Thread`'s `older` row, such as `<Chat.LoadOlder />`, appears while earlier ones remain, and reading them keeps the user's place. See [The agent sidebar](/parlor/guides/agent-sidebar/).
