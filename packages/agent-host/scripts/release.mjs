#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { build } from "esbuild";

const NODE_VERSION = "24.19.0";
const NODE_ARCHIVE = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_SHA256 = "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d";
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PLATFORM = "darwin-arm64";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const require = createRequire(import.meta.url);

export function releaseBytes({ v, version, platform, sha256 }) {
  return Buffer.from(JSON.stringify({ platform, sha256, v, version }), "utf8");
}

function fail(message) {
  process.stderr.write(`release.mjs: ${message}\n`);
  process.exit(1);
}

function sha256Of(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .once("end", () => resolveHash(hash.digest("hex")))
      .once("error", reject);
  });
}

async function releaseKeyFrom(file) {
  const text = await readFile(file, "utf8").catch(() => fail(`cannot read ${file}.`));
  const jwk = (
    text.includes("PRIVATE KEY")
      ? createPublicKey(createPrivateKey(text))
      : createPublicKey(text)
  ).export({
    format: "jwk",
  });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") fail(`${file} is not an Ed25519 key.`);
  return jwk.x;
}

async function officialNode(cache) {
  const archive = join(cache, NODE_ARCHIVE);
  const verified = async () =>
    (await stat(archive).catch(() => undefined)) &&
    (await sha256Of(archive)) === NODE_SHA256;
  if (!(await verified())) {
    await mkdir(cache, { recursive: true });
    const response = await fetch(NODE_URL);
    if (!response.ok) fail(`${NODE_URL} answered HTTP ${response.status}.`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    if (!(await verified())) {
      await rm(archive, { force: true });
      fail(`${NODE_ARCHIVE} does not match its pinned SHA-256.`);
    }
  }
  const extracted = join(cache, `node-v${NODE_VERSION}-darwin-arm64`);
  await rm(extracted, { recursive: true, force: true });
  execFileSync("tar", ["-xzf", archive, "-C", cache]);
  return join(extracted, "bin", "node");
}

async function bundle(version, releaseKey, outFile) {
  await build({
    entryPoints: [join(packageDir, "src", "release-main.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: outFile,
    logLevel: "warning",
    define: {
      "import.meta.url": "__import_meta_url",
      "import.meta.dirname": "__dirname",
      "import.meta.filename": "__filename",
      "import.meta.env": "undefined",
      __PARLOR_RELEASE_KEY__: JSON.stringify(releaseKey),
      __PARLOR_HOST_VERSION__: JSON.stringify(version),
    },
    banner: {
      js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
  });
}

export async function buildRelease({ version, key, out, identity, cache }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail(
      `only ${PLATFORM} is built here, and this is ${process.platform}-${process.arch}.`,
    );
  }
  if (!VERSION.test(version))
    fail(`--version must be major.minor.patch, not "${version}".`);
  const releaseKeyFile = process.env.PARLOR_HOST_RELEASE_KEY_FILE;
  if (!releaseKeyFile) {
    fail("PARLOR_HOST_RELEASE_KEY_FILE names the public key this build trusts; set it.");
  }
  const signingKey = createPrivateKey(
    await readFile(key, "utf8").catch(() => fail(`cannot read the signing key ${key}.`)),
  );
  const trusted = await releaseKeyFrom(releaseKeyFile);

  const work = join(tmpdir(), `parlor-host-release-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const bundleFile = join(work, "bundle.cjs");
  const blob = join(work, "sea-prep.blob");
  const seaConfig = join(work, "sea-config.json");
  try {
    await bundle(version, trusted, bundleFile);
    const node = await officialNode(cache);
    await writeFile(
      seaConfig,
      JSON.stringify({
        main: bundleFile,
        output: blob,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      }),
    );
    execFileSync(node, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

    await mkdir(out, { recursive: true });
    const binary = join(out, "parlor-host");
    await rm(binary, { force: true });
    await copyFile(node, binary);
    await chmod(binary, 0o755);
    execFileSync("codesign", ["--remove-signature", binary], { stdio: "inherit" });
    execFileSync(
      process.execPath,
      [
        require.resolve("postject/dist/cli.js"),
        binary,
        "NODE_SEA_BLOB",
        blob,
        "--sentinel-fuse",
        SEA_FUSE,
        "--macho-segment-name",
        "NODE_SEA",
      ],
      { stdio: "inherit" },
    );
    execFileSync("codesign", ["--sign", identity, binary], { stdio: "inherit" });

    const body = { v: 1, version, platform: PLATFORM, sha256: await sha256Of(binary) };
    await writeFile(
      join(out, "parlor-host.sig"),
      `${JSON.stringify({ ...body, signature: sign(null, releaseBytes(body), signingKey).toString("base64url") })}\n`,
    );
    return { binary, ...body };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      key: { type: "string" },
      out: { type: "string" },
      identity: {
        type: "string",
        default: process.env.PARLOR_HOST_CODESIGN_IDENTITY ?? "-",
      },
      cache: {
        type: "string",
        default: join(homedir(), ".cache", "parlor-host-release"),
      },
    },
  });
  if (!values.version || !values.key || !values.out) {
    fail(
      "usage: release.mjs --version <x.y.z> --key <ed25519 private key pem> --out <dir>",
    );
  }
  const built = await buildRelease({
    version: values.version,
    key: resolve(values.key),
    out: resolve(values.out),
    identity: values.identity,
    cache: resolve(values.cache),
  });
  process.stdout.write(`${JSON.stringify({ event: "release", ...built })}\n`);
}
