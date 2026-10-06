export type Platform = "web" | "capacitor" | "tauri";

interface PlatformGlobals {
  __TAURI_INTERNALS__?: unknown;
  Capacitor?: { isNativePlatform?: () => boolean };
}

export function detectPlatform(globals: unknown = globalThis): Platform {
  const g = globals as PlatformGlobals;
  if (g.__TAURI_INTERNALS__) return "tauri";
  if (g.Capacitor?.isNativePlatform?.()) return "capacitor";
  return "web";
}
