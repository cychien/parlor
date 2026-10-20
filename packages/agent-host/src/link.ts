import {
  CHAT_TAG,
  HOST_PROTOCOL,
  type HostFrame,
  type HostStreamBatch,
  type HostWelcome,
} from "@parlor/chat";
import type { ChatHostActionMap } from "@parlor/chat/server";
import {
  createActionClient,
  createPluginClient,
  type PluginClient,
} from "@parlor/client";
import type { TurnId } from "@parlor/core";
import { createSyncClient, type SyncClient } from "@parlor/sync/client";

import type { AppGrant, HostKeys } from "./grants.js";
import { logEvent } from "./log.js";

export const RECONNECT_MAX_MS = 4_000;
export const ACTIVE_POLL_MS = 2_000;
export const IDLE_POLL_MS = 15_000;

export interface HostApi {
  readonly calls: PluginClient<ChatHostActionMap>;
  /** At most one post in flight per turn; frames produced meanwhile coalesce into the next. */
  stream(batch: HostStreamBatch): void;
  heartbeat(): Promise<void>;
}

export interface AppLinkDeps {
  readonly keys: HostKeys;
  readonly hostVersion: string;
  readonly hostName: string;
  readonly platform: string;
  readonly fetch: typeof fetch;
  /** A turn may be waiting: claim until not_found, then ask for running turns' signals. */
  readonly onWake: (link: AppLink) => void;
  /** Any 401, or the stream closed for revocation. */
  readonly onRevoked: (grant: AppGrant) => void;
  /** No shared protocol: shown locally ("update Parlor Host"); the link stays down. */
  readonly onIncompatible: (
    grant: AppGrant,
    welcome: Extract<HostWelcome, { readonly accepted: false }>,
  ) => void;
}

/** The host's whole conversation with one app, each request carrying a fresh assertion. */
export interface AppLink {
  readonly grant: AppGrant;
  readonly api: HostApi;
  /** Set once `hostHello` was welcomed; every other call waits for it. */
  readonly protocol: number | undefined;
  start(): void;
  stop(options?: { readonly revoke?: boolean | undefined }): Promise<void>;
}

type Accepted = Extract<HostWelcome, { readonly accepted: true }>;

const RETRY_BASE_MS = 250;
/** Under the server's 64 KB stream body limit with room for the envelope. */
const MAX_BATCH_BYTES = 48 * 1024;

class LinkDown extends Error {
  override readonly name = "LinkDown";
}

interface TurnStream {
  pending: HostFrame[];
  posting: Promise<void> | undefined;
}

/** Adjacent deltas of one item merge into one, so a busy stream posts fewer, larger frames. */
function coalesce(frames: readonly HostFrame[]): HostFrame[] {
  const merged: HostFrame[] = [];
  for (const frame of frames) {
    const last = merged.at(-1);
    if (
      last?.type === "delta" &&
      frame.type === "delta" &&
      last.itemId === frame.itemId &&
      last.offset + last.text.length === frame.offset
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + frame.text };
    } else {
      merged.push(frame);
    }
  }
  return merged;
}

