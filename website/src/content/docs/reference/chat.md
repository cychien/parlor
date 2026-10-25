---
title: "@parlor/chat"
description: The server half of the agent sidebar.
---

```sh
pnpm add @parlor/chat
```

```ts
import { chat } from "@parlor/chat/server";
//       ^?
```

Install it as a plugin: `createServer({ actions, database, plugins: [chat()] })`. It adds the chat's tables, actions and routes: threads, prompts, the agents' replies and their approvals, and the channel that streams them to the page.

Chat needs an auth provider that can mint turn tokens. In development `parlor dev` installs one. In production, add sign-in with `parlor add auth`; without it the server still starts, chat serves nothing, and the client reports `useChat().status` as `"unavailable"`.

## Who may use the agent

`chat({ access })` decides who may use the agent at all. Without it, everyone signed in may. The function gets the user whose chat it is, the principal asking (that user, or a computer working for them), the scope and the `database`, and may be async:

```ts
import type { DataProvider, UserId } from "@parlor/core";
declare function isAdmin(database: DataProvider, userId: UserId): Promise<boolean>;
// ---cut---
import { chat } from "@parlor/chat/server";

chat({
  access: async ({ userId, database }) => isAdmin(database, userId),
});
```

The server enforces it on everything chat serves, not only in the UI:

- every chat action, so a refused user can neither read threads nor send a prompt;
- the computer's routes and actions, so a refused user's computer takes no turns and gets no turn tokens, even one paired before;
- the `chat` channel, which a refused user's stream never joins;
- with `@parlor/auth`, pairing a computer and enrolling or linking a device, the pieces that only exist for chat. Listing and removing what the user already has stays open.

A refused call answers `forbidden`, and `useChat()` reports it as `status: "unavailable"` with `unavailable.reason` `"forbidden"`, so the app can hide the agent. External agents connected over MCP are not affected: they call the app's actions as the user, and each action's own checks decide. In development without sign-in, `userId` is `DEV_USER_ID`.

`access` is the chat's `allows` hook from the plugin contract; another plugin asks it through `PluginHost.allows("chat", caller)`. See [`@parlor/server`](/parlor/reference/server/#for-plugin-authors).

The client side is in [`@parlor/client/react`](/parlor/reference/client-react/). `@parlor/chat` holds the shared types (`AgentRef`, `ThreadSummary`, `ChatItemBody`) and `@parlor/chat/testing` a fake host for tests.
