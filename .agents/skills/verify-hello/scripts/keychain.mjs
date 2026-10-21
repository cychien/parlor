// The Keychain items a generated Mac app owns, by the exact names the Drive contract gives them.
// An ad-hoc build's items carry an ACL bound to that build's cdhash, so a later build reading them
// makes SecurityAgent ask for the login password: the driver deletes them before a Mac app
// launches and when its instance goes down. Items are deleted and probed by label, service, account
// and tag only; the Keychain is never listed and no secret is read.
import { spawn } from "node:child_process";

import { nativeTool } from "./webview.mjs";

export const SESSION_ACCOUNT = "parlor.session";
export const HELLO_APP_IDS = ["dev.parlor.hello", "dev.parlor.hellotwo"];
export const TAURI_CARGO_PACKAGE = "parlor_app";
const DELETE_TIMEOUT_MS = 20_000;

export class KeychainBlocked extends Error {}

export function webKitItemLabel(cargoPackage) {
  return `${cargoPackage} WebCrypto Master Key`;
}

export function deviceKeyNames(appId) {
  return [
    { label: `${appId} device signing key`, tag: `${appId}.device-key.signing` },
    { label: `${appId} device presence key`, tag: `${appId}.device-key.presence` },
  ];
}

/** Every item the app `{appId, cargoPackage}` owns: its device keys, its session item, WebKit's master key. */
export function appKeychainItems({ appId, cargoPackage }) {
  return [
    ...deviceKeyNames(appId).map((key) => ({ kind: "key", ...key })),
    { kind: "password", service: appId, account: SESSION_ACCOUNT },
    { kind: "password", label: webKitItemLabel(cargoPackage) },
  ];
}

export function describeItem(item) {
  if (item.kind === "key") return `key "${item.label}" (tag ${item.tag})`;
  if (item.service) return `password service ${item.service} account ${item.account}`;
  return `password "${item.label}"`;
}

function passwordArgs(item) {
  return item.service ? ["-s", item.service, "-a", item.account] : ["-l", item.label];
}

function runAsync(command, args, timeout) {
  return new Promise((settle) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      settle({ status, stdout, stderr, timedOut });
    });
  });
}

async function deleteItem(item, toolsDir) {
  if (item.kind === "key") {
    const result = await runAsync(
      nativeTool(toolsDir, "device-key"),
      ["delete", item.label, item.tag],
      DELETE_TIMEOUT_MS,
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = undefined;
    }
    if (result.timedOut || result.status !== 0 || !parsed)
      throw new KeychainBlocked(
        `deleting the Keychain ${describeItem(item)} ${result.timedOut ? `did not return within ${DELETE_TIMEOUT_MS / 1000} s` : `failed: ${(parsed?.message ?? result.stderr) || result.stdout}`}`,
      );
    return parsed.deleted;
  }
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const result = await runAsync(
      "security",
      ["delete-generic-password", ...passwordArgs(item)],
      DELETE_TIMEOUT_MS,
    );
    if (result.timedOut)
      throw new KeychainBlocked(
        `deleting the Keychain ${describeItem(item)} did not return within ${DELETE_TIMEOUT_MS / 1000} s`,
      );
    if (result.status === 44) break;
    if (result.status !== 0)
      throw new KeychainBlocked(
        `deleting the Keychain ${describeItem(item)} failed (${result.status}): ${result.stderr.trim()}`,
      );
    deleted++;
  }
  return deleted;
}

/** Deletes each of `items`; resolves with `[{item, deleted}]`, throws KeychainBlocked when macOS refuses or stalls. */
export async function deleteKeychainItems(items, { toolsDir }) {
  const results = [];
  for (const item of items)
    results.push({ item, deleted: await deleteItem(item, toolsDir) });
  return results;
}

export function deleteAppKeychain(identity, options) {
  return deleteKeychainItems(appKeychainItems(identity), options);
}

/** Whether `item` exists, from its attributes alone. */
export async function keychainItemExists(item, { toolsDir }) {
  if (item.kind === "key") {
    const result = await runAsync(
      nativeTool(toolsDir, "device-key"),
      ["exists", item.label, item.tag],
      DELETE_TIMEOUT_MS,
    );
    const parsed = JSON.parse(result.stdout.trim() || "{}");
    if (result.status !== 0 || typeof parsed.exists !== "boolean")
      throw new KeychainBlocked(
        `probing the Keychain ${describeItem(item)} failed: ${parsed.message ?? result.stderr}`,
      );
    return parsed.exists;
  }
  const result = await runAsync(
    "security",
    ["find-generic-password", ...passwordArgs(item)],
    DELETE_TIMEOUT_MS,
  );
  if (result.status === 0) return true;
  if (result.status === 44) return false;
  throw new KeychainBlocked(
    `probing the Keychain ${describeItem(item)} failed (${result.status}): ${result.stderr.trim()}`,
  );
}

export function summarizeDeletions(results) {
  return results
    .map(({ item, deleted }) => `${describeItem(item)}: ${deleted}`)
    .join(", ");
}