function batches(frames: readonly HostFrame[]): HostFrame[][] {
  const out: HostFrame[][] = [];
  let current: HostFrame[] = [];
  let bytes = 0;
  for (const frame of frames) {
    const size = JSON.stringify(frame).length;
    if (current.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(frame);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAppLink(grant: AppGrant, deps: AppLinkDeps): AppLink {
  const origin = grant.appOrigin.replace(/\/+$/, "");
  let welcome: Accepted | undefined;
  let running = false;
  let down = false;
  let revoked = false;
  let sync: SyncClient | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const streams = new Map<TurnId, TurnStream>();

  let admit: () => void = () => undefined;
  let refuse: (error: Error) => void = () => undefined;
  const welcomed = new Promise<void>((resolve, reject) => {
    admit = resolve;
    refuse = reject;
  });
  welcomed.catch(() => undefined);

  const signedFetch: typeof fetch = async (input, init) => {
    if (down) throw new LinkDown("This app's link is closed.");
    const request = new Request(input, init);
    const method = request.method === "GET" ? "GET" : "POST";
    const assertion = await deps.keys.assert(origin, { method, url: request.url });
    const headers = new Headers(request.headers);
    headers.set("authorization", `ParlorHost ${assertion}`);
    const response = await deps.fetch(new Request(request, { headers }));
    logEvent("http_request", {
      method,
      path: new URL(request.url).pathname,
      status: response.status,
    });
    if (response.status === 401 && !revoked && !down) {
      revoked = true;
      queueMicrotask(() => deps.onRevoked(grant));
    }
    return response;
  };

  const plugin = createPluginClient<ChatHostActionMap>(
    createActionClient({ baseUrl: origin, fetch: signedFetch }),
    "chat",
  );

  const drained = async (turnId: TurnId | undefined) => {
    if (turnId === undefined) return;
    while (true) {
      const posting = streams.get(turnId)?.posting;
      if (!posting) return;
      await posting;
    }
  };

  const invoke: PluginClient<ChatHostActionMap>["invoke"] = async (
    name,
    input,
    options,
  ) => {
    if (name !== "hostHello") await welcomed;
    if (name === "hostAppend" || name === "hostFinish") {
      await drained((input as { readonly turnId?: TurnId }).turnId);
    }
    return plugin.invoke(name, input, options);
  };
  const calls: PluginClient<ChatHostActionMap> = {
    invoke,
    call: async (name, input, options) => (await invoke(name, input, options)).data,
  };

  const post = (path: string, body: unknown) =>
    signedFetch(`${origin}/_parlor/chat/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const flush = async (turnId: TurnId, stream: TurnStream) => {
    while (stream.pending.length > 0) {
      if (down) break;
      const frames = coalesce(stream.pending);
      stream.pending = [];
      for (const chunk of batches(frames)) {
        await post("stream", { turnId, frames: chunk }).catch(() => undefined);
      }
    }
    stream.posting = undefined;
    if (stream.pending.length === 0) streams.delete(turnId);
  };

  const api: HostApi = {
    calls,
    stream(batch) {
      if (down || batch.frames.length === 0) return;
      let stream = streams.get(batch.turnId);
      if (!stream) {
        stream = { pending: [], posting: undefined };
        streams.set(batch.turnId, stream);
      }
      stream.pending.push(...batch.frames);
      if (!stream.posting) stream.posting = flush(batch.turnId, stream);
    },
    async heartbeat() {
      await welcomed;
      await post("heartbeat", {});
    },
  };

  const close = () => {
    down = true;
    sync?.stop();
    sync = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    refuse(new LinkDown("This app's link is closed."));
  };

  const hello = async (): Promise<HostWelcome | undefined> => {
    for (let attempt = 0; ; attempt += 1) {
      if (!running || down) return undefined;
      try {
        return await plugin.call("hostHello", {
          protocols: { min: 1, max: HOST_PROTOCOL },
          hostVersion: deps.hostVersion,
          name: deps.hostName,
          platform: deps.platform,
          agents: [],
        });
      } catch {
        if (revoked || down) return undefined;
        await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS));
      }
    }
  };

  const link: AppLink = {
    grant,
    api,
    get protocol() {
      return welcome?.protocol;
    },
    start() {
      if (running) return;
      running = true;
      void hello().then((answer) => {
        if (!answer || down) return;
        if (!answer.accepted) {
          close();
          logEvent("link_closed", { appOrigin: origin, reason: "incompatible" });
          deps.onIncompatible(grant, answer);
          return;
        }
        welcome = answer;
        admit();
        sync = createSyncClient({
          request: (path, init) => signedFetch(`${origin}${path}`, init),
          coalesceMs: 0,
          reconnectMaxMs: RECONNECT_MAX_MS,
          onEvents: (events) => {
            if (events.some((event) => event.tags.some((tag) => tag[0] === CHAT_TAG))) {
              deps.onWake(link);
            }
          },
          onUnauthorized: () => undefined,
          onError: () => undefined,
        });
        sync.start();
        heartbeat = setInterval(
          () => void api.heartbeat().catch(() => undefined),
          answer.heartbeatMs,
        );
        heartbeat.unref();
        deps.onWake(link);
      });
    },
    async stop(options = {}) {
      running = false;
      if (options.revoke && !down) {
        await signedFetch(`${origin}/_parlor/auth/hosts/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }).catch(() => undefined);
      }
      close();
    },
  };
  return link;
}
