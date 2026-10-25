import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

describe("registerCloudflareWorkers", () => {
  it("resolves cloudflare:workers to the given module for TypeScript the server runs with tsx", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-cf-loader-"));
    await writeFile(join(rootDir, "package.json"), '{ "type": "module" }');
    await writeFile(
      join(rootDir, "workers.ts"),
      'export const env = { MEDIA: "bucket" };',
    );
    await writeFile(
      join(rootDir, "app.ts"),
      [
        'import { env } from "cloudflare:workers";',
        'import { basename } from "node:path";',
        "const media: string = env.MEDIA;",
        'console.log(JSON.stringify({ media, base: basename("/a/b.txt") }));',
      ].join("\n"),
    );
    await writeFile(
      join(rootDir, "main.ts"),
      [
        `import { registerCloudflareWorkers } from ${JSON.stringify(join(import.meta.dirname, "loader.ts"))};`,
        `registerCloudflareWorkers(${JSON.stringify(pathToFileURL(join(rootDir, "workers.ts")).href)});`,
        'await import("./app.ts");',
      ].join("\n"),
    );

    const { stdout } = await run(
      process.execPath,
      [require.resolve("tsx/cli"), "main.ts"],
      {
        cwd: rootDir,
      },
    );

    expect(JSON.parse(stdout)).toEqual({ media: "bucket", base: "b.txt" });
  }, 30_000);

  it("names the preset when the server imports cloudflare:workers without it", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "parlor-cf-loader-"));
    await writeFile(join(rootDir, "package.json"), '{ "type": "module" }');
    await writeFile(
      join(rootDir, "app.ts"),
      'import { env } from "cloudflare:workers";\nconsole.log(env);',
    );
    await writeFile(
      join(rootDir, "main.ts"),
      [
        `import { registerCloudflareWorkers } from ${JSON.stringify(join(import.meta.dirname, "loader.ts"))};`,
        "registerCloudflareWorkers();",
        'await import("./app.ts");',
      ].join("\n"),
    );

    await expect(
      run(process.execPath, [require.resolve("tsx/cli"), "main.ts"], { cwd: rootDir }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'cloudflare:workers needs deploy.preset "cloudflare-durable" in parlor.config.ts',
      ),
    });
  }, 30_000);
});
