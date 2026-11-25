# @parlor/capabilities

Browser features behind one interface with an availability query: notifications, deep links, files, a device key.

```sh
pnpm add @parlor/capabilities
```

```ts
import { notifications, resolveCapability } from "@parlor/capabilities";

const handle = await resolveCapability(notifications);
if (handle.available) await handle.api.show("Saved");
```

Docs: https://cychien.github.io/parlor/reference/capabilities/
