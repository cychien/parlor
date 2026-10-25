import { registerHooks } from "node:module";

export const CLOUDFLARE_WORKERS = "cloudflare:workers";

/** Resolves `cloudflare:workers` to `module` for every import that follows. */
export function registerCloudflareWorkers(
  module: string = import.meta.resolve("./workers.js"),
): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) =>
      specifier === CLOUDFLARE_WORKERS
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context),
  });
}
