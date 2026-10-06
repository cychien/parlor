import { z } from "zod";

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
    })
    .prefault({}),
  web: z
    .object({
      port: z.number().int().positive().default(5173),
      pwa: z.boolean().default(true),
      themeColor: z.string().default("#ffffff"),
      backgroundColor: z.string().default("#ffffff"),
    })
    .prefault({}),
  desktop: z
    .object({
      width: z.number().int().positive().default(1024),
      height: z.number().int().positive().default(768),
    })
    .prefault({}),
});

export type ParlorConfigInput = z.input<typeof parlorConfigSchema>;
export type ParlorConfig = z.output<typeof parlorConfigSchema>;

export function defineConfig(config: ParlorConfigInput): ParlorConfigInput {
  return config;
}

export function parseConfig(input: unknown): ParlorConfig {
  return parlorConfigSchema.parse(input);
}
