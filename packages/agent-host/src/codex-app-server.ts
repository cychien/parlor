import { spawn } from "node:child_process";

import { onLines } from "./lines.js";

const INITIALIZE = 1;
const CALL = 2;
const TIMEOUT_MS = 30_000;
/** Codex only echoes it back inside a user agent. */
const CLIENT_INFO = { name: "parlor-host", version: "1" };

/**
 * One JSON-RPC call to a Codex app-server of its own, started for it and stopped after. For
 * what Codex keeps but `codex-acp` drops, such as the account's rate limits; it costs no
 * model turn. Undefined when anything goes wrong: Codex is missing, slow, or answers oddly.
 */
export function askCodex(
  binary: string,
  method: string,
  params: unknown,
  env: Readonly<Record<string, string>>,
): Promise<unknown> {
  return new Promise((resolve) => {
    let answer: unknown;
    const child = spawn(binary, ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    onLines(child.stdout, (line) => {
      let message: { readonly id?: unknown; readonly result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.id === INITIALIZE) send({ id: CALL, method, params });
      else if (message.id === CALL) {
        answer = message.result;
        child.kill();
      }
    });
    child.stdin.on("error", () => undefined);
    child.once("error", () => resolve(undefined));
    child.once("close", () => {
      clearTimeout(timer);
      resolve(answer);
    });
    send({ id: INITIALIZE, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}
