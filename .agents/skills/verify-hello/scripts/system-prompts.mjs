// Windows that need a human: Keychain and authorization prompts, Touch ID, alerts drawn by
// UserNotificationCenter (CFUserNotification, TCC consent), Gatekeeper, the Simulator's own
// dialogs. Each native instance runs prompt-watcher.mjs, which records the ones on screen in
// <instance>/prompts.json; a driver call on that instance fails while one is active. A helper
// that raises and answers a dialog on purpose declares it with expectPrompt first.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { nativeTool } from "./webview.mjs";

const OWNERS = [
  "SecurityAgent",
  "coreautha",
  "UserNotificationCenter",
  "CoreServicesUIAgent",
  "universalAccessAuthWarn",
  "Simulator",
];
const SIMULATOR_DIALOGS = ["AXDialog", "AXSystemDialog"];
export const PROMPT_STATE = "prompts.json";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function promptTools(harnessHome) {
  return nativeTool(join(harnessHome, "tools"), "system-prompts");
}

function tool(harnessHome, args) {
  const result = spawnSync(promptTools(harnessHome), args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0)
    throw new Error(`system-prompts ${args[0]} failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

export function promptText(prompt) {
  const texts = [...new Set(prompt.texts.map((t) => t.trim()).filter(Boolean))];
  if (texts.length === 0) return "no text through Accessibility, see the screenshot";
  const text = texts.join(" / ");
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Every on-screen window that needs a human, expected or not. */
export function systemPrompts(harnessHome) {
  return tool(harnessHome, ["windows", ...OWNERS])
    .filter((w) => w.owner !== "Simulator" || SIMULATOR_DIALOGS.includes(w.subrole))
    .map((w) => ({ ...w, key: `${w.owner}:${w.pid}:${w.windowId}` }));
}

function expectedDir(harnessHome) {
  return join(harnessHome, "expected-prompts");
}

/**
 * Declares that this process raises a dialog of `owner` holding the static text `text` and answers
 * it itself, so watchers let it pass. Returns the function that withdraws the declaration.
 */
export function expectPrompt(harnessHome, { owner, text }) {
  const dir = expectedDir(harnessHome);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify({ owner, text, pid: process.pid, at: Date.now() }));
  return () => rmSync(file, { force: true });
}

export async function withExpectedPrompt(harnessHome, expected, task) {
  const withdraw = expectPrompt(harnessHome, expected);
  try {
    return await task();
  } finally {
    withdraw();
  }
}

export function expectedPrompts(harnessHome) {
  const dir = expectedDir(harnessHome);
  if (!existsSync(dir)) return [];
  const live = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (alive(entry.pid)) live.push(entry);
    else rmSync(file, { force: true });
  }
  return live;
}

export function isExpected(prompt, expected) {
  return expected.some(
    (e) => e.owner === prompt.owner && prompt.texts.some((t) => t.trim() === e.text),
  );
}

export function unexpectedPrompts(harnessHome) {
  const prompts = systemPrompts(harnessHome);
  if (prompts.length === 0) return [];
  const expected = expectedPrompts(harnessHome);
  return prompts.filter((p) => !isExpected(p, expected));
}

export function blockedMessage(prompt) {
  return `blocked by a system prompt: ${prompt.owner} "${promptText(prompt)}"${prompt.screenshot ? ` (screenshot ${prompt.screenshot})` : ""}`;
}

export function readPromptState(instanceDir) {
  try {
    return JSON.parse(readFileSync(join(instanceDir, PROMPT_STATE), "utf8"));
  } catch {
    return undefined;
  }
}

export function writePromptState(instanceDir, state) {
  const file = join(instanceDir, PROMPT_STATE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

export function watcherPid(instanceDir) {
  const state = readPromptState(instanceDir);
  return state?.watcherPid && alive(state.watcherPid) ? state.watcherPid : undefined;
}

/** The first prompt the instance's live watcher sees on screen now, if any. */
export function activePrompt(instanceDir) {
  const state = readPromptState(instanceDir);
  if (!state?.watcherPid || !alive(state.watcherPid)) return undefined;
  return state.active?.[0];
}

/** Presses Cancel (or Deny) on `prompt` through Accessibility, or sends it Escape. */
export function dismissPrompt(harnessHome, prompt) {
  const ax = nativeTool(join(harnessHome, "tools"), "webview-ax");
  const cancel = prompt.buttons.find((b) =>
    ["Cancel", "Deny", "Don't Allow", "取消", "拒絕", "不允許"].includes(b.name),
  );
  const result = cancel
    ? spawnSync(ax, ["press", String(prompt.pid), cancel.path], { encoding: "utf8" })
    : spawnSync(ax, ["type", String(prompt.pid), "\u001b", "10"], { encoding: "utf8" });
  return result.status === 0;
}
