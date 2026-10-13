import { spawnSync } from "node:child_process";

import { TauriCliError } from "./tauri-cli.js";

export function hasCargo(run: typeof spawnSync = spawnSync): boolean {
  const result = run("cargo", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export function assertRustToolchain(check: () => boolean = hasCargo): void {
  if (check()) return;
  throw new TauriCliError(
    "Rust toolchain not found. Desktop builds need cargo on PATH: install it from https://rustup.rs and run `rustup default stable`.",
  );
}
