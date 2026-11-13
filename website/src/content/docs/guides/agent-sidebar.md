---
title: The agent sidebar
description: How the sidebar reaches the coding agents on your computer, and how to change it.
---

A new app has an **Agent** button in its header. It opens a sidebar where you chat with a coding agent installed on your own computer, Claude Code or Codex, and that agent operates the app through its actions.

## How it connects

- In development, `parlor dev` starts **Parlor Host** beside the server. It finds the agents installed on this computer and offers them to the sidebar. There is nothing to sign in to or pair.
- The agent runs on your computer, with your own subscription. When it calls an app tool, the call goes to the app's actions under your scope, and any `confirm: true` action waits for you in the sidebar.
- The page tells the agent where you are: the current route's `staticData.description` and the views on screen (see below), so a prompt such as "check off the first one" has a referent.

After `parlor add auth`, each user connects their own computer instead: the sidebar shows a command such as `npx @parlor/agent-host connect http://localhost:5173`, which pairs that computer with the signed-in account. See [Auth](/parlor/guides/auth/).

In a production build without sign-in, chat is unavailable: `useChat().status` is `"unavailable"`, and the template's sidebar says so. `parlor build` warns about it.

## Who may use it

By default everyone signed in may use the agent. To limit it, for example to admins, pass `access` to `chat()` in `server.ts`:

```ts
import type { UserId } from "@parlor/core";
declare function findUser(userId: UserId): Promise<{ role: string } | undefined>;
// ---cut---
import { chat } from "@parlor/chat/server";

chat({
  access: async ({ userId }) => (await findUser(userId))?.role === "admin",
});
```

The server then refuses everyone else on every chat surface: reading and sending, their computers taking turns, and pairing a computer or a device in the first place. Hiding the button is not what keeps them out. In the client, `useChat().unavailable?.reason` is `"forbidden"` for a refused user, so the UI can hide the agent; the template's sidebar shows a short note instead. Agents connected over MCP are unaffected, because they call the app's actions as the user. See [`@parlor/chat`](/parlor/reference/chat/#who-may-use-the-agent).

## The files are yours

The sidebar is ordinary code in your project, copied in when the app was created:

| File                              | What it is                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/agent-button.tsx`      | The header button, the sidebar panel, Escape handling, the pending-approval badge                                                             |
| `src/agent/agent-sidebar.tsx`     | The chat: agent picker, conversations, approvals, messages, composer, and the card that explains the passkey before a browser's first message |
| `src/agent/confirmation-card.tsx` | The card that asks you to approve an action                                                                                                   |
| `src/agent/views.ts`              | The `agentPanel` view the agent can read                                                                                                      |
| `src/header-actions.tsx`          | Where the button is mounted                                                                                                                   |

It is built from the unstyled primitives in `@parlor/client/react` (`Chat.Root`, `Chat.Thread`, `Chat.Composer`, `Chat.Confirmations` and friends) and styled with Tailwind. Change the markup, the classes or the copy freely; `parlor add agent` puts it back on a project that removed it.

## Views: what the agent can see

A view describes a piece of UI to the agent. Define it with a schema:

```ts
import { defineAgentView } from "@parlor/client";
import * as z from "zod/mini";

export const notePanel = defineAgentView({
  name: "notePanel",
  description: "The note being edited. Read-only.",
  schema: z.object({ title: z.string(), words: z.number() }),
});
```

Then bind it where the UI renders, with `useAgentView(view, { get })`, and attach the returned `ref` to the element. While the element is on screen, the agent reads its current value. List the views a route shows in its `staticData.views`.

Two options make a view more than something to read. `keyed: true` is for a list's rows: bind each row with `key` set to the id your actions take, and "delete this one" resolves to that id. `writable: true` with a `set` in the binding lets the agent fill a form for the user, who submits it. The template's todo page does both, with a `todo` view per row and a `newTodo` view on the New todo field; start from it.

## Showing UI in the chat

The agent can answer with more than text: a chart, a few key numbers, a comparison, built from components you define. Give `chat()` a catalog:

```ts
// chat-ui.ts
import { defineChatUi } from "@parlor/chat";
import { z } from "zod";

export const chatUi = defineChatUi({
  Card: {
    description: "A titled group of other elements, such as a few stats side by side.",
    props: z.object({ title: z.string() }),
    children: true,
  },
  Stat: {
    description: "One number with its label.",
    props: z.object({ label: z.string(), value: z.number() }),
  },
});
```

```ts
import type { ChatUiCatalog } from "@parlor/chat";
declare const chatUi: ChatUiCatalog;
// ---cut---
// server.ts
import { chat } from "@parlor/chat/server";

chat({ ui: chatUi });
```

The agent then has a `chat_show` tool, listed only while it answers a chat turn, whose description holds the catalog: each component's description and its props as a JSON schema. It builds a flat tree the way [json-render](https://github.com/vercel-labs/json-render) does, `{ root, elements }`, every element `{ type, props, children? }`. The server checks every element against its component, and a spec that does not fit comes back to the agent with what to fix. One that fits is shown in the conversation where the agent called it, between the text before and after it.

Render it in the sidebar with `Chat.Ui` and a component for each catalog entry. Each element's props are parsed by its schema again, so a component gets defaults filled in:

```tsx
import { defineChatUi } from "@parlor/chat";
import { z } from "zod";
const chatUi = defineChatUi({
  Card: { description: "", props: z.object({ title: z.string() }), children: true },
  Stat: { description: "", props: z.object({ label: z.string(), value: z.number() }) },
});
// ---cut---
import { Chat, type ChatItem, type ChatUiComponents } from "@parlor/client/react";
import type { ReactNode } from "react";

const components: ChatUiComponents<typeof chatUi> = {
  Card: ({ title, children }) => (
    <section aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  Stat: ({ label, value }) => (
    <p>
      {label}: <strong>{value}</strong>
    </p>
  ),
};

function Item({ item }: { readonly item: ChatItem }): ReactNode {
  if (item.kind === "ui") {
    return <Chat.Ui spec={item.spec} catalog={chatUi} components={components} />;
  }
  return null;
}
```

The components are your own React code, so one can call your actions or change the page like any other component. An old message keeps the spec it was shown with; an element your catalog no longer describes renders `fallback`, nothing by default. It takes a Parlor Host from this release on; an older one shows `chat_show` as an ordinary tool step.
