---
title: The agent sidebar
description: How the sidebar reaches the coding agents on your computer, and how to change it.
---

A new app has an **Agent** button in its header. It opens a sidebar where you chat with a coding agent installed on your own computer, Claude Code or Codex, and that agent operates the app through its actions.

## How it connects

- In development, `parlor dev` starts **Parlor Host** beside the server. It finds the agents installed on this computer and offers them to the sidebar. There is nothing to sign in to or pair.
- The agent runs on your computer, with your own subscription. When it calls an app tool, the call goes to the app's actions under your scope, and any `confirm: true` action waits for you in the sidebar.
- The page tells the agent where you are: the current route's `staticData.description` and the views on screen (see below), so a prompt such as "check off the first one" has a referent.

After `parlor add auth`, each user connects their own computer instead: the sidebar shows a command such as `npx @parlor/agent-host connect http://localhost:5173`, which pairs that computer with the signed-in account. See [Auth](/guides/auth/).

In a production build without sign-in, chat is unavailable: `useChat().status` is `"unavailable"`, and the template's sidebar says so. `parlor build` warns about it.

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
