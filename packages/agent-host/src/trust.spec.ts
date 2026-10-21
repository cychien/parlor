import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asId } from "@parlor/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileTrustStore, type TrustedDevice } from "./trust.js";

const device = (id: string, name = "Chrome on macOS"): TrustedDevice => ({
  deviceId: asId("device", id),
  signingKey: { kty: "EC", crv: "P-256", x: `x-${id}`, y: `y-${id}` },
  presenceKey: {
    format: "webauthn",
    credentialId: `cred-${id}`,
    rpId: "hello.example",
    publicKey: { kty: "EC", crv: "P-256", x: "px", y: "py" },
  },
  name,
  platform: "web",
  approvedAt: 1,
  via: "local",
});

const A = "http://localhost:5301";
const B = "https://hello.example";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parlor-trust-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fileTrustStore", () => {
  it("pins a device's keys under the app origin and its id, in a 0600 file that survives a restart", async () => {
    const file = join(dir, ".parlor", "host", "trust.json");
    const store = fileTrustStore(file);
    expect(await store.get(A, "device-1")).toBeUndefined();
    await store.pin(A, device("device-1"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual([A]);
    expect(await fileTrustStore(file).get(A, "device-1")).toEqual(device("device-1"));
    expect(await store.get(B, "device-1")).toBeUndefined();
    expect(await store.get(A, "device-2")).toBeUndefined();
  });

  it("keeps every pin of several written at once, and replaces a device that is pinned again", async () => {
    const store = fileTrustStore(join(dir, "concurrent.json"));
    await Promise.all(
      ["a", "b", "c", "d"].map((id) => store.pin(id === "d" ? B : A, device(id))),
    );
    await store.pin(A, device("a", "Renamed"));
    expect((await store.get(A, "a"))?.name).toBe("Renamed");
    for (const [origin, id] of [
      [A, "b"],
      [A, "c"],
      [B, "d"],
    ] as const) {
      expect(await store.get(origin, id)).toBeDefined();
    }
  });

  it("forgets one device, or every device of an app", async () => {
    const store = fileTrustStore(join(dir, "forget.json"));
    await store.pin(A, device("a"));
    await store.pin(A, device("b"));
    await store.pin(B, device("a"));
    await store.forget(A, "a");
    expect(await store.get(A, "a")).toBeUndefined();
    expect(await store.get(A, "b")).toBeDefined();
    await store.forget(A);
    expect(await store.get(A, "b")).toBeUndefined();
    expect(await store.get(B, "a")).toBeDefined();
    await store.forget("https://unknown.example");
    await store.forget(B, "no-such-device");
    expect(await store.get(B, "a")).toBeDefined();
  });

  it("never mistakes an inherited property for a pin", async () => {
    const store = fileTrustStore(join(dir, "proto.json"));
    await store.pin(A, device("a"));
    for (const id of ["__proto__", "constructor", "toString"]) {
      expect(await store.get(A, id)).toBeUndefined();
    }
  });
});
