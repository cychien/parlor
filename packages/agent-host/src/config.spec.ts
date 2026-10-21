import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/parlor-host-dev.mjs", import.meta.url));
const run = promisify(execFile);

let home: string;
const policyFile = () => join(home, ".parlor", "host", "policy.json");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "parlor-config-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const config = (...args: string[]) =>
  run(process.execPath, [BIN, "config", ...args], {
    env: { ...process.env, HOME: home },
  });

describe("parlor-host config", () => {
  it("sets where answers count in policy.json and prints the resulting policy", async () => {
    const { stdout } = await config("--answers", "computer");
    expect(JSON.parse(stdout)).toEqual({ deviceApproval: "local", answers: "computer" });
    expect(JSON.parse(await readFile(policyFile(), "utf8"))).toEqual({
      answers: "computer",
    });
    expect((await stat(policyFile())).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await config()).stdout)).toEqual({
      deviceApproval: "local",
      answers: "computer",
    });
    expect(JSON.parse((await config("--answers", "presence")).stdout)).toEqual({
      deviceApproval: "local",
      answers: "presence",
    });
  }, 30_000);

  it("refuses a setting the computer does not have, leaving the file as it was", async () => {
    await config("--answers", "computer");
    await expect(config("--answers", "off")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("--answers takes presence or computer."),
    });
    expect(JSON.parse(await readFile(policyFile(), "utf8"))).toEqual({
      answers: "computer",
    });
  }, 30_000);
});
