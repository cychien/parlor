# @parlor/client

The browser side of a Parlor app: the action client, and React hooks that read and write through actions and refresh when anyone, including an agent, changes the data.

```sh
pnpm add @parlor/client @tanstack/react-query @tanstack/react-router react react-dom
```

```tsx
import { createActionClient } from "@parlor/client";
import { useActionQuery } from "@parlor/client/react";

export const client = createActionClient();

export function Health() {
  const status = useActionQuery("health" as never, {} as never);
  return <p>{status.isSuccess ? "up" : "..."}</p>;
}
```

In an app, register the actions once in `src/parlor.d.ts` so names and inputs are typed. Docs: https://parlor.dev/guides/pages-and-hooks/
