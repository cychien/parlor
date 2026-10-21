#!/usr/bin/env node
// Holds a CDP virtual authenticator on every page of one Chrome for as long as that Chrome runs.
// Chrome drops a tab's virtual authenticator, and the credentials on it, whenever any DevTools
// session attached to that tab detaches, so the holder keeps its own sessions open, snapshots
// each authenticator's credentials, and restores them when another client's detach wipes them.
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "cdp-port": { type: "string" },
    presence: { type: "string", default: "on" },
  },
});
const cdpPort = Number(values["cdp-port"]);
if (!(cdpPort > 0)) {
  process.stderr.write("usage: presence-holder.mjs --cdp-port N [--presence on|off]\n");
  process.exit(2);
}

const POLL_MS = 250;
const authenticatorOptions = (presence) => ({
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: presence,
  automaticPresenceSimulation: true,
});

let presence = values.presence === "on";
const targets = new Map();
const events = [];
const note = (event) => {
  events.push({ at: Date.now(), ...event });
  if (events.length > 200) events.shift();
};

const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
await new Promise((open, reject) => {
  socket.onopen = open;
  socket.onerror = () => reject(new Error(`cannot open ${version.webSocketDebuggerUrl}`));
});
socket.onclose = () => process.exit(0);

const send = (method, params = {}, sessionId) =>
  new Promise((settle, abort) => {
    nextId += 1;
    pending.set(nextId, { settle, abort });
    socket.send(
      JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  });

socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.abort(new Error(message.error.message));
    else request.settle(message.result);
    return;
  }
  void onEvent(message);
};

async function onEvent({ method, params, sessionId }) {
  if (method === "Target.targetCreated" && params.targetInfo.type === "page") {
    await attach(params.targetInfo);
  } else if (method === "Target.targetInfoChanged") {
    const held = targets.get(params.targetInfo.targetId);
    if (held) held.url = params.targetInfo.url;
  } else if (method === "Target.targetDestroyed") {
    targets.delete(params.targetId);
    attaching.delete(params.targetId);
  } else if (method === "Target.detachedFromTarget") {
    for (const [id, held] of targets)
      if (held.sessionId === params.sessionId) targets.delete(id);
  } else if (
    method === "WebAuthn.credentialAdded" ||
    method === "WebAuthn.credentialAsserted" ||
    method === "WebAuthn.credentialUpdated"
  ) {
    const held = [...targets.values()].find((t) => t.sessionId === sessionId);
    if (held) await snapshot(held);
  }
}

async function enable(held) {
  await send("WebAuthn.enable", { enableUI: false }, held.sessionId);
  const { authenticatorId } = await send(
    "WebAuthn.addVirtualAuthenticator",
    { options: authenticatorOptions(presence) },
    held.sessionId,
  );
  held.authenticatorId = authenticatorId;
}

const attaching = new Map();
const attached = () => Promise.all(attaching.values());

function attach(info) {
  if (!attaching.has(info.targetId)) attaching.set(info.targetId, attachNow(info));
  return attaching.get(info.targetId);
}

async function attachNow(info) {
  const held = {
    targetId: info.targetId,
    url: info.url,
    credentials: [],
    restores: 0,
  };
  targets.set(info.targetId, held);
  try {
    held.sessionId = (
      await send("Target.attachToTarget", { targetId: info.targetId, flatten: true })
    ).sessionId;
    await enable(held);
    note({ type: "attached", targetId: info.targetId, url: info.url });
  } catch (error) {
    held.error = error.message;
    note({
      type: "attach_failed",
      targetId: info.targetId,
      url: info.url,
      error: error.message,
    });
  }
}

async function snapshot(held) {
  const { credentials } = await send(
    "WebAuthn.getCredentials",
    { authenticatorId: held.authenticatorId },
    held.sessionId,
  );
  held.credentials = credentials;
}

async function restore(held) {
  await enable(held);
  for (const credential of held.credentials) {
    await send(
      "WebAuthn.addCredential",
      { authenticatorId: held.authenticatorId, credential },
      held.sessionId,
    );
  }
  held.restores += 1;
  note({
    type: "restored",
    targetId: held.targetId,
    url: held.url,
    credentials: held.credentials.length,
  });
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const held of targets.values()) {
      if (!held.authenticatorId) continue;
      try {
        await snapshot(held);
      } catch (error) {
        if (!/not been enabled|Could not find/i.test(error.message)) continue;
        try {
          await restore(held);
        } catch (failure) {
          note({
            type: "restore_failed",
            targetId: held.targetId,
            error: failure.message,
          });
        }
      }
    }
  } finally {
    polling = false;
  }
}

async function setPresence(on) {
  presence = on;
  for (const held of targets.values()) {
    if (!held.authenticatorId) continue;
    await send(
      "WebAuthn.setUserVerified",
      { authenticatorId: held.authenticatorId, isUserVerified: on },
      held.sessionId,
    );
    await send(
      "WebAuthn.setAutomaticPresenceSimulation",
      { authenticatorId: held.authenticatorId, enabled: true },
      held.sessionId,
    );
  }
  note({ type: "presence", presence: on ? "on" : "off" });
}

function report() {
  return {
    pid: process.pid,
    cdpPort,
    presence: presence ? "on" : "off",
    targets: [...targets.values()].map((held) => ({
      targetId: held.targetId,
      url: held.url,
      authenticator: Boolean(held.authenticatorId),
      credentials: held.credentials.length,
      restores: held.restores,
      error: held.error,
    })),
    events: events.slice(-40),
  };
}

await send("Target.setDiscoverTargets", { discover: true });
const { targetInfos } = await send("Target.getTargets");
for (const info of targetInfos.filter((t) => t.type === "page")) await attach(info);
await attached();
setInterval(() => void poll(), POLL_MS);

const server = createServer(async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(body)}\n`);
  };
  try {
    if (request.method === "GET" && request.url === "/state") return reply(200, report());
    const match =
      request.method === "POST" && request.url.match(/^\/presence\/(on|off)$/);
    if (match) {
      await attached();
      await poll();
      await setPresence(match[1] === "on");
      return reply(200, report());
    }
    return reply(404, { error: "not found" });
  } catch (error) {
    return reply(500, { error: error.message });
  }
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ ready: true, port: server.address().port, pid: process.pid })}\n`,
  );
});
process.on("SIGTERM", () => process.exit(0));
