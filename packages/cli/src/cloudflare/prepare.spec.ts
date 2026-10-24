import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { CliError } from "../errors.js";
import { prepareCloudflareDev } from "./prepare.js";
import { WRANGLER_MISSING } from "./wrangler.js";

const app = { id: "dev.parlor.media", name: "Media" };

async function project(withWrangler: boolean): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "parlor-cf-prepare-"));
  if (withWrangler) {
    await symlink(
      join(import.meta.dirname, "../../node_modules"),
      join(rootDir, "node_modules"),
    );
  }
  return rootDir;
}

describe("prepareCloudflareDev", () => {
  it("leaves an app on any other preset alone", async () => {
    const rootDir = await project(false);
    await expect(
      prepareCloudflareDev({ config: parseConfig({ app }), rootDir }, {}),
    ).resolves.toBeUndefined();
    await expect(
      prepareCloudflareDev(
        { config: parseConfig({ app, deploy: { preset: "node-server" } }), rootDir },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown preset as parlor build does", async () => {
    const rootDir = await project(false);
    const prepared = prepareCloudflareDev(
      { config: parseConfig({ app, deploy: { preset: "heroku" } }), rootDir },
      {},
    );
    await expect(prepared).rejects.toThrow(CliError);
    await expect(prepared).rejects.toThrow(/Unknown deploy preset "heroku"/);
  });

  it("asks for Wrangler when the app does not have it", async () => {
    const rootDir = await project(false);
    const prepared = prepareCloudflareDev(
      { config: parseConfig({ app, deploy: { preset: "cloudflare-durable" } }), rootDir },
      {},
    );
    await expect(prepared).rejects.toThrow(CliError);
    await expect(prepared).rejects.toThrow(WRANGLER_MISSING);
  });

  it("writes the bindings the build declares and names the classes dev cannot run", async () => {
    const rootDir = await project(true);
    const config = parseConfig({
      app,
      deploy: {
        preset: "cloudflare-durable",
        cloudflare: {
          wrangler: {
            r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
            durable_objects: { bindings: [{ name: "FRIDGE", class_name: "Fridge" }] },
          },
        },
      },
    });

    const prepared = await prepareCloudflareDev({ config, rootDir }, {});

    expect(prepared).toEqual({
      configPath: join(rootDir, ".parlor", "cloudflare", "wrangler.json"),
      unavailable: [
        { binding: "PARLOR_SERVER", className: "ParlorServer" },
        { binding: "FRIDGE", className: "Fridge" },
      ],
    });
    await expect(
      readFile(prepared!.configPath, "utf8").then((text) => JSON.parse(text)),
    ).resolves.toMatchObject({
      name: "dev-parlor-media",
      compatibility_flags: ["nodejs_compat"],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
      durable_objects: { bindings: [] },
    });
  });
});
