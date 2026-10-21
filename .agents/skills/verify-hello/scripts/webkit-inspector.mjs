// A WebKit remote inspector client for an app's webview on an iOS simulator: the protocol
// Safari's Develop menu speaks, over the simulator's webinspectord_sim Unix socket.
//
// webinspectord_sim lists no applications to a new connection while an older debugger
// connection is open or for several seconds after one closed, so a client keeps one
// connection (`connectInspector`) and attaches to the page on it as often as it needs
// (`attachPage`), for example again after the app relaunched.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One connection to the simulator's inspector daemon, with the applications it reports. */
export async function connectInspector(udid) {
  const socket = createConnection(simulatorInspectorSocket(udid));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const listeners = new Set();
  const apps = new Map();
  let buffer = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const message = decodeBplist(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      const id = message.__argument?.WIRApplicationIdentifierKey;
      if (message.__selector === "_rpc_reportConnectedApplicationList:")
        for (const app of Object.values(
          message.__argument.WIRApplicationDictionaryKey ?? {},
        ))
          apps.set(app.WIRApplicationIdentifierKey, app);
      if (
        ["_rpc_applicationConnected:", "_rpc_applicationUpdated:"].includes(
          message.__selector,
        )
      )
        apps.set(id, message.__argument);
      if (message.__selector === "_rpc_applicationDisconnected:") apps.delete(id);
      for (const listener of listeners) listener(message);
    }
  });
  socket.on("close", () => {
    closed = true;
    for (const listener of listeners) listener({ __selector: "__closed" });
  });
  socket.on("error", () => {});
  const connection = randomUUID().toUpperCase();
  const send = (selector, argument) => {
    const body = encodeBplist({ __selector: selector, __argument: argument });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  send("_rpc_reportIdentifier:", { WIRConnectionIdentifierKey: connection });
  return {
    connection,
    apps,
    listeners,
    send,
    get closed() {
      return closed;
    },
    close: () => socket.destroy(),
  };
}

/**
 * Attaches to the page of `bundleId` whose URL `pickUrl` accepts and returns
 * `{ page, evaluate(expression, ms), gone, detach() }`. `evaluate` resolves the awaited value
 * of the expression; a page exception rejects with `error.page` set. `gone` is a reason once
 * the app disconnected or the connection closed, and every pending call then rejects.
 */
