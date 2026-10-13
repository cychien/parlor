import { z } from "zod";

const APP_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const parlorConfigSchema = z.object({
  app: z.object({
    id: z
      .string()
      .regex(APP_ID, "app.id must be a reverse-DNS identifier such as com.example.todo"),
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  server: z
    .object({
      entry: z.string().default("server.ts"),
      port: z.number().int().positive().default(3000),
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
});

export type ParlorConfigInput = z.input<typeof parlorConfigSchema>;
export type ParlorConfig = z.output<typeof parlorConfigSchema>;

export function defineConfig(config: ParlorConfigInput): ParlorConfigInput {
  return config;
}

export function parseConfig(input: unknown): ParlorConfig {
  return parlorConfigSchema.parse(input);
}
