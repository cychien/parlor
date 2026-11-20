import { ActionError, type HostId, type HostPrincipal } from "@parlor/core";
import { type AnyPluginRoute, pluginRoute, readBoundedText } from "@parlor/server";
import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import type { ChatOwner } from "../model.js";
import type { HeartbeatAnswer, HostStreamBatch } from "../protocol.js";
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
  /**
   * Takes a heartbeat in place of renewing the computer's lease in the database, and answers
   * the token its next ones may carry to `heard` (`HeartbeatAnswer`).
   */
  readonly beat?:
    | ((owner: ChatOwner, host: HostPrincipal) => Promise<string>)
    | undefined;
  /** A heartbeat that carries only a token `beat` answered; false when nobody holds it. */
  readonly heard?: ((token: string) => boolean) | undefined;
}

const MAX_BEAT_BODY_BYTES = 1024;
const beatBody = z.object({ token: z.string().min(1).max(128) });

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
          holder.owner.userId === principal.userId;
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
        if (deps.beat) {
          const answer: HeartbeatAnswer = { beat: await deps.beat(owner, principal) };
          return Response.json(answer);
        }
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
    {
      method: "POST",
      path: "/beat",
      access: "public",
      handle: async (request) => {
        const text = await readBoundedText(request, MAX_BEAT_BODY_BYTES);
        const parsed = beatBody.safeParse(text === undefined ? undefined : json(text));
        const known = parsed.success && deps.heard?.(parsed.data.token) === true;
        return new Response(null, { status: known ? 204 : 404 });
      },
    },
  ];
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ActionError("invalid_input", "Request body must be JSON");
  }
}
