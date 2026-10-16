import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { loadParlorConfig } from "@parlor/config";
import { defineCommand } from "citty";

import { CliError } from "../errors.js";
import { buildWebAndServer } from "../web-target.js";

const require = createRequire(import.meta.url);

export function runNitroDeploy(hostRoot: string, preset: string): Promise<void> {
  const bin = require.resolve("nitro/cli");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [bin, "deploy", "--prebuilt", "--preset", preset, "--dir", hostRoot],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`nitro deploy exited with code ${code}`));
    });
  });
}

export const deploy = defineCommand({
  meta: {
    name: "deploy",
    description: "Build the app and deploy the server to its preset",
  },
  args: {
    preset: {
      type: "string",
      description: "Deploy preset: node-server, vercel, netlify, …",
    },
  },
  async run({ args }) {
    const loaded = await loadParlorConfig();
    const result = await buildWebAndServer(loaded, { preset: args.preset });
    if (result.preset === "node-server") {
      console.log(
        `node-server has no remote to deploy to. Run: node ${result.outputDir}/server/index.mjs`,
      );
      return;
    }
    await runNitroDeploy(result.rootDir, result.preset);
  },
});
