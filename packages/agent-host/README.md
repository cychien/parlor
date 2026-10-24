# @parlor/agent-host

Parlor Host, the `parlor-host` command: it connects the coding agents on a computer, such as Claude Code and Codex, to a Parlor app's sidebar. `parlor dev` runs it for you; with sign-in, a user connects their computer with `npx @parlor/agent-host connect <app url>`. Installed by `@parlor/cli`; you do not depend on it directly.

```sh
npx @parlor/agent-host connect https://todos.example.com
```

Tests can script an agent with the fake agent:

```ts
import type { FakeAgentScript } from "@parlor/agent-host/testing";

export const script: FakeAgentScript = { steps: {}, fallback: "echo" };
```

Docs: https://cychien.github.io/parlor/guides/agent-sidebar/
