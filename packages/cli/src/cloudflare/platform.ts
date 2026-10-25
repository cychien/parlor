import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { UnavailableDurableObject } from "@parlor/host";

import type { CloudflareDev } from "./prepare.js";
import { resolveWrangler, WRANGLER_MISSING } from "./wrangler.js";

type Env = Record<string, unknown>;

let current: Env | undefined;

export function platformEnv(): Env {
  if (!current) {
    throw new Error(
      'cloudflare:workers needs deploy.preset "cloudflare-durable" in parlor.config.ts, which makes parlor dev serve the app\'s Cloudflare bindings',
    );
  }
  return current;
}

export interface CloudflarePlatform {
  readonly env: Env;
  readonly dispose: () => Promise<void>;
}

/** Wrangler's order: `.dev.vars` alone when it exists, otherwise `.env` then `.env.local`. */
export function devVarsFiles(rootDir: string): string[] {
  const devVars = join(rootDir, ".dev.vars");
  if (existsSync(devVars)) return [devVars];
  return [join(rootDir, ".env"), join(rootDir, ".env.local")];
}

/** Workers put text vars and secrets in `process.env` too; variables set in the shell win here. */
export function exposeVars(env: Env, target: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && target[name] === undefined) target[name] = value;
  }
}

export function withUnavailable(
  env: Env,
  unavailable: readonly UnavailableDurableObject[],
): Env {
  const classes = new Map<PropertyKey, string>(
    unavailable.map(({ binding, className }) => [binding, className]),
  );
  return new Proxy(env, {
    get(target, property) {
      const className = classes.get(property);
      if (className) {
        throw new Error(
          `env.${String(property)} is unavailable in parlor dev: it binds ${className}, a Durable Object class the app's own Worker defines, and parlor dev emulates bindings with Wrangler's getPlatformProxy(), which runs no Worker code. Run the cloudflare-durable build on wrangler dev to use it.`,
        );
      }
      return Reflect.get(target, property);
    },
  });
}

export async function startCloudflarePlatform(
  rootDir: string,
  { configPath, unavailable }: CloudflareDev,
): Promise<CloudflarePlatform> {
  const wrangler = resolveWrangler(rootDir);
  if (!wrangler) throw new Error(WRANGLER_MISSING);
  const { getPlatformProxy } = (await import(
    pathToFileURL(wrangler).href
  )) as typeof import("wrangler");
  const proxy = await getPlatformProxy<Env>({
    configPath,
    envFiles: devVarsFiles(rootDir),
    persist: { path: join(dirname(configPath), "state") },
  });
  exposeVars(proxy.env, process.env);
  current = withUnavailable(proxy.env, unavailable);
  return { env: current, dispose: () => proxy.dispose() };
}
