// A WebKit remote inspector client for an app's webview on an iOS simulator: the protocol
// Safari's Develop menu speaks, over the simulator's webinspectord_sim Unix socket.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import { decodeBplist, encodeBplist } from "./bplist.mjs";

/** The webinspectord_sim socket of the booted simulator `udid`. */
export function simulatorInspectorSocket(udid) {
  const lsof = spawnSync("lsof", ["-aUc", "launchd_sim", "-F", "pn"], {
    encoding: "utf8",
  }).stdout;
  const sockets = new Map();
  let pid;
  for (const line of lsof.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    if (line[0] === "n" && line.includes("com.apple.webinspectord_sim.socket"))
      sockets.set(pid, line.slice(1).split(" ")[0]);
  }
  for (const [owner, path] of sockets) {
    const command = spawnSync("ps", ["-o", "command=", "-p", String(owner)], {
      encoding: "utf8",
    }).stdout;
    if (command.includes(udid)) return path;
  }
  throw new Error(
    `no webinspectord_sim socket for simulator ${udid} (found ${sockets.size} for other simulators)`,
  );
}

class Wire {
  constructor(path) {
    this.socket = createConnection(path);
    this.buffer = Buffer.alloc(0);
    this.listeners = new Set();
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length < 4 + length) break;
        const message = decodeBplist(this.buffer.subarray(4, 4 + length));
        this.buffer = this.buffer.subarray(4 + length);
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  send(selector, argument) {
    const body = encodeBplist({ __selector: selector, __argument: argument });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  wait(predicate, ms, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`webkit inspector: no ${what} within ${ms} ms`));
      }, ms);
      const listener = (message) => {
        const value = predicate(message);
        if (value === undefined) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(value);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    this.socket.destroy();
  }
}

/**
 * Opens the page of `bundleId` on simulator `udid` whose URL `pickUrl` accepts and returns
 * `{ evaluate(expression), page, close() }`; `evaluate` resolves the awaited value of the
 * expression, which must produce a string.
 */
