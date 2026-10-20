#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import { register } from "tsx/esm/api";

register();
const { serveFakeAgent } = await import("../src/testing/fake-agent.ts");

const script = JSON.parse(readFileSync(process.argv[2], "utf8"));
const log = process.env.FAKE_AGENT_LOG;
const decoder = new TextDecoder();
let pending = "";

function record(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message?.method !== "string") return;
  const entry = { at: Date.now(), method: message.method, pid: process.pid };
  if (message.method === "session/prompt") {
    entry.text = (message.params?.prompt ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
  }
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

const stdin = Readable.toWeb(process.stdin);
const input = log
  ? stdin.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) record(line);
          controller.enqueue(chunk);
        },
      }),
    )
  : stdin;

await serveFakeAgent(script, { input, output: Writable.toWeb(process.stdout) });
process.exit(0);
