import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { templateFiles } from "../files.js";
import { DEFAULT_LAYOUT } from "../fixtures.js";
import type { AddTools } from "./run.js";
import { addAddons, formatAddResult } from "./run.js";

const PIN = "1.7.7";
const pnpm = { name: "pnpm", version: "11.21.0" } as const;

const FAKE_PNPM = `const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify(args) + "\\n");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const spec of args.slice(1).filter((arg) => !arg.startsWith("-"))) {
  const at = spec.lastIndexOf("@");
  const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
  manifest.dependencies = { ...manifest.dependencies, [name]: version };
  mkdirSync("node_modules/" + name, { recursive: true });
  const dependencies = name === "@parlor/auth" ? { "better-auth": "${PIN}" } : {};
  writeFileSync("node_modules/" + name + "/package.json", JSON.stringify({ name, version, dependencies }));
}
writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\\n");
writeFileSync("pnpm-lock.yaml", "changed\\n");
process.exit(process.env.FAKE_PNPM_FAIL ? 1 : 0);
`;

async function project(server?: string): Promise<{ dir: string; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), "parlor-add-"));
  const templates = templateFiles();
  for (const path of await templates.list("default", "")) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), await templates.read("default", path));
  }
  if (server !== undefined) await writeFile(join(dir, "server.ts"), server);
  await writeFile(join(dir, "pnpm-lock.yaml"), "original\n");
  const bin = join(dir, ".fake-bin");
  await mkdir(bin);
  await writeFile(join(bin, "fake-pnpm.cjs"), FAKE_PNPM);
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-pnpm.cjs")}" "$@"\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  const log = join(bin, "calls.log");
  vi.stubEnv("FAKE_PNPM_LOG", log);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    {
      cwd: dir,
    },
  );
  return { dir, log };
}

function hashes(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if ([".git", "node_modules", ".parlor", ".fake-bin"].includes(entry)) continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        files.set(
          relative(dir, path),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
    }
  };
  walk(dir);
  return files;
}

