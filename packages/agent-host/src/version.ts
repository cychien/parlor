import { createRequire } from "node:module";

export const HOST_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { readonly version: string }
).version;

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => {
    const match = VERSION.exec(version);
    if (!match) throw new Error(`"${version}" is not a major.minor.patch version.`);
    return match.slice(1).map(Number);
  }) as [number[], number[]];
  for (let at = 0; at < 3; at += 1) {
    const difference = left[at]! - right[at]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
