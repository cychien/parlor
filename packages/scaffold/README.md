# @parlor/scaffold

What `create-parlor` and `parlor add` share: the project templates, the add-on model, the syntax-tree edit engine, package manager detection, install and git. Installed by `create-parlor` and `@parlor/cli`; you do not depend on it directly.

```ts
import { ADDON_NAMES, commandsFor } from "@parlor/scaffold";

const pnpm = commandsFor({ name: "pnpm", version: undefined });
console.log(ADDON_NAMES.map((addon) => pnpm.exec("parlor", ["add", addon])));
```

Docs: https://cychien.github.io/parlor/reference/cli/
