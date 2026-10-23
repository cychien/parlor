# @parlor/host

Builds the production server: wraps an app's `server.ts` and web build in a Nitro server for a deploy preset. Installed by `@parlor/cli`; you do not depend on it directly.

```ts
import { DEPLOY_PRESETS } from "@parlor/host";

console.log(DEPLOY_PRESETS.join(", "));
```

Docs: https://parlor.dev/guides/deploy/
