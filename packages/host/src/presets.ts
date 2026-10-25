export const DEPLOY_PRESETS = [
  "node-server",
  "vercel",
  "netlify",
  "cloudflare-module",
  "cloudflare-durable",
  "aws-lambda",
  "deno-deploy",
  "bun",
] as const;
export type DeployPreset = (typeof DEPLOY_PRESETS)[number];

const LONG_LIVED: ReadonlySet<DeployPreset> = new Set([
  "node-server",
  "bun",
  "cloudflare-durable",
]);

const ON_WORKERD: ReadonlySet<DeployPreset> = new Set([
  "cloudflare-module",
  "cloudflare-durable",
]);

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

/** `cloudflare-durable` is a Worker that hands every request but documents to one Durable Object. */
export function nitroPresetFor(preset: DeployPreset): string {
  return preset === "cloudflare-durable" ? "cloudflare-module" : preset;
}

const RENDER_CONDITIONS: Partial<Record<DeployPreset, readonly string[]>> = {
  "cloudflare-module": ["workerd", "worker"],
  "cloudflare-durable": ["workerd", "worker"],
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
