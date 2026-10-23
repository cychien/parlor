# @parlor/capabilities

Platform features with one interface and an adapter for the web, Capacitor (iOS, Android) and Tauri (desktop): notifications, deep links, a session store, a device key.

```sh
pnpm add @parlor/capabilities
```

```ts
import { notifications, resolveCapability } from "@parlor/capabilities";

const handle = await resolveCapability(notifications);
if (handle.available) await handle.api.show("Saved");
```

Docs: https://parlor.dev/reference/capabilities/