export async function openInspector(
  udid,
  bundleId,
  { pickUrl = () => true, timeout = 15_000 } = {},
) {
  const wire = new Wire(simulatorInspectorSocket(udid));
  await wire.ready();
  const connection = randomUUID().toUpperCase();
  const sender = randomUUID().toUpperCase();
  const known = new Map();
  const remember = (m) => {
    if (m.__selector === "_rpc_reportConnectedApplicationList:")
      for (const app of Object.values(m.__argument.WIRApplicationDictionaryKey ?? {}))
        known.set(app.WIRApplicationIdentifierKey, app);
    if (
      m.__selector === "_rpc_applicationConnected:" ||
      m.__selector === "_rpc_applicationUpdated:"
    )
      known.set(m.__argument.WIRApplicationIdentifierKey, m.__argument);
    if (m.__selector === "_rpc_applicationDisconnected:")
      known.delete(m.__argument.WIRApplicationIdentifierKey);
  };
  wire.listeners.add(remember);
  wire.send("_rpc_reportIdentifier:", { WIRConnectionIdentifierKey: connection });
  const findHost = () =>
    [...known.values()].find((app) => app.WIRApplicationBundleIdentifierKey === bundleId);
  const hostDeadline = Date.now() + timeout;
  while (!findHost() && Date.now() < hostDeadline)
    await new Promise((r) => setTimeout(r, 100));
  const apps = [...known.values()];
  const host = findHost();
  if (!host) {
    wire.close();
    throw new Error(
      `${bundleId} is not inspectable on ${udid}; inspectable apps: ${apps.map((a) => a.WIRApplicationBundleIdentifierKey).join(", ") || "none"}`,
    );
  }
  await new Promise((r) => setTimeout(r, 200));
  const candidates = [...known.values()].filter(
    (app) =>
      app.WIRApplicationIdentifierKey === host.WIRApplicationIdentifierKey ||
      app.WIRHostApplicationIdentifierKey === host.WIRApplicationIdentifierKey,
  );
  let page;
  let appId;
  const deadline = Date.now() + timeout;
  while (!page && Date.now() < deadline) {
    for (const app of candidates) {
      const listing = wire
        .wait(
          (m) =>
            m.__selector === "_rpc_applicationSentListing:" &&
            m.__argument.WIRApplicationIdentifierKey === app.WIRApplicationIdentifierKey
              ? m.__argument.WIRListingKey
              : undefined,
          3000,
          "page listing",
        )
        .catch(() => ({}));
      wire.send("_rpc_forwardGetListing:", {
        WIRConnectionIdentifierKey: connection,
        WIRApplicationIdentifierKey: app.WIRApplicationIdentifierKey,
      });
      const pages = Object.values(await listing).filter(
        (p) =>
          ["WIRTypeWeb", "WIRTypeWebPage", "WIRTypePage"].includes(p.WIRTypeKey) &&
          pickUrl(p.WIRURLKey ?? ""),
      );
      if (pages.length) {
        page = pages[0];
        appId = app.WIRApplicationIdentifierKey;
        break;
      }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) {
    wire.close();
    throw new Error(`no inspectable page in ${bundleId} on ${udid}`);
  }
  const route = {
    WIRConnectionIdentifierKey: connection,
    WIRApplicationIdentifierKey: appId,
    WIRPageIdentifierKey: page.WIRPageIdentifierKey,
    WIRSenderKey: sender,
  };
  let partial = Buffer.alloc(0);
  const inbound = new Set();
  wire.listeners.add((m) => {
    if (m.__selector !== "_rpc_applicationSentData:") return;
    const data = m.__argument.WIRMessageDataKey;
    if (!data) return;
    partial = Buffer.concat([partial, data]);
    if (m.__argument.WIRPartialMessageKey && !m.__argument.WIRFinalMessageKey) return;
    const text = partial.toString("utf8");
    partial = Buffer.alloc(0);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    for (const listener of inbound) listener(message);
  });
  const nextMessage = (predicate, ms, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inbound.delete(listener);
        reject(new Error(`webkit inspector: no ${what} within ${ms} ms`));
      }, ms);
      const listener = (message) => {
        const value = predicate(message);
        if (value === undefined) return;
        clearTimeout(timer);
        inbound.delete(listener);
        resolve(value);
      };
      inbound.add(listener);
    });
  const targetCreated = nextMessage(
    (m) =>
      m.method === "Target.targetCreated" && m.params?.targetInfo?.type === "page"
        ? m.params.targetInfo.targetId
        : undefined,
    2500,
    "page target",
  ).catch(() => undefined);
  wire.send("_rpc_forwardSocketSetup:", { ...route, WIRAutomaticallyPause: false });
  const targetId = await targetCreated;

  let nextId = 1;
  const raw = (message) =>
    wire.send("_rpc_forwardSocketData:", {
      ...route,
      WIRSocketDataKey: Buffer.from(JSON.stringify(message), "utf8"),
    });
  const command = (method, params, ms = 120_000) => {
    const id = nextId++;
    if (!targetId) {
      const answer = nextMessage((m) => (m.id === id ? m : undefined), ms, method);
      raw({ id, method, params });
      return answer;
    }
    const answer = nextMessage(
      (m) => {
        if (m.method !== "Target.dispatchMessageFromTarget") return undefined;
        const inner = JSON.parse(m.params.message);
        return inner.id === id ? inner : undefined;
      },
      ms,
      method,
    );
    raw({
      id: nextId++,
      method: "Target.sendMessageToTarget",
      params: { targetId, message: JSON.stringify({ id, method, params }) },
    });
    return answer;
  };

  const evaluate = async (expression, ms = 120_000) => {
    const started = await command(
      "Runtime.evaluate",
      { expression, returnByValue: false, emulateUserGesture: true },
      ms,
    );
    if (started.error) throw new Error(started.error.message);
    let result = started.result;
    if (result.wasThrown) throw new Error(result.result?.description ?? "threw");
    if (result.result?.subtype === "promise" || result.result?.className === "Promise") {
      const awaited = await command(
        "Runtime.awaitPromise",
        { promiseObjectId: result.result.objectId, returnByValue: true },
        ms,
      );
      if (awaited.error) throw new Error(awaited.error.message);
      result = awaited.result;
      if (result.wasThrown) throw new Error(result.result?.description ?? "rejected");
    }
    return result.result?.value;
  };

  return {
    page: { url: page.WIRURLKey, title: page.WIRTitleKey, targetId: targetId ?? null },
    evaluate,
    close: async () => {
      wire.send("_rpc_forwardDidClose:", route);
      await new Promise((r) => setTimeout(r, 50));
      wire.close();
    },
  };
}
