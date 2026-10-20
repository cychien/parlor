import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let file: string | undefined;

export function openHostLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  file = path;
}

export function logEvent(event: string, fields: Readonly<Record<string, unknown>>): void {
  if (file === undefined) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), event, ...fields })}\n`, {
      mode: 0o600,
    });
  } catch {}
}
