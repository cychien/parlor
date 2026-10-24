import { ActionError, type HostId } from "@parlor/core";
import { type AnyPluginRoute, pluginRoute, readBoundedText } from "@parlor/server";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import type { ChatOwner } from "../model.js";
import type { HostStreamBatch } from "../protocol.js";
import type { LiveRelay } from "./live.js";
import type { ChatDb, ChatStore } from "./store.js";

export const MAX_STREAM_BODY_BYTES = 64 * 1024;
const MAX_FRAMES_PER_BATCH = 512;

export interface ChatRouteDeps {
  readonly db: () => ChatDb;
  readonly store: ChatStore;
  readonly relay: LiveRelay;
  readonly heartbeatMs: number;
  readonly reconcile: (owner: ChatOwner) => Promise<void>;
  readonly announceHost: (owner: ChatOwner, hostId: HostId) => Promise<void>;
}

const streamBatch = z.object({
  turnId: idSchema("turn"),
  frames: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("delta"),
          itemId: idSchema("item"),
          kind: z.enum(["reply", "reasoning"]),
          offset: z.number().int().min(0),
          text: z.string(),
        }),
        z.object({
          type: z.literal("item"),
          item: z.discriminatedUnion("kind", [
            z.object({
              id: idSchema("item"),
              kind: z.literal("tool"),
              title: z.string(),
              status: z.enum(["pending", "running"]),
            }),
            z.object({
              id: idSchema("item"),
              kind: z.literal("plan"),
              entries: z.array(
                z.object({
                  content: z.string(),
                  status: z.enum(["pending", "in_progress", "completed"]),
                }),
              ),
            }),
          ]),
        }),
      ]),
    )
    .max(MAX_FRAMES_PER_BATCH),
}) satisfies z.ZodType<HostStreamBatch>;

const tooLarge = () =>
  Response.json(
    {
      error: {
        code: "invalid_input",
        message: `A stream batch is at most ${MAX_STREAM_BODY_BYTES} bytes.`,
      },
    },
    { status: 413 },
  );

/** Plain routes only a host principal reaches, by type: no browser session, no agent token. */
export function chatRoutes(deps: ChatRouteDeps): readonly AnyPluginRoute[] {
  return [
    pluginRoute({
      method: "POST",
      path: "/stream",
      access: ["host"],
      handle: async (request, caller) => {
        const text = await readBoundedText(request, MAX_STREAM_BODY_BYTES);
        if (text === undefined) return tooLarge();
        const parsed = streamBatch.safeParse(parseJson(text));
        if (!parsed.success) {
          throw new ActionError("invalid_input", "Not a stream batch", {
            issues: parsed.error.issues,
          });
        }
        const batch = parsed.data;
        const holder = await deps.store.turnHolder(deps.db(), batch.turnId);
        const { principal } = caller;
        const owns =
          holder !== undefined &&
          holder.hostId === principal.hostId &&
          holder.owner.userId === principal.userId &&
          holder.owner.scope === caller.scope;
        if (!owns) throw new ActionError("forbidden", "This turn is not yours.");
        const { live, ...heldBy } = holder;
        if (!live) throw new ActionError("forbidden", "The turn is not running.");
        deps.relay.accept(heldBy, batch);
        return new Response(null, { status: 204 });
      },
    }),
    pluginRoute({
      method: "POST",
      path: "/heartbeat",
      access: ["host"],
      handle: async (_request, caller) => {
        const { principal } = caller;
        const owner = { scope: caller.scope, userId: principal.userId };
        const { returned } = await deps.store.heartbeat(
          deps.db(),
          owner,
          principal,
          2 * deps.heartbeatMs,
        );
        if (returned) await deps.announceHost(owner, principal.hostId);
        await deps.reconcile(owner).catch((error: unknown) => {
          console.warn("[parlor] chat: reconciling lapsed turns failed:", error);
        });
        return new Response(null, { status: 204 });
      },
    }),
  ];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ActionError("invalid_input", "Request body must be JSON");
  }
}
