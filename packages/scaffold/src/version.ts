import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** `@parlor/*` and `create-parlor` release in lockstep, so a project pins every framework package to this. */
export const FRAMEWORK_VERSION: string = (
  require("../package.json") as { version: string }
).version;

/** The same folder from `src/` in the repo and from `dist/` when published. */
export const TEMPLATES_DIR: string = fileURLToPath(
  new URL("../templates/", import.meta.url),
);

export const DOCS_URL = "https://parlor.dev";
