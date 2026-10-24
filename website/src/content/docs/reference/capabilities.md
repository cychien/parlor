---
title: "@parlor/capabilities"
description: One interface per platform feature, with a web, a Capacitor and a Tauri adapter.
---

```sh
pnpm add @parlor/capabilities
```

A capability is what a browser cannot always do: notifications, deep links, a secure session store, a device key. Each has one interface and an adapter per platform, picked at build time, so app code never checks the platform.

```ts
import { notifications, resolveCapability } from "@parlor/capabilities";

const handle = await resolveCapability(notifications);
if (handle.available) {
  await handle.api.request();
  await handle.api.show("Saved", { body: "Your note is saved." });
}
```

```ts
import { resolveCapability } from "@parlor/capabilities";
//       ^?
```

`available: false` carries a `reason`; render a fallback instead of an error. In React, `useCapability(notifications)` from `@parlor/client/react` does the same.

| Capability      | What                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| `notifications` | permission, request, show                                                    |
| `deepLink`      | receive the links that open the app through `app.scheme`                     |
| `sessionStore`  | keep the session token: a cookie on the web, a secure store in native shells |
| `deviceKey`     | a signing key bound to this device                                           |

`defineCapability` defines a new one from its adapters.
