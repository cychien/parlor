import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";

/** Newline-delimited input; a broken stream ends it instead of throwing from readline. */
export function onLines(input: Readable, handle: (line: string) => void): Interface {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", handle);
  lines.on("error", () => input.destroy());
  return lines;
}
