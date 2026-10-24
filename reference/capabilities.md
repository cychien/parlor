# @parlor/capabilities

```sh
pnpm add @parlor/capabilities
```

A capability is what a browser cannot always do: notifications, files, deep links, a secure session store, a device key. Each has one interface and an adapter per platform, picked at build time, so app code never checks the platform.

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
```

`available: false` carries a `reason`; render a fallback instead of an error. In React, `useCapability(notifications)` from `@parlor/client/react` does the same.

| Capability      | What                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| `notifications` | permission, request, show                                                    |
| `files`         | let the user pick files, and save a file where they choose                   |
| `deepLink`      | receive the links that open the app through `app.scheme`                     |
| `sessionStore`  | keep the session token: a cookie on the web, a secure store in native shells |
| `deviceKey`     | a signing key bound to this device                                           |

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

`pick` resolves with the chosen files, or an empty list when the user cancels; each has `name`, `type` (`""` when unknown), `size`, `bytes()` and `text()`. `save` resolves `"saved"` or `"cancelled"`.

| Where  | `pick`                                       | `save`                                                     |
| ------ | -------------------------------------------- | ---------------------------------------------------------- |
| Web    | the browser's file chooser                   | the save dialog where the browser has one, else a download |
| macOS  | the native open dialog, filtered by `accept` | the native save dialog                                     |
| iPhone | the system picker: photos, camera, Files     | the share sheet, with Save to Files                        |

`defineCapability` defines a new one from its adapters.
