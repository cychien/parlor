// Watches the screen for a native instance from up to down (see system-prompts.mjs): every
// second it lists the windows that need a human and are not expected, screenshots each new one
// and records it into the evidence directory (<id>.prompt-N.png, <id>.prompts.json), and keeps
// <instance>/prompts.json current. It exits when the instance's state.json is gone or on SIGTERM.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  promptText,
  readPromptState,
  unexpectedPrompts,
  writePromptState,
} from "./system-prompts.mjs";

const [harnessHome, instanceDir, evidenceDir, id] = process.argv.slice(2);
const POLL_MS = 1000;

const previous = readPromptState(instanceDir);
const seen = previous?.seen ?? [];
let active = [];

function save() {
  writePromptState(instanceDir, {
    watcherPid: process.pid,
    updatedAt: Date.now(),
    active,
    seen,
  });
}

function screenshot(prompt) {
  mkdirSync(evidenceDir, { recursive: true });
  const file = join(evidenceDir, `${id}.prompt-${seen.length + 1}.png`);
  const byWindow = spawnSync("screencapture", ["-x", `-l${prompt.windowId}`, file], {
    timeout: 10_000,
  });
  if (byWindow.status === 0 && existsSync(file)) return file;
  const { x, y, w, h } = prompt.frame;
  const region = [x, y, w, h].map((v) => Math.round(v)).join(",");
  const byRegion = spawnSync("screencapture", ["-x", `-R${region}`, file], {
    timeout: 10_000,
  });
  return byRegion.status === 0 && existsSync(file) ? file : undefined;
}

function stop() {
  active = [];
  if (existsSync(instanceDir)) save();
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
save();

for (;;) {
  if (!existsSync(join(instanceDir, "state.json"))) process.exit(0);
  let found = [];
  try {
    found = unexpectedPrompts(harnessHome);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} ${error.message}\n`);
  }
  const known = new Map(active.map((p) => [p.key, p]));
  active = found.map((prompt) => {
    const earlier = known.get(prompt.key);
    if (earlier) return earlier;
    const entry = {
      ...prompt,
      text: promptText(prompt),
      at: Date.now(),
      screenshot: screenshot(prompt),
    };
    seen.push(entry);
    writeFileSync(
      join(evidenceDir, `${id}.prompts.json`),
      `${JSON.stringify(seen, null, 2)}\n`,
    );
    process.stderr.write(
      `${new Date().toISOString()} ${entry.owner} "${entry.text}" -> ${entry.screenshot ?? "no screenshot"}\n`,
    );
    return entry;
  });
  save();
  await new Promise((settle) => setTimeout(settle, POLL_MS));
}
