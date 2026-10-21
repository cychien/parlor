import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const crate = (file: string) =>
  readFile(fileURLToPath(new URL(`../rust/src/${file}`, import.meta.url)), "utf8");

describe("parlor-shell portability", () => {
  it("compiles the Unix control client and the host commands only on Unix, so every Tauri target builds", async () => {
    const lib = await crate("lib.rs");
    for (const unit of ["mod control;", "mod dialog;", "mod host;", "pub use host::{"]) {
      expect(lib).toContain(`#[cfg(unix)]\n${unit}`);
    }
  });

  it("keeps the Keychain session and device key commands on every target", async () => {
    const lib = await crate("lib.rs");
    expect(lib).toMatch(/^mod device_key;$/m);
    expect(lib).toMatch(/^mod session;$/m);
    expect(lib).toMatch(/^pub use device_key::\{[^}]*\};$/m);
    expect(lib).toMatch(/^pub use session::\{[^}]*\};$/m);
  });

  it("answers unsupported outside macOS, which the TypeScript adapters treat as unavailable", async () => {
    const session = await crate("session.rs");
    expect(session).toMatch(
      /#\[cfg\(not\(target_os = "macos"\)\)\]\nmod store \{[\s\S]*"unsupported"/,
    );
  });
});
