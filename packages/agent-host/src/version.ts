import { createRequire } from "node:module";

declare const __PARLOR_HOST_VERSION__: string | undefined;

/** Fixed at build time in a release; the package's own version when run from source. */
export const HOST_VERSION: string =
  typeof __PARLOR_HOST_VERSION__ === "undefined"
    ? (createRequire(import.meta.url)("../package.json") as { readonly version: string })
        .version
    : __PARLOR_HOST_VERSION__;
