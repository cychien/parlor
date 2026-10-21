// Holds the WebKit remote inspector connection to an iOS simulator for one instance and
// evaluates expressions for `webview` calls on a Unix socket. One connection for the relay's
// lifetime, because webinspectord_sim shows no applications to a new connection while an
// older one is open or for several seconds after one closed; the page session on it is
// attached again whenever the app went away (a relaunch). Started on demand by webview.mjs;
// it exits after IDLE_MS without a request, when the simulator's daemon closes the connection,
// or on SIGTERM (`down` finds it by the socket path under the instance dir).
import { rmSync } from "node:fs";
import { createServer } from "node:net";

import { attachPage, connectInspector } from "./webkit-inspector.mjs";

const [udid, bundleId, socketPath] = process.argv.slice(2);
const IDLE_MS = 30 * 60_000;
const ATTACH_MS = 60_000;

const client = await connectInspector(udid);
let session;
let idle;

const shutdown = () => {
  rmSync(socketPath, { force: true });
  process.exit(0);
};
const touch = () => {
  clearTimeout(idle);
  idle = setTimeout(shutdown, IDLE_MS);
};

async function current() {
  if (session && !session.gone) return session;
  session?.detach();
  session = await attachPage(client, bundleId, {
    pickUrl: (url) => /^(https?|capacitor):/.test(url),
    timeout: ATTACH_MS,
  });
  return session;
}

async function evaluate(expression, ms) {
  for (let attempt = 0; ; attempt++) {
    const page = await current();
    try {
      return await page.evaluate(expression, ms);
    } catch (error) {
      if (error.page || attempt > 0 || client.closed) throw error;
      page.detach();
    }
  }
}

let queue = Promise.resolve();
const server = createServer((socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const { expression, ms } = JSON.parse(input.slice(0, input.indexOf("\n")));
    touch();
    queue = queue.then(async () => {
      let answer;
      try {
        answer = { ok: true, value: await evaluate(expression, ms ?? 120_000) };
      } catch (error) {
        answer = { ok: false, error: error.message, page: Boolean(error.page) };
      }
      socket.end(`${JSON.stringify(answer)}\n`);
      if (client.closed) shutdown();
    });
  });
  socket.on("error", () => {});
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, shutdown);
rmSync(socketPath, { force: true });
await current().catch(() => undefined);
server.listen(socketPath, () => {
  process.stdout.write(`relay for ${bundleId} on ${udid} ready\n`);
  touch();
});
