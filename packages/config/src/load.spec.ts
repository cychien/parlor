import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadParlorConfig } from "./load.js";

async function project(configSource?: string) {
  const dir = await mkdtemp(join(tmpdir(), "parlor-config-"));
  if (configSource !== undefined)
    await writeFile(join(dir, "parlor.config.ts"), configSource);
  return dir;
}

describe("loadParlorConfig", () => {
  it("loads and validates a TypeScript config file", async () => {
    const dir = await project(`
      export default { app: { id: "com.example.todo", name: "Todo" }, web: { port: 4000 } };
    `);
    const loaded = await loadParlorConfig(dir);
    expect(loaded.config.app.name).toBe("Todo");
    expect(loaded.config.web.port).toBe(4000);
    expect(loaded.config.server.port).toBe(3000);
    expect(loaded.rootDir).toBe(dir);
    expect(loaded.configFile).toContain("parlor.config.ts");
  });

  it("fails clearly when the file is missing", async () => {
    const dir = await project();
    await expect(loadParlorConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadParlorConfig(dir)).rejects.toThrow(/No parlor.config.ts/);
  });

  it("fails clearly when the file is invalid", async () => {
    const dir = await project(`export default { app: { id: "nope", name: "Todo" } };`);
    await expect(loadParlorConfig(dir)).rejects.toThrow(/reverse-DNS/);
  });
});
