import {
  DEV_USER_ID,
  type ThreadId,
  type TurnId,
  type UserId,
  userOf,
} from "@parlor/core";
import type { ChannelConnection, ServerChannel } from "@parlor/sync";

import type { ChatOwner, OpenItem, OpenTurn } from "../model.js";
import { applyFrame } from "../open-turns.js";
import { CHAT_CHANNEL, type ChatFrame, type HostStreamBatch } from "../protocol.js";
import type { TurnHolder } from "./store.js";

export const MAX_OPEN_BYTES_PER_TURN = 256 * 1024;
export const MAX_OPEN_TURNS = 1024;

/**
 * The live half of the chat: what is streaming now, carried to the `chat` channel of the
 * owner's own streams. Nothing here is the truth; drop it and every client still
 * converges on the log, only without token streaming. So it writes nothing and can be
 * replaced by a relay that crosses instances.
 */
export interface LiveRelay {
  readonly channel: ServerChannel;
  /** Applies a batch to the open turn and pushes it; a turn over its byte budget stops streaming. */
  accept(turn: TurnHolder, batch: HostStreamBatch): void;
  settle(owner: ChatOwner, threadId: ThreadId, turnId: TurnId): void;
  open(owner: ChatOwner, threadId: ThreadId): readonly OpenTurn[];
  close(): void;
}

interface OpenState {
  readonly owner: ChatOwner;
  readonly threadId: ThreadId;
  items: readonly OpenItem[];
  bytes: number;
  overBudget: boolean;
}

const SETTLED_MEMORY = 4 * MAX_OPEN_TURNS;
const encoder = new TextEncoder();

function ownerKey(scope: string, userId: UserId | undefined): string {
  return `${scope}\u001f${userId ?? DEV_USER_ID}`;
}

function sizeOf(frame: Extract<ChatFrame, { type: "delta" | "item" }>): number {
  return frame.type === "delta"
    ? encoder.encode(frame.text).length
    : encoder.encode(JSON.stringify(frame.item)).length;
}

/** The default: one instance, in memory. */
export function inProcessRelay(): LiveRelay {
  const connections = new Map<string, Set<ChannelConnection>>();
  const turns = new Map<TurnId, OpenState>();
  const settled = new Set<TurnId>();
  let closed = false;

  const push = (owner: ChatOwner, frame: ChatFrame) => {
    const audience = connections.get(ownerKey(owner.scope, owner.userId));
    if (!audience || audience.size === 0) return;
    const data = JSON.stringify(frame);
    for (const connection of audience) {
      try {
        connection.send(data);
      } catch {
        audience.delete(connection);
      }
    }
  };

  const channel: ServerChannel = {
    event: CHAT_CHANNEL,
    connect(connection) {
      if (closed || connection.closed?.aborted) return () => {};
      const key = ownerKey(connection.scope, userOf(connection.principal));
      let audience = connections.get(key);
      if (!audience) {
        audience = new Set();
        connections.set(key, audience);
      }
      audience.add(connection);
      const detach = () => {
        const current = connections.get(key);
        current?.delete(connection);
        if (current?.size === 0) connections.delete(key);
        connection.closed?.removeEventListener("abort", detach);
      };
      connection.closed?.addEventListener("abort", detach, { once: true });
      return detach;
    },
  };

  const forget = (turnId: TurnId) => {
    turns.delete(turnId);
    settled.add(turnId);
    if (settled.size > SETTLED_MEMORY) {
      const oldest = settled.values().next();
      if (!oldest.done) settled.delete(oldest.value);
    }
  };

  return {
    channel,
    accept(holder, batch) {
      if (closed || settled.has(batch.turnId)) return;
      let state = turns.get(batch.turnId);
      if (!state) {
        if (turns.size >= MAX_OPEN_TURNS) {
          const oldest = turns.keys().next();
          if (!oldest.done) turns.delete(oldest.value);
        }
        state = {
          owner: holder.owner,
          threadId: holder.threadId,
          items: [],
          bytes: 0,
          overBudget: false,
        };
        turns.set(batch.turnId, state);
      }
      for (const hostFrame of batch.frames) {
        const frame: Extract<ChatFrame, { type: "delta" | "item" }> = {
          ...hostFrame,
          threadId: state.threadId,
          turnId: batch.turnId,
        };
        const cost = sizeOf(frame);
        if (state.overBudget || state.bytes + cost > MAX_OPEN_BYTES_PER_TURN) {
          state.overBudget = true;
          break;
        }
        const applied = applyFrame(state.items, frame);
        if (!applied) continue;
        state.items = applied.items;
        state.bytes += cost;
        push(state.owner, applied.frame);
      }
    },
    settle(owner, threadId, turnId) {
      forget(turnId);
      push(owner, { type: "settled", threadId, turnId });
    },
    open(owner, threadId) {
      const open: OpenTurn[] = [];
      for (const [turnId, state] of turns) {
        if (
          state.threadId === threadId &&
          state.owner.scope === owner.scope &&
          state.owner.userId === owner.userId
        ) {
          open.push({ turnId, threadId, items: state.items });
        }
      }
      return open;
    },
    close() {
      closed = true;
      connections.clear();
      turns.clear();
    },
  };
}
