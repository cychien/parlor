import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimDevSession } from "./dev-session.js";

let root: string;
const file = () => join(root, ".parlor", "dev.json");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "parlor-dev-session-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("claimDevSession", () => {
  it("records this parlor dev and its URLs, and removes the record on release", () => {
    const claim = claimDevSession(root, ["web", "mac"]);
    claim.update(["http://localhost:5174", "http://localhost:5176"]);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      pid: process.pid,
      targets: ["web", "mac"],
      urls: ["http://localhost:5174", "http://localhost:5176"],
    });
    claim.release();
    expect(existsSync(file())).toBe(false);
  });

  it("refuses while another live parlor dev holds the project, naming it and the way out", async () => {
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      await mkdir(join(root, ".parlor"), { recursive: true });
      writeFileSync(
        file(),
        JSON.stringify({
          pid: other.pid,
          targets: ["web"],
          urls: ["http://localhost:5174"],
        }),
      );
      expect(() => claimDevSession(root, ["mac"])).toThrow(
        `parlor dev is already running for this project (web at http://localhost:5174, pid ${other.pid}). A second one would open the same database. Stop it first, run every target from one: parlor dev --target web,mac, or give the second its own directory: PARLOR_GENERATED_DIR=.parlor/second parlor dev.`,
      );
    } finally {
      other.kill();
    }
  });

  it("lets a run with its own PARLOR_GENERATED_DIR start beside the one in .parlor", async () => {
    const first = claimDevSession(root, ["web"]);
    vi.stubEnv("PARLOR_GENERATED_DIR", ".parlor/e2e");
    const second = claimDevSession(root, ["web"], process.pid + 1);
    expect(existsSync(file())).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, ".parlor", "e2e", "dev.json"), "utf8")),
    ).toEqual({
      pid: process.pid + 1,
      targets: ["web"],
      urls: [],
    });
    second.release();
    vi.unstubAllEnvs();
    first.release();
  });

  it("takes over a record whose process is gone", async () => {
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.once("exit", resolve));
    await mkdir(join(root, ".parlor"), { recursive: true });
    writeFileSync(file(), JSON.stringify({ pid: gone.pid, targets: ["web"], urls: [] }));
    claimDevSession(root, ["web"]).release();
    expect(existsSync(file())).toBe(false);
  });

  it("leaves a record it no longer owns in place on release", () => {
    const claim = claimDevSession(root, ["web"]);
    writeFileSync(file(), JSON.stringify({ pid: 1, targets: ["web"], urls: [] }));
    claim.release();
    expect(existsSync(file())).toBe(true);
  });
});
