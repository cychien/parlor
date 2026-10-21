#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

const signing = process.env.PARLOR_HOST_SIGNING_KEY;
const trusted = process.env.PARLOR_HOST_RELEASE_KEY_FILE;
if (!signing || !trusted) {
  process.stderr.write(
    "Building the prebuilt Parlor Host needs PARLOR_HOST_SIGNING_KEY (the release private key, as a file path or its PEM text) and PARLOR_HOST_RELEASE_KEY_FILE (the public key this build trusts). There is no default key.\n",
  );
  process.exit(1);
}

const release = createRequire(import.meta.url).resolve(
  "@parlor/agent-host/scripts/release.mjs",
);
const keyDir = signing.includes("-----BEGIN")
  ? await mkdtemp(join(tmpdir(), "parlor-key-"))
  : undefined;
try {
  let keyFile = signing;
  if (keyDir) {
    keyFile = join(keyDir, "signing.pem");
    await writeFile(keyFile, signing, { mode: 0o600 });
  }
  const built = spawnSync(
    process.execPath,
    [release, "--version", version, "--key", keyFile, "--out", join(packageDir, "bin")],
    { stdio: "inherit" },
  );
  process.exitCode = built.status ?? 1;
} finally {
  if (keyDir) await rm(keyDir, { recursive: true, force: true });
}
