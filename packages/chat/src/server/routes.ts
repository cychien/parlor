import { ActionError, type TurnId } from "@parlor/core";
import { type AnyPluginRoute, pluginRoute } from "@parlor/server";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import type { HostStreamBatch } from "../protocol.js";
import type { LiveRelay } from "./live.js";
import type { ChatDb, ChatStore, TurnHolder } from "./store.js";

export const MAX_STREAM_BODY_BYTES = 64 * 1024;
const MAX_FRAMES_PER_BATCH = 512;
const MAX_REMEMBERED_HOLDERS = 1024;

export interface ChatRouteDeps {
  readonly db: () => ChatDb;
  readonly store: ChatStore;
  readonly relay: LiveRelay;
  readonly heartbeatMs: number;
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

async function readBounded(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > limit) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Plain routes only a host principal reaches, by type: no browser session, no agent token. */
export function chatRoutes(deps: ChatRouteDeps): readonly AnyPluginRoute[] {
  const holders = new Map<TurnId, TurnHolder>();
  const holderOf = async (turnId: TurnId): Promise<TurnHolder | undefined> => {
    const known = holders.get(turnId);
    if (known) return known;
    const found = await deps.store.turnHolder(deps.db(), turnId);
    if (!found) return undefined;
    if (holders.size >= MAX_REMEMBERED_HOLDERS) {
      const oldest = holders.keys().next();
      if (!oldest.done) holders.delete(oldest.value);
    }
    holders.set(turnId, found);
    return found;
  };

  return [
    pluginRoute({
      method: "POST",
      path: "/stream",
      access: ["host"],
      handle: async (request, caller) => {
        const text = await readBounded(request, MAX_STREAM_BODY_BYTES);
        if (text === undefined) return tooLarge();
        const parsed = streamBatch.safeParse(parseJson(text));
        if (!parsed.success) {
          throw new ActionError("invalid_input", "Not a stream batch", {
            issues: parsed.error.issues,
          });
        }
        const batch = parsed.data;
        const holder = await holderOf(batch.turnId);
        const { principal } = caller;
        const owns =
          holder !== undefined &&
          holder.hostId === principal.hostId &&
          holder.owner.userId === principal.userId &&
          holder.owner.scope === caller.scope;
        if (!owns) throw new ActionError("forbidden", "This turn is not yours.");
        deps.relay.accept(holder, batch);
        return new Response(null, { status: 204 });
      },
    }),
    pluginRoute({
      method: "POST",
      path: "/heartbeat",
      access: ["host"],
      handle: async (_request, caller) => {
        const { principal } = caller;
        await deps.store.heartbeat(
          deps.db(),
          { scope: caller.scope, userId: principal.userId },
          principal,
          2 * deps.heartbeatMs,
        );
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
