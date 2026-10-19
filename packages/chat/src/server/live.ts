import type { ThreadId, TurnId } from "@parlor/core";
import type { ServerChannel } from "@parlor/sync";

import type { ChatOwner, OpenTurn } from "../model.js";
import type { HostStreamBatch } from "../protocol.js";
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

/** The default: one instance, in memory. */
export function inProcessRelay(): LiveRelay {
  // TODO: connections keyed by audienceOf(connection.scope, connection.principal), detached
  //   on return or connection.closed; open turns by turnId with a byte count, at most
  //   MAX_OPEN_TURNS (evict the oldest); accept applies delta at offset (skip duplicates,
  //   drop on gap), replaces tool and plan state, then sends ChatFrame to the owner's
  //   audience; settle forgets the turn and sends `settled`.
  throw new Error("not implemented");
}
