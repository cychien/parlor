import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Well under the 10 s a missed shutdown takes, with room for a loaded machine.
const SHUTDOWN_BOUND_MS = 6000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port assigned")),
      );
    });
  });
}

describe("serve-entry", () => {
  it("prints one line naming the port and closes the app promptly on SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "parlor-serve-entry-"));
    const closedMarker = join(root, "closed");
    const entry = join(root, "server.ts");
    await writeFile(
      entry,
      [
        'import { writeFileSync } from "node:fs";',
        "export default {",
        '  fetch: () => new Response("ok"),',
        `  close: async () => writeFileSync(${JSON.stringify(closedMarker)}, "closed"),`,
        "};",
      ].join("\n"),
    );
    const port = await freePort();
    const { CI: _ci, TEST: _test, ...env } = process.env;
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        fileURLToPath(new URL("./serve-entry.ts", import.meta.url)),
        entry,
      ],
      {
        cwd: root,
        env: { ...env, PORT: String(port) },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        ready = await fetch(`http://localhost:${port}/`).then(
          () => true,
          () => false,
        );
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ready).toBe(true);

      const startedAt = Date.now();
      child.kill("SIGTERM");
      await exited;

      expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_BOUND_MS);
      await expect(access(closedMarker)).resolves.toBeUndefined();
      expect(stdout).toBe(`parlor server listening on http://localhost:${port}\n`);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
