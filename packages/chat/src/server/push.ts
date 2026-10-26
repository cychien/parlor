import type { HostId, TurnId } from "@parlor/core";

import type { ChatOwner } from "../model.js";
import type { PushedTurn } from "../protocol.js";
import type { HostSession } from "./actions.js";
import type { LiveRelay } from "./live.js";
import type { ChatHost } from "./party.js";
import type { ChatDb } from "./store.js";

/** How long a pushed turn waits for its computer to confirm it before it goes back to the queue. */
export const PICKUP_MS = 5_000;

/**
 * Hands a turn to its computer the moment it is queued, saving the computer the round trip
 * of being woken and claiming it. Best effort: a turn it cannot push, or that the computer
 * never confirms, stays with or goes back to `hostClaim`.
 */
export interface TurnPush {
  /** A turn was just queued for `hostId`; claims it and pushes it if the computer is listening. */
  offer(owner: ChatOwner, hostId: HostId): void;
  /** The computer called about `turnId`, so it has the turn. */
  confirm(turnId: TurnId): void;
  close(): void;
}

export function turnPush(deps: {
  readonly relay: LiveRelay;
  readonly session: HostSession;
  readonly db: () => ChatDb;
  readonly pickupMs?: number | undefined;
}): TurnPush {
  const unconfirmed = new Map<TurnId, ReturnType<typeof setTimeout>>();

  const push = async (owner: ChatOwner, hostId: HostId) => {
    // The newest stream: during a handover the older one belongs to a draining service.
    const connection = deps.relay.computer(owner, hostId).at(-1);
    const principal = connection?.principal;
    if (!connection || principal?.kind !== "host") return;
    const host: ChatHost = {
      scope: connection.scope,
      userId: principal.userId,
      host: principal,
    };
    const turn = await deps.session.claim(host, deps.db());
    if (!turn) return;
    const frame: PushedTurn = { type: "claimed", turn };
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      await deps.session.release(host, turn.id, turn.turnId);
      return;
    }
    const timer = setTimeout(() => {
      unconfirmed.delete(turn.turnId);
      deps.session.release(host, turn.id, turn.turnId).catch((error: unknown) => {
        console.warn("[parlor] chat: returning an unconfirmed turn failed:", error);
      });
    }, deps.pickupMs ?? PICKUP_MS);
    (timer as { unref?: () => void }).unref?.();
    unconfirmed.set(turn.turnId, timer);
  };

  return {
    offer(owner, hostId) {
      push(owner, hostId).catch((error: unknown) => {
        console.warn(
          "[parlor] chat: pushing a turn failed; its computer claims it:",
          error,
        );
      });
    },
    confirm(turnId) {
      const timer = unconfirmed.get(turnId);
      if (!timer) return;
      clearTimeout(timer);
      unconfirmed.delete(turnId);
    },
    close() {
      for (const timer of unconfirmed.values()) clearTimeout(timer);
      unconfirmed.clear();
    },
  };
}
