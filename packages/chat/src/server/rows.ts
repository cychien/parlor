import { z } from "zod";

import { idSchema } from "../id-schemas.js";
import { chatItemBodies, type LoggedItem } from "../items.js";
import type { AgentRef, ThreadSummary, TurnFailure, TurnState } from "../model.js";

const agentOptionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(100),
  category: z.string().max(50).optional(),
  current: z.string().max(200),
  values: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().max(200),
        description: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .readonly(),
});

const agentUsageSchema = z.object({
  windows: z
    .array(
      z.object({
        id: z.string().min(1).max(50),
        minutes: z.number().positive(),
        used: z.number().min(0).max(1),
        resetsAt: z.number().optional(),
      }),
    )
    .max(10)
    .readonly(),
  at: z.number(),
});

export const agentInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.string().optional(),
  ready: z.boolean(),
  problem: z.string().optional(),
  options: z.array(agentOptionSchema).max(10).readonly().optional(),
  usage: agentUsageSchema.optional(),
  outsideName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
    .optional(),
});

const ITEM_KINDS = [
  "prompt",
  "answer",
  "cancel",
  "reply",
  "reasoning",
  "tool",
  "plan",
  "ask",
  "event",
] as const;

const count = z.coerce.number();

export const itemRow = z.object({
  id: idSchema("item"),
  thread_id: idSchema("thread"),
  turn_id: idSchema("turn"),
  seq: count,
  at: count,
  kind: z.enum(ITEM_KINDS),
  body: z.unknown(),
});

export function toLoggedItem(row: z.output<typeof itemRow>): LoggedItem {
  const common = {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    seq: row.seq,
    at: row.at,
  };
  switch (row.kind) {
    case "prompt":
      return {
        ...common,
        author: "user",
        kind: "prompt",
        body: chatItemBodies.prompt.body.parse(row.body),
      };
    case "answer":
      return {
        ...common,
        author: "user",
        kind: "answer",
        body: chatItemBodies.answer.body.parse(row.body),
      };
    case "cancel":
      return {
        ...common,
        author: "user",
        kind: "cancel",
        body: chatItemBodies.cancel.body.parse(row.body),
      };
    case "reply":
      return {
        ...common,
        author: "agent",
        kind: "reply",
        body: chatItemBodies.reply.body.parse(row.body),
      };
    case "reasoning":
      return {
        ...common,
        author: "agent",
        kind: "reasoning",
        body: chatItemBodies.reasoning.body.parse(row.body),
      };
    case "tool":
      return {
        ...common,
        author: "agent",
        kind: "tool",
        body: chatItemBodies.tool.body.parse(row.body),
      };
    case "plan":
      return {
        ...common,
        author: "agent",
        kind: "plan",
        body: chatItemBodies.plan.body.parse(row.body),
      };
    case "ask":
      return {
        ...common,
        author: "agent",
        kind: "ask",
        body: chatItemBodies.ask.body.parse(row.body),
      };
    case "event":
      return {
        ...common,
        author: "system",
        kind: "event",
        body: chatItemBodies.event.body.parse(row.body),
      };
  }
}

export const threadRow = z.object({
  id: idSchema("thread"),
  title: z.string(),
  host_id: idSchema("host").nullable(),
  agent_id: z.string().nullable(),
  last_seq: count,
  updated_at: count,
});

export function toThreadSummary(row: z.output<typeof threadRow>): ThreadSummary {
  const agent: AgentRef | undefined =
    row.host_id !== null && row.agent_id !== null
      ? { hostId: row.host_id, agentId: row.agent_id }
      : undefined;
  return {
    id: row.id,
    title: row.title,
    agent,
    updatedAt: row.updated_at,
    lastSeq: row.last_seq,
  };
}

export const TURN_FAILURES = [
  "agent_exited",
  "agent_unavailable",
  "device_rejected",
  "signature_invalid",
  "prompt_expired",
  "host_lost",
] as const satisfies readonly TurnFailure[];

export const TURN_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export const turnStateSchema = z.enum(TURN_STATES) satisfies z.ZodType<TurnState>;
