import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentConnection, AgentSession } from "./acp.js";
import type { ProxySession } from "./mcp-proxy.js";

export interface LiveSession {
  readonly session: AgentSession;
  readonly proxy: ProxySession;
}

/**
 * Processes per (app, agent), so two apps never share an agent process or its MCP
 * servers; sessions per (app, thread, agent), so a thread keeps its context across turns.
 */
export interface SessionPool {
  process(appOrigin: string, agentId: string): AgentConnection | undefined;
  /**
   * The running process, or the one `start` launches for every turn that asks meanwhile.
   * A `drop` during the launch aborts `signal` and kills whatever `start` returns.
   */
  launch(
    appOrigin: string,
    agentId: string,
    start: (signal: AbortSignal) => Promise<AgentConnection>,
  ): Promise<AgentConnection>;
  session(appOrigin: string, threadId: string, agentId: string): LiveSession | undefined;
  remember(
    appOrigin: string,
    threadId: string,
    agentId: string,
    session: LiveSession,
  ): void;
  /** The last session id, from `sessions.json`, for `session/resume` after a restart. */
  resumable(appOrigin: string, threadId: string, agentId: string): string | undefined;
  drop(appOrigin: string, agentId?: string): Promise<void>;
}

const keyOf = (...parts: readonly string[]) => parts.join("\u0000");

function readRemembered(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

interface Launching {
  readonly controller: AbortController;
  readonly connection: Promise<AgentConnection>;
}

/**
 * Sessions live inside their process: `launch()` hands out the connection with its
 * sessions tracked, so dropping a process forgets every session it held.
 */
export function createSessionPool(stateFile: string): SessionPool {
  const processes = new Map<string, AgentConnection>();
  const launching = new Map<string, Launching>();
  const owners = new WeakMap<AgentSession, string>();
  const sessions = new Map<
    string,
    { readonly live: LiveSession; readonly owner: string }
  >();
  const remembered = readRemembered(stateFile);
  let saving: Promise<unknown> = Promise.resolve();

  const save = () => {
    const snapshot = `${JSON.stringify(remembered, null, 2)}\n`;
    saving = saving
      .then(async () => {
        await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
        const staged = `${stateFile}.${process.pid}.tmp`;
        await writeFile(staged, snapshot, { mode: 0o600 });
        await rename(staged, stateFile);
      })
      .catch(() => undefined);
  };

  const forget = (owner: string) => {
    processes.delete(owner);
    for (const [key, entry] of sessions) {
      if (entry.owner !== owner) continue;
      entry.live.proxy.dispose();
      sessions.delete(key);
    }
  };

  const adopt = (owner: string, connection: AgentConnection): AgentConnection => {
    const tracked: AgentConnection = {
      capabilities: connection.capabilities,
      exited: connection.exited,
      kill: () => connection.kill(),
      openSession: async (input) => {
        const session = await connection.openSession(input);
        owners.set(session, owner);
        return session;
      },
    };
    processes.set(owner, tracked);
    void connection.exited.then(() => {
      if (processes.get(owner) === tracked) forget(owner);
    });
    return tracked;
  };

  const ownedBy = (appOrigin: string, agentId: string | undefined) => (owner: string) =>
    agentId === undefined
      ? owner.startsWith(keyOf(appOrigin, ""))
      : owner === keyOf(appOrigin, agentId);

  return {
    process: (appOrigin, agentId) => processes.get(keyOf(appOrigin, agentId)),
    launch(appOrigin, agentId, start) {
      const owner = keyOf(appOrigin, agentId);
      const running = processes.get(owner);
      if (running) return Promise.resolve(running);
      const pending = launching.get(owner);
      if (pending) return pending.connection;
      const controller = new AbortController();
      const connection = (async () => {
        try {
          const started = await start(controller.signal);
          if (controller.signal.aborted) {
            await started.kill();
            throw new Error(
              "This computer stopped serving the app while the agent started.",
            );
          }
          return adopt(owner, started);
        } finally {
          if (launching.get(owner)?.controller === controller) launching.delete(owner);
        }
      })();
      launching.set(owner, { controller, connection });
      return connection;
    },
    session: (appOrigin, threadId, agentId) =>
      sessions.get(keyOf(appOrigin, threadId, agentId))?.live,
    remember(appOrigin, threadId, agentId, live) {
      const owner = keyOf(appOrigin, agentId);
      if (owners.get(live.session) !== owner || processes.get(owner) === undefined) {
        throw new Error("Remember a session opened through the pool's own process.");
      }
      const key = keyOf(appOrigin, threadId, agentId);
      sessions.set(key, { live, owner });
      remembered[key] = live.session.id;
      save();
    },
    resumable: (appOrigin, threadId, agentId) =>
      remembered[keyOf(appOrigin, threadId, agentId)],
    async drop(appOrigin, agentId) {
      const owned = ownedBy(appOrigin, agentId);
      for (const [owner, pending] of launching) {
        if (!owned(owner)) continue;
        launching.delete(owner);
        pending.controller.abort();
      }
      const dropped = [...processes].filter(([owner]) => owned(owner));
      for (const [owner] of dropped) forget(owner);
      await Promise.all(dropped.map(([, connection]) => connection.kill()));
    },
  };
}
