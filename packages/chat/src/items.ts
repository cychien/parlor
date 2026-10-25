import type { ItemId, ThreadId, TurnId } from "@parlor/core";
import { z } from "zod";

import { CHAT_EVENTS } from "./events.js";
import { idSchema } from "./id-schemas.js";
import { MAX_PROMPT_CHARS } from "./limits.js";

const signature = z.object({
  keyId: z.string(),
  presence: z.enum(["none", "user"]),
  format: z.enum(["es256-raw", "webauthn"]),
  signature: z.string(),
  authenticatorData: z.string().optional(),
  clientDataJSON: z.string().optional(),
});

const signed = z.object({
  deviceId: idSchema("device"),
  at: z.number(),
  signature,
  /** The browser that approved the computer's connect proving it, so the computer trusts it unasked. */
  pairing: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});

const agentRef = z.object({ hostId: idSchema("host"), agentId: z.string().min(1) });

const askChoice = z.object({
  id: z.string().min(1),
  label: z.string(),
  effect: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});

/**
 * The one table of item kinds: who writes each and the body it carries. Types, the
 * server's parsers, the host's append type and the client's view all derive from it.
 */
export const chatItemBodies = {
  prompt: {
    author: "user",
    body: z.object({
      text: z.string().min(1).max(MAX_PROMPT_CHARS),
      agent: agentRef,
      signed: signed.optional(),
      /**
       * The agent's options this turn runs with, by option id. Not signed: the computer runs
       * only values the agent offers, and none of them widens what the agent may do.
       */
      options: z.record(z.string().max(100), z.string().max(200)).optional(),
    }),
  },
  answer: {
    author: "user",
    body: z.object({
      askId: idSchema("item"),
      choice: z.string().min(1),
      values: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional(),
      signed: signed.optional(),
    }),
  },
  cancel: { author: "user", body: z.object({}) },
  reply: {
    author: "agent",
    body: z.object({ text: z.string(), interrupted: z.literal(true).optional() }),
  },
  reasoning: { author: "agent", body: z.object({ text: z.string() }) },
  tool: {
    author: "agent",
    body: z.object({
      title: z.string(),
      tool: z.object({ kind: z.enum(["app", "local"]), name: z.string() }),
      status: z.enum(["done", "failed", "cancelled"]),
      detail: z.string().max(4_000).optional(),
    }),
  },
  plan: {
    author: "agent",
    body: z.object({
      entries: z.array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      ),
    }),
  },
  ask: {
    author: "agent",
    body: z.object({
      question: z.string(),
      choices: z.array(askChoice),
      form: z.record(z.string(), z.unknown()).optional(),
      /**
       * Set by the host's policy, never by the app. Absent: any device answers from the
       * chat, without presence. `device`: only the device that sent the turn's prompt, from
       * the chat, without presence.
       */
      approval: z.enum(["presence", "computer", "device"]).optional(),
    }),
  },
  event: {
    author: "system",
    body: z.object({
      event: z.enum(CHAT_EVENTS),
      detail: z.string().max(500).optional(),
      itemId: idSchema("item").optional(),
      choice: z.string().min(1).optional(),
    }),
  },
} as const;

type Bodies = typeof chatItemBodies;

export type ChatItemKind = keyof Bodies;
export type Author = Bodies[ChatItemKind]["author"];
export type AuthorOf<K extends ChatItemKind> = Bodies[K]["author"];
export type ChatItemBody<K extends ChatItemKind> = z.output<Bodies[K]["body"]>;
export type ItemSignature = z.output<typeof signed>;

type KindsBy<A extends Author> = {
  [K in ChatItemKind]: AuthorOf<K> extends A ? K : never;
}[ChatItemKind];

/** Appended only by the user's devices, through the user actions. */
export type UserItemKind = KindsBy<"user">;
/** Appended only by the user's computer, through the host actions. */
export type HostItemKind = KindsBy<"agent" | "system">;

export type LoggedItem<K extends ChatItemKind = ChatItemKind> = {
  [Kind in K]: {
    readonly id: ItemId;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    /** Gap-free per thread, assigned under the thread row's lock. */
    readonly seq: number;
    readonly at: number;
    readonly author: AuthorOf<Kind>;
    readonly kind: Kind;
    readonly body: ChatItemBody<Kind>;
  };
}[K];

/** Its id is `<turnId>.<n>`, chosen by the host, so a retried append is a no-op. */
export type HostItemDraft = {
  [K in HostItemKind]: {
    readonly id: ItemId;
    readonly kind: K;
    readonly body: ChatItemBody<K>;
  };
}[HostItemKind];

const draft = <K extends HostItemKind>(
  kind: K,
): z.ZodObject<{
  id: ReturnType<typeof idSchema<"item">>;
  kind: z.ZodLiteral<K>;
  body: Bodies[K]["body"];
}> =>
  z.object({
    id: idSchema("item"),
    kind: z.literal(kind),
    body: chatItemBodies[kind].body as Bodies[K]["body"],
  });

export const hostItemDraft = z.discriminatedUnion("kind", [
  draft("reply"),
  draft("reasoning"),
  draft("tool"),
  draft("plan"),
  draft("ask"),
  draft("event"),
]);
