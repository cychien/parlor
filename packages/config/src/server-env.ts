import type { ParlorConfig } from "./schema.js";

export function appServerEnv(config: ParlorConfig): Record<string, string> {
  return {
    PARLOR_APP_NAME: config.app.name,
    ...(config.app.description ? { PARLOR_APP_DESCRIPTION: config.app.description } : {}),
  };
}
