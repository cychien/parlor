---
title: "@parlor/capabilities"
description: Browser features behind one interface, each with an availability query.
---

```sh
pnpm add @parlor/capabilities
```

A capability is what a browser cannot always do: notifications, files, deep links, a device key. Each has one interface and a web adapter, and says whether this browser can run it, so app code checks `available` instead of the browser.

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

| Capability      | Web adapter        | What                                                           |
| --------------- | ------------------ | -------------------------------------------------------------- |
| `notifications` | `webNotifications` | permission, request, show                                      |
| `files`         | `webFiles`         | let the user pick files, and save a file where they choose     |
| `deepLink`      | `webDeepLink`      | receive the URL that opened the app                            |
| `deviceKey`     | `webDeviceKey`     | a signing key bound to this device, and a passkey for presence |
| `authBrowser`   | `webAuthBrowser`   | send the page to a sign-in flow, such as a provider's          |

## Files

```ts
import { files, resolveCapability } from "@parlor/capabilities";

const handle = await resolveCapability(files);
if (handle.available) {
  const [picked] = await handle.api.pick({ accept: ["image/*", ".pdf"] });
  if (picked) console.log(picked.name, picked.type, picked.size, await picked.bytes());
  await handle.api.save("a,b\n1,2\n", { name: "export.csv", type: "text/csv" });
}
```

`pick` opens the browser's file chooser and resolves with the chosen files, or an empty list when the user cancels; each has `name`, `type` (`""` when unknown), `size`, `bytes()` and `text()`. `save` opens the save dialog where the browser has one, and downloads the file otherwise; it resolves `"saved"` or `"cancelled"`.

## Auth browser

```ts
import { authBrowser, resolveCapability } from "@parlor/capabilities";

const handle = await resolveCapability(authBrowser);
if (handle.available) {
  await handle.api.open(
    "https://accounts.example.com/authorize?client_id=app",
    "https://app.example.com/signed-in",
  );
}
```

`open(url, callbackUrl)` sends the page itself to `url`, a flow that ends by redirecting to `callbackUrl`. The promise never settles: the flow comes back as a new page load. The auth client's `social.signIn` uses it; apps rarely call it directly.

## Your own capability

`defineCapability({ name, adapters })` defines one. Each adapter has `available()` and `create()`, sync or async; `resolveCapability` uses the first adapter that is available, and otherwise answers `{ available: false, reason }` with the reason `Capability "<name>" is not available in this browser`.
