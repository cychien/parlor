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
 * servers; sessions per (thread, agent), so a thread keeps its context across turns.
 */
export interface SessionPool {
  process(appOrigin: string, agentId: string): AgentConnection | undefined;
  adopt(appOrigin: string, agentId: string, connection: AgentConnection): void;
  session(threadId: string, agentId: string): LiveSession | undefined;
  remember(threadId: string, agentId: string, session: LiveSession): void;
  /** The last session id, from `sessions.json`, for `session/resume` after a restart. */
  resumable(threadId: string, agentId: string): string | undefined;
  drop(appOrigin: string, agentId?: string): Promise<void>;
}

const keyOf = (first: string, second: string) => `${first}\u0000${second}`;

function readRemembered(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Sessions live inside their process: `process()` hands out the adopted connection with
 * its sessions tracked, so dropping a process forgets every session it held.
 */
export function createSessionPool(stateFile: string): SessionPool {
  const processes = new Map<string, AgentConnection>();
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

  return {
    process: (appOrigin, agentId) => processes.get(keyOf(appOrigin, agentId)),
    adopt(appOrigin, agentId, connection) {
      const owner = keyOf(appOrigin, agentId);
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
    },
    session: (threadId, agentId) => sessions.get(keyOf(threadId, agentId))?.live,
    remember(threadId, agentId, live) {
      const owner = owners.get(live.session);
      if (owner === undefined || processes.get(owner) === undefined) {
        throw new Error("Remember a session opened through the pool's own process.");
      }
      const key = keyOf(threadId, agentId);
      sessions.set(key, { live, owner });
      remembered[key] = live.session.id;
      save();
    },
    resumable: (threadId, agentId) => remembered[keyOf(threadId, agentId)],
    async drop(appOrigin, agentId) {
      const dropped = [...processes].filter(
        ([owner]) =>
          owner.startsWith(`${appOrigin}\u0000`) &&
          (agentId === undefined || owner === keyOf(appOrigin, agentId)),
      );
      for (const [owner] of dropped) forget(owner);
      await Promise.all(dropped.map(([, connection]) => connection.kill()));
    },
  };
}