const workingTools: AddTools = {
  routeTree: async (rootDir) => {
    const path = join(rootDir, DEFAULT_LAYOUT.routeTree);
    await writeFile(path, `${await readFile(path, "utf8")}// "/sign-in"\n`);
  },
  migration: async (rootDir, name) => {
    const meta = join(rootDir, DEFAULT_LAYOUT.migrationsDir, "meta");
    const journal = JSON.parse(await readFile(join(meta, "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries.push({ idx: 1, tag: `0001_${name}` });
    await writeFile(join(meta, "_journal.json"), JSON.stringify(journal));
    const tables = Object.fromEntries(
      ["todos", "user", "session", "account", "verification"].map((table) => [
        `public.${table}`,
        { name: table },
      ]),
    );
    await writeFile(join(meta, "0001_snapshot.json"), JSON.stringify({ tables }));
    await writeFile(
      join(rootDir, DEFAULT_LAYOUT.migrationsDir, `0001_${name}.sql`),
      "-- auth\n",
    );
  },
};

const request = (dir: string, overrides: Partial<Parameters<typeof addAddons>[0]> = {}) =>
  ({
    layout: { ...DEFAULT_LAYOUT, rootDir: dir },
    addons: ["auth"],
    packageManager: pnpm,
    tools: workingTools,
    mode: "apply",
    install: true,
    gitCheck: true,
    log: () => {},
    ...overrides,
  }) as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parlor add refuses what it cannot edit safely (D4)", () => {
  it.each([
    ["a variable", "createServer(options)", "`options`"],
    ["a spread", "createServer({ ...base })", "...base"],
    ["no database to pass", "createServer({ plugins: getPlugins() })", "`database`"],
  ])(
    "writes nothing for %s and prints the change to make by hand",
    async (_, call, reason) => {
      const { dir } = await project(
        `import { createServer } from "@parlor/server";\n\nexport default ${call};\n`,
      );
      const before = hashes(dir);
      const result = await addAddons(request(dir));
      expect(hashes(dir)).toEqual(before);
      const { text, exitCode } = formatAddResult(result, pnpm);
      expect(exitCode).toBe(1);
      expect(text).toContain(
        "parlor add auth: cannot edit server.ts safely, so nothing was changed.",
      );
      expect(text).toContain(`server.ts: `);
      expect(text).toContain(reason);
      expect(text).toContain(
        "Make this change by hand, then run `pnpm parlor add auth` again:",
      );
      expect(text).toContain('    import { createAuth } from "./auth.js";');
      expect(text).toContain("      auth: createAuth(database),");
    },
  );
});

describe("parlor add never leaves a half-done project (H1)", () => {
  it("restores package.json and the lockfile when the install fails", async () => {
    const { dir } = await project();
    vi.stubEnv("FAKE_PNPM_FAIL", "1");
    const before = hashes(dir);
    const result = await addAddons(request(dir));
    expect(result).toMatchObject({ kind: "failed", stage: "install" });
    expect(hashes(dir)).toEqual(before);
  });

  it("changes no file when a generator fails", async () => {
    const { dir } = await project();
    const before = hashes(dir);
    const result = await addAddons(
      request(dir, {
        tools: {
          ...workingTools,
          migration: () => Promise.reject(new Error("drizzle-kit exited 1")),
        },
      }),
    );
    expect(result).toMatchObject({
      kind: "failed",
      stage: "generate",
      message: "parlor db generate failed: drizzle-kit exited 1",
    });
    expect(hashes(dir)).toEqual(before);
    expect(readdirSync(join(dir, ".parlor", "add"))).toEqual([]);
  });

  it("refuses a tree with uncommitted changes unless told not to check", async () => {
    const { dir, log } = await project();
    await writeFile(
      join(dir, "server.ts"),
      `${await readFile(join(dir, "server.ts"), "utf8")}\n`,
    );
    const before = hashes(dir);
    const dirty = await addAddons(request(dir));
    expect(hashes(dir)).toEqual(before);
    expect(formatAddResult(dirty, pnpm)).toEqual({
      text: "parlor add auth: this project has uncommitted changes (server.ts).\nCommit or stash them so the change is easy to review, or pass --no-git-check.",
      exitCode: 1,
    });

    const applied = await addAddons(request(dir, { gitCheck: false }));
    expect(applied.kind).toBe("applied");
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["add", "@parlor/auth@0.0.0"],
      ["add", `better-auth@${PIN}`],
    ]);
    expect(await readFile(join(dir, "server.ts"), "utf8")).toContain(
      "auth: createAuth(database)",
    );
    expect(await readFile(join(dir, "migrations", "0001_auth.sql"), "utf8")).toBe(
      "-- auth\n",
    );
  });

  it("prints the files it wrote and is a no-op the second time", async () => {
    const { dir } = await project();
    const first = formatAddResult(await addAddons(request(dir)), pnpm);
    expect(first.exitCode).toBe(0);
    expect(first.text).toContain("+ auth.ts");
    expect(first.text).toMatch(/~ server\.ts +auth: createAuth\(database\)/);
    expect(first.text).toContain(
      'Rows created before sign-in belong to the scope "default"',
    );
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "auth"],
      {
        cwd: dir,
      },
    );
    const before = hashes(dir);
    expect(formatAddResult(await addAddons(request(dir)), pnpm)).toEqual({
      text: "auth is already added. Nothing changed.",
      exitCode: 0,
    });
    expect(hashes(dir)).toEqual(before);
  });

  it("writes the files only with --no-install and names what is left", async () => {
    const { dir } = await project();
    const result = await addAddons(request(dir, { install: false }));
    expect(result).toMatchObject({
      kind: "applied",
      pending: ["pnpm add @parlor/auth@0.0.0", "pnpm parlor add auth"],
    });
    expect(await readFile(join(dir, "auth.ts"), "utf8")).toContain("createAuth");
  });
});
