# @parlor/chat

```sh
pnpm add @parlor/chat
```

```ts
import { chat } from "@parlor/chat/server";
```

Install it as a plugin: `createServer({ actions, database, plugins: [chat()] })`. It adds the chat's tables, actions and routes: threads, prompts, the agents' replies and their approvals, and the channel that streams them to the page.

Chat needs an auth provider that can mint turn tokens. In development `parlor dev` installs one. In production, add sign-in with `parlor add auth`; without it the server still starts, chat serves nothing, and the client reports `useChat().status` as `"unavailable"`.

The client side is in [`@parlor/client/react`](/parlor/reference/client-react/). `@parlor/chat` holds the shared types (`AgentRef`, `ThreadSummary`, `ChatItemBody`) and `@parlor/chat/testing` a fake host for tests.
