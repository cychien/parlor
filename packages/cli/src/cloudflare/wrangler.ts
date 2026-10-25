import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const WRANGLER_MISSING =
  "The cloudflare-durable preset runs the app's Cloudflare bindings in parlor dev with Wrangler. Add wrangler to the app's devDependencies.";

/** The app's own Wrangler, the one that builds and deploys it: a node_modules lookup, never NODE_PATH. */
export function resolveWrangler(rootDir: string): string | undefined {
  for (let dir = rootDir; ; dir = dirname(dir)) {
    const installed = join(dir, "node_modules", "wrangler");
    if (existsSync(join(installed, "package.json"))) return require.resolve(installed);
    if (dirname(dir) === dir) return undefined;
  }
}
