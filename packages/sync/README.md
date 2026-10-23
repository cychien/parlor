# @parlor/sync

The live-update protocol: the cursor and event types the server and the page exchange so queries refresh when data changes. Installed by `@parlor/server` and `@parlor/client`; you do not depend on it directly.

```ts
import { INITIAL_CURSOR, SYNC_PROTOCOL_VERSION } from "@parlor/sync";

console.log(SYNC_PROTOCOL_VERSION, INITIAL_CURSOR);
```

Docs: https://parlor.dev/guides/deploy/
