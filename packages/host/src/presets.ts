export const DEPLOY_PRESETS = [
  "node-server",
  "vercel",
  "netlify",
  "cloudflare-module",
  "cloudflare-durable",
  "cloudflare-scaled",
  "aws-lambda",
  "deno-deploy",
  "bun",
] as const;
export type DeployPreset = (typeof DEPLOY_PRESETS)[number];

const LONG_LIVED: ReadonlySet<DeployPreset> = new Set([
  "node-server",
  "bun",
  "cloudflare-durable",
  "cloudflare-scaled",
]);

const ON_WORKERD: ReadonlySet<DeployPreset> = new Set([
  "cloudflare-module",
  "cloudflare-durable",
  "cloudflare-scaled",
]);

/** The presets that run the app's server in Durable Objects the app's own Worker defines. */
export function usesDurableObjects(preset: DeployPreset): boolean {
  return preset === "cloudflare-durable" || preset === "cloudflare-scaled";
}

const CI_PRESETS: ReadonlyArray<readonly [string, DeployPreset]> = [
  ["VERCEL", "vercel"],
  ["NETLIFY", "netlify"],
  ["CF_PAGES", "cloudflare-module"],
];

export class PresetError extends Error {
  override readonly name = "PresetError";
}

export function isDeployPreset(value: string): value is DeployPreset {
  return (DEPLOY_PRESETS as readonly string[]).includes(value);
}

export function detectCiPreset(
  env: NodeJS.ProcessEnv = process.env,
): DeployPreset | undefined {
  return CI_PRESETS.find(([name]) => Boolean(env[name]))?.[1];
}

export function resolvePreset(
  explicit: string | undefined,
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { preset: DeployPreset; reason: "flag" | "config" | "ci" | "default" } {
  const pick = (value: string | undefined, reason: "flag" | "config") => {
    if (value === undefined) return undefined;
    if (!isDeployPreset(value)) {
      throw new PresetError(
        `Unknown deploy preset "${value}". Expected one of: ${DEPLOY_PRESETS.join(", ")}`,
      );
    }
    return { preset: value, reason } as const;
  };
  return (
    pick(explicit, "flag") ??
    pick(configured, "config") ??
    (detectCiPreset(env)
      ? { preset: detectCiPreset(env)!, reason: "ci" as const }
      : undefined) ?? { preset: "node-server", reason: "default" }
  );
}

export function syncTransportFor(preset: DeployPreset): "sse" | "poll" {
  return LONG_LIVED.has(preset) ? "sse" : "poll";
}

/**
 * `one` for the presets that run the app as exactly one server, whatever the load: its
 * memory holds every open stream, so it needs no database connection to hear its own events.
 * `scaled` for the one that splits it into a stateless edge and a server per account, joined
 * by Durable Objects. The others may be scaled out, which only whoever deploys them knows
 * (`server.instances`).
 */
export function instancesFor(preset: DeployPreset): "one" | "scaled" | undefined {
  if (preset === "cloudflare-durable") return "one";
  if (preset === "cloudflare-scaled") return "scaled";
  return undefined;
}

/** Both Durable Object presets are a Cloudflare module Worker with Durable Objects of its own. */
export function nitroPresetFor(preset: DeployPreset): string {
  return usesDurableObjects(preset) ? "cloudflare-module" : preset;
}

const RENDER_CONDITIONS: Partial<Record<DeployPreset, readonly string[]>> = {
  "cloudflare-module": ["workerd", "worker"],
  "cloudflare-durable": ["workerd", "worker"],
  "cloudflare-scaled": ["workerd", "worker"],
  "deno-deploy": ["deno"],
  bun: ["bun", "node"],
};

/** Export conditions of the runtime that renders pages, for the server render build. */
export function renderConditionsFor(preset: DeployPreset): readonly string[] {
  return RENDER_CONDITIONS[preset] ?? ["node"];
}

/** The presets whose server runs on Cloudflare's workerd. */
export function runsOnWorkerd(preset: DeployPreset): boolean {
  return ON_WORKERD.has(preset);
}
