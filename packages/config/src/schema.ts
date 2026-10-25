import type { UserConfig as ViteUserConfig } from "vite";
import { z } from "zod";

export const CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "worker-src",
  "manifest-src",
  "frame-src",
  "frame-ancestors",
  "object-src",
  "base-uri",
  "form-action",
] as const;

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const APP_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const parlorConfigSchema = z.object({
  app: z.object({
    id: z
      .string()
      .regex(APP_ID, "app.id must be a reverse-DNS identifier such as com.example.todo"),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "app.version must be semver like 1.0.0")
      .default("0.1.0"),
    scheme: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]*$/, "app.scheme must be a URL scheme such as hello")
      .optional(),
  }),
  server: z
    .object({
      entry: z.string().default("server.ts"),
      port: z.number().int().positive().default(3000),
      url: z.url().optional(),
      sync: z.object({ transport: z.enum(["sse", "poll"]).optional() }).optional(),
    })
    .prefault({}),
  web: z
    .object({
      port: z.number().int().positive().default(5173),
      pwa: z.boolean().default(true),
      themeColor: z.string().default("#ffffff"),
      backgroundColor: z.string().default("#ffffff"),
      routeTree: z.string().optional(),
      csp: z.partialRecord(z.enum(CSP_DIRECTIVES), z.array(z.string())).optional(),
    })
    .prefault({}),
  desktop: z
    .object({
      width: z.number().int().positive().default(1024),
      height: z.number().int().positive().default(768),
      /** Bundle Parlor Host as a sidecar so the chat can use this computer's agents. */
      agentHost: z.boolean().optional(),
    })
    .prefault({}),
  database: z
    .object({
      schema: z.string().default("schema"),
      migrations: z.string().default("migrations"),
    })
    .prefault({}),
  deploy: z
    .object({
      preset: z.string().optional(),
      /** Only read by the cloudflare-durable preset. */
      cloudflare: z
        .object({
          /** Where the app's Durable Object starts, such as "weur": put it near the database. */
          locationHint: z.string().optional(),
          /** Merged into the generated wrangler config: the app's own bindings, its name. */
          wrangler: z.record(z.string(), z.unknown()).optional(),
          /**
           * A module whose named exports the Worker exports too, such as the app's own Durable
           * Object classes. The Worker evaluates it at startup, so it may not do I/O while loading.
           */
          exports: z.string().optional(),
        })
        .optional(),
    })
    .prefault({}),
  /**
   * Merged into the Vite config `parlor dev` and `parlor build` own, for plugins such as
   * `@tailwindcss/vite`. Keys Parlor sets itself (root, ports, outDir) are ignored with a warning.
   */
  vite: z
    .custom<ViteUserConfig>(isPlainObject, "vite must be a Vite config object")
    .optional(),
});

export type ParlorConfigInput = z.input<typeof parlorConfigSchema>;
export type ParlorConfig = z.output<typeof parlorConfigSchema>;

export function defineConfig(config: ParlorConfigInput): ParlorConfigInput {
  return config;
}

export function parseConfig(input: unknown): ParlorConfig {
  return parlorConfigSchema.parse(input);
}
