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

TanStack Query's `useQuery` and `useMutation` over actions. Queries refetch when any caller runs an action that writes what they read. See [Pages and hooks](/guides/pages-and-hooks/).

```ts
import { FrameworkProvider } from "@parlor/client/react";
//       ^?
```

Wraps the app: `client` (the action client), `router` (the TanStack router) and, with sign-in, `auth` (the auth client from `@parlor/auth/client`).

## Sessions and capabilities

- `useSession()`: `{ status: "loading" | "signed-in" | "signed-out" | "anonymous", user? }`.
- `useCapability(definition)`: resolves a capability from `@parlor/capabilities` on the current platform; `{ available: true, api }` or `{ available: false, reason }`.
- `useActionClient()`: the client from the provider.

## Agents

- `useAgentView(view, { get })`: exposes a view to the agent while its element is on screen; attach the returned `ref`.
- `useAgentConfirmations()`: the agent calls waiting for the user's approval.
- `useAgentActivity()`: what the agent is doing in the app right now.
- `useChat()`: the sidebar's state and commands; `status` is `"unavailable"` when the server has no chat.
- `useChat().link` and `startLink()`: whether this device may send (`linked`, `checking`, or `unlinked` with the `code` and the `qr` URL it shows once `startLink` made one). Send stays disabled until it is linked. The `qr` URL is `<app>/link#d=<device>&c=<commitment>`; the fragment never reaches a server.
- `useLinkDevice()`: for **Link a device** on a linked device: `check(code)` finds the device and checks its keys against the code (or `check({ deviceId, commitment })`, from a scanned QR, against the whole commitment), `confirm()` vouches for it with Face ID or Touch ID; a device without a passkey gets the `parlor-host link` command instead.
- `useDevices()`: the account's `devices` (read again whenever one is added, linked or removed), the ones another device `linked` while the page was open for a notice (`dismiss(id)` hides one), and `remove(id)`, which confirms with Face ID or Touch ID and answers whether it removed the device. `removal` says what removing is doing; a device without a passkey gets the `parlor-host devices --remove` command instead.
- `useDeviceSetup()`: deprecated; the link card replaces it. For a card that explains setting up a browser. While it is mounted, the first prompt on a browser that would create a passkey waits in `setup` until the user calls `setUpDevice({ passkey })` or `dismissSetup()`. Without it, the first prompt opens the browser's passkey prompt directly.

## Chat primitives

Unstyled components the template's sidebar is built from, under the `Chat` namespace: `Chat.Root`, `Chat.Thread`, `Chat.Confirmations`, `Chat.Composer`, `Chat.Input`, `Chat.Send`, `Chat.Stop`, `Chat.Status`, `Chat.Ask`, `Chat.AskForm` and `Chat.AskChoice`. See [The agent sidebar](/guides/agent-sidebar/).
