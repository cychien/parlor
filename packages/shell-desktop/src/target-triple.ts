import { spawnSync } from "node:child_process";

export function hostTargetTriple(run: typeof spawnSync = spawnSync): string {
  const result = run("rustc", ["-vV"], { encoding: "utf8" });
  const triple = /^host: (\S+)$/m.exec(String(result.stdout))?.[1];
  if (result.status !== 0 || !triple) {
    throw new Error("Could not read the host target triple from `rustc -vV`.");
  }
  return triple;
}
