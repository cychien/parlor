import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  commandsFor,
  detectProjectPackageManager,
  formatCommand,
  fromUserAgent,
  packageManagerField,
  packageManagerFiles,
  runInstall,
} from "./package-manager.js";

describe("package manager detection (D5)", () => {
  it.each([
    ["pnpm/11.21.0 npm/? node/v24.19.0 darwin arm64", "pnpm", "11.21.0"],
    ["npm/11.6.0 node/v24.19.0 darwin arm64 workspaces/false", "npm", "11.6.0"],
    ["yarn/4.9.2 npm/? node/v24.19.0 darwin arm64", "yarn", "4.9.2"],
    ["bun/1.3.5 npm/? node/v24.3.0 darwin arm64", "bun", "1.3.5"],
  ])("reads %s", (userAgent, name, version) => {
    expect(fromUserAgent(userAgent)).toEqual({ name, version });
  });

  it("is undefined without a user agent or with an unknown one", () => {
    expect(fromUserAgent(undefined)).toBeUndefined();
    expect(fromUserAgent("deno/2.0.0")).toBeUndefined();
  });

  it("falls back from the user agent to packageManager, the lockfile, then npm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parlor-pm-"));
    expect(
      await detectProjectPackageManager(dir, {
        npm_config_user_agent: "bun/1.3.5 npm/?",
      }),
    ).toEqual({ name: "bun", version: "1.3.5" });
    expect(await detectProjectPackageManager(dir, {})).toEqual({
      name: "npm",
      version: undefined,
    });
    await writeFile(join(dir, "yarn.lock"), "");
    expect(await detectProjectPackageManager(dir, {})).toEqual({
      name: "yarn",
      version: undefined,
    });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.21.0+sha512.abc" }),
    );
    expect(await detectProjectPackageManager(dir, {})).toEqual({
      name: "pnpm",
      version: "11.21.0",
    });
  });
});

describe("commands per package manager", () => {
  it("prints run and exec in each dialect", () => {
    const pnpm = commandsFor({ name: "pnpm", version: "11.21.0" });
    const npm = commandsFor({ name: "npm", version: undefined });
    const yarn = commandsFor({ name: "yarn", version: "4.9.2" });
    const bun = commandsFor({ name: "bun", version: "1.3.5" });
    expect(pnpm.run("dev")).toBe("pnpm dev");
    expect(npm.run("dev")).toBe("npm run dev");
    expect(yarn.run("dev")).toBe("yarn dev");
    expect(bun.run("dev")).toBe("bun run dev");
    expect(pnpm.exec("parlor", ["add", "auth"])).toBe("pnpm parlor add auth");
    expect(npm.exec("parlor", ["add", "auth"])).toBe("npx parlor add auth");
    expect(yarn.exec("parlor", ["add", "auth"])).toBe("yarn parlor add auth");
    expect(bun.exec("parlor", ["add", "auth"])).toBe("bunx parlor add auth");
  });

  it("builds install and add commands", () => {
    const npm = commandsFor({ name: "npm", version: undefined });
    expect(formatCommand(npm.install)).toBe("npm install");
    expect(formatCommand(npm.add(["@parlor/auth@0.1.0"], { dev: false }))).toBe(
      "npm install @parlor/auth@0.1.0",
    );
    expect(formatCommand(npm.add(["auth@1.7.7"], { dev: true }))).toBe(
      "npm install --save-dev auth@1.7.7",
    );
    const pnpm = commandsFor({ name: "pnpm", version: "11.21.0" });
    expect(formatCommand(pnpm.add(["@parlor/auth@0.1.0"], { dev: false }))).toBe(
      "pnpm add @parlor/auth@0.1.0",
    );
  });
});

describe("files a first install needs", () => {
  it("approves esbuild builds for pnpm, by the pnpm major", () => {
    expect(
      packageManagerFiles({ name: "pnpm", version: "11.21.0" }).get(
        "pnpm-workspace.yaml",
      ),
    ).toBe("allowBuilds:\n  esbuild: true\n");
    expect(
      packageManagerFiles({ name: "pnpm", version: "10.3.0" }).get("pnpm-workspace.yaml"),
    ).toBe("onlyBuiltDependencies:\n  - esbuild\n");
  });

  it("turns off Plug'n'Play for yarn and writes nothing for npm and bun", () => {
    expect(
      packageManagerFiles({ name: "yarn", version: "4.9.2" }).get(".yarnrc.yml"),
    ).toBe("nodeLinker: node-modules\n");
    expect(packageManagerFiles({ name: "npm", version: "11.6.0" }).size).toBe(0);
    expect(packageManagerFiles({ name: "bun", version: "1.3.5" }).size).toBe(0);
  });

  it("pins packageManager for pnpm, yarn and bun only when the version is known", () => {
    expect(packageManagerField({ name: "pnpm", version: "11.21.0" })).toBe(
      "pnpm@11.21.0",
    );
    expect(packageManagerField({ name: "pnpm", version: undefined })).toBeUndefined();
    expect(packageManagerField({ name: "npm", version: "11.6.0" })).toBeUndefined();
  });
});

describe("runInstall", () => {
  const script = (source: string) => ({ bin: process.execPath, args: ["-e", source] });

  it("reports pnpm's ignored build scripts as a hint, not a failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parlor-install-"));
    const lines: string[] = [];
    const outcome = await runInstall(
      dir,
      script(
        `process.stderr.write("[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.25.12, esbuild@0.28.2\\n"); process.exit(1)`,
      ),
      (line) => lines.push(line),
    );
    expect(outcome).toEqual({
      kind: "ignored-builds",
      packages: ["esbuild@0.25.12", "esbuild@0.28.2"],
      hint: "Run pnpm approve-builds to allow them.",
    });
    expect(lines).toEqual([
      "pnpm skipped the build scripts of esbuild@0.25.12, esbuild@0.28.2. Run pnpm approve-builds to allow them.",
    ]);
  });

  it("installs with NODE_ENV=development and reports any other exit as failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parlor-install-"));
    expect(
      await runInstall(
        dir,
        script(`process.exit(process.env.NODE_ENV === "development" ? 0 : 3)`),
        () => {},
      ),
    ).toEqual({ kind: "installed" });
    const failed = await runInstall(dir, script("process.exit(2)"), () => {});
    expect(failed).toMatchObject({ kind: "failed", exitCode: 2 });
  });
});