export async function attachPage(
  client,
  bundleId,
  { pickUrl = () => true, timeout = 15_000 } = {},
) {
  const deadline = Date.now() + timeout;
  let host;
  while (
    !(host = [...client.apps.values()].find(
      (a) => a.WIRApplicationBundleIdentifierKey === bundleId,
    ))
  ) {
    if (client.closed || Date.now() > deadline)
      throw new Error(
        `${bundleId} is not inspectable; inspectable apps: ${[...client.apps.values()].map((a) => a.WIRApplicationBundleIdentifierKey).join(", ") || "none"}`,
      );
    await sleep(100);
  }
  const listing = (app) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.listeners.delete(listener);
        resolve({});
      }, 3000);
      const listener = (m) => {
        if (
          m.__selector !== "_rpc_applicationSentListing:" ||
          m.__argument.WIRApplicationIdentifierKey !== app
        )
          return;
        clearTimeout(timer);
        client.listeners.delete(listener);
        resolve(m.__argument.WIRListingKey ?? {});
      };
      client.listeners.add(listener);
      client.send("_rpc_forwardGetListing:", {
        WIRConnectionIdentifierKey: client.connection,
        WIRApplicationIdentifierKey: app,
      });
    });
  let page;
  let appId;
  while (!page) {
    const candidates = [...client.apps.values()].filter(
      (a) =>
        a.WIRApplicationIdentifierKey === host.WIRApplicationIdentifierKey ||
        a.WIRHostApplicationIdentifierKey === host.WIRApplicationIdentifierKey,
    );
    for (const app of candidates) {
      const pages = Object.values(await listing(app.WIRApplicationIdentifierKey)).filter(
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
    if (page) break;
    if (client.closed || Date.now() > deadline)
      throw new Error(`no inspectable page in ${bundleId}`);
    await sleep(500);
  }

  const route = {
    WIRConnectionIdentifierKey: client.connection,
    WIRApplicationIdentifierKey: appId,
    WIRPageIdentifierKey: page.WIRPageIdentifierKey,
    WIRSenderKey: randomUUID().toUpperCase(),
  };
  const inbound = new Set();
  const pending = new Set();
  let partial = Buffer.alloc(0);
  let gone;
  let targetId;
  const markGone = (why) => {
    if (gone) return;
    gone = why;
    for (const reject of pending) reject(new Error(`webkit inspector: ${why}`));
  };
  const relay = (m) => {
    if (m.__selector === "__closed") return markGone("the inspector connection closed");
    const id = m.__argument?.WIRApplicationIdentifierKey;
    if (
      m.__selector === "_rpc_applicationDisconnected:" &&
      (id === appId || id === host.WIRApplicationIdentifierKey)
    )
      return markGone(`${bundleId} disconnected`);
    if (m.__selector !== "_rpc_applicationSentData:") return;
    if (
      m.__argument.WIRDestinationKey &&
      m.__argument.WIRDestinationKey !== route.WIRSenderKey
    )
      return;
    const data = m.__argument.WIRMessageDataKey;
    if (!data) return;
    partial = Buffer.concat([partial, data]);
    if (m.__argument.WIRPartialMessageKey && !m.__argument.WIRFinalMessageKey) return;
    let message;
    try {
      message = JSON.parse(partial.toString("utf8"));
    } catch {
      partial = Buffer.alloc(0);
      return;
    }
    partial = Buffer.alloc(0);
    if (
      message.method === "Target.targetCreated" &&
      message.params?.targetInfo?.type === "page"
    )
      targetId = message.params.targetInfo.targetId;
    if (message.method === "Target.didCommitProvisionalTarget")
      targetId = message.params?.newTargetId ?? targetId;
    for (const listener of inbound) listener(message);
  };
  client.listeners.add(relay);

  const next = (predicate, ms, what) =>
    new Promise((resolve, reject) => {
      if (gone) {
        reject(new Error(`webkit inspector: ${gone}`));
        return;
      }
      const done = () => {
        clearTimeout(timer);
        inbound.delete(listener);
        pending.delete(fail);
      };
      const fail = (error) => {
        done();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`webkit inspector: no ${what} within ${ms} ms`)),
        ms,
      );
      const listener = (message) => {
        const value = predicate(message);
        if (value === undefined) return;
        done();
        resolve(value);
      };
      inbound.add(listener);
      pending.add(fail);
    });

  const firstTarget = next(
    (m) =>
      m.method === "Target.targetCreated" && m.params?.targetInfo?.type === "page"
        ? true
        : undefined,
    2500,
    "page target",
  ).catch(() => undefined);
  client.send("_rpc_forwardSocketSetup:", { ...route, WIRAutomaticallyPause: false });
  await firstTarget;

  let nextId = 1;
  const raw = (message) =>
    client.send("_rpc_forwardSocketData:", {
      ...route,
      WIRSocketDataKey: Buffer.from(JSON.stringify(message), "utf8"),
    });
  const command = (method, params, ms) => {
    const id = nextId++;
    if (!targetId) {
      const answer = next((m) => (m.id === id ? m : undefined), ms, method);
      raw({ id, method, params });
      return answer;
    }
    const answer = next(
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
  const pageError = (message) => Object.assign(new Error(message), { page: true });

  const evaluate = async (expression, ms = 120_000) => {
    const started = await command(
      "Runtime.evaluate",
      { expression, returnByValue: false, emulateUserGesture: true },
      ms,
    );
    if (started.error) throw new Error(started.error.message);
    let result = started.result;
    if (result.wasThrown) throw pageError(result.result?.description ?? "threw");
    if (result.result?.subtype === "promise" || result.result?.className === "Promise") {
      const awaited = await command(
        "Runtime.awaitPromise",
        { promiseObjectId: result.result.objectId, returnByValue: true },
        ms,
      );
      if (awaited.error) throw new Error(awaited.error.message);
      result = awaited.result;
      if (result.wasThrown) throw pageError(result.result?.description ?? "rejected");
    }
    return result.result?.value;
  };

  return {
    page: { url: page.WIRURLKey, title: page.WIRTitleKey },
    evaluate,
    get gone() {
      return gone;
    },
    detach() {
      markGone("detached");
      client.listeners.delete(relay);
      if (!client.closed) client.send("_rpc_forwardDidClose:", route);
    },
  };
}
