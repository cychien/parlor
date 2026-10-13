import { type H3Event, handleCors } from "h3";

import { SOURCE_HEADER } from "./protocol.js";

export const SHELL_ORIGINS: readonly string[] = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
];

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface CorsConfig {
  readonly origins?: readonly (string | RegExp)[] | undefined;
}

export function isAllowedOrigin(
  origin: string,
  extra: readonly (string | RegExp)[] = [],
) {
  if (SHELL_ORIGINS.includes(origin) || LOCAL_DEV_ORIGIN.test(origin)) return true;
  return extra.some((rule) =>
    typeof rule === "string" ? rule === origin : rule.test(origin),
  );
}

export function corsMiddleware(config: CorsConfig = {}) {
  const extra = config.origins ?? [];
  return (event: H3Event) => {
    const preflight = handleCors(event, {
      origin: (origin) => isAllowedOrigin(origin, extra),
      methods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", SOURCE_HEADER],
      credentials: true,
      exposeHeaders: ["content-type", "content-length"],
      preflight: { statusCode: 204 },
    });
    return preflight || undefined;
  };
}
