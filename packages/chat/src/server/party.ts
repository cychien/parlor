import {
  type ActionConfig,
  type ActionContext,
  type ActionDefinition,
  defineAction,
  type DeviceId,
  type HostPrincipal,
  type Principal,
} from "@parlor/core";
import type { z } from "zod";

import type { ChatOwner } from "../model.js";

export type Party = "user" | "host";

export interface ChatUser extends ChatOwner {
  readonly deviceId: DeviceId | undefined;
}

/** A host and the owner whose rows it may touch: its own user. */
export interface ChatHost extends ChatOwner {
  readonly host: HostPrincipal;
}

export type PartyOf<P extends Party> = P extends "user" ? ChatUser : ChatHost;

export interface ChatActionConfig<P extends Party, I extends z.ZodType, O> extends Omit<
  ActionConfig<I, O>,
  "run" | "confirm" | "public"
> {
  run(input: z.output<I>, party: PartyOf<P>, ctx: ActionContext): Promise<O> | O;
}

/**
 * An action only `party` may call, checked once before `run`: a user action takes a
 * signed-in user, or without an enforcing provider an anonymous caller as `DEV_USER_ID`;
 * a host action takes only a host. Everything else is `forbidden`, so no body checks the
 * principal itself.
 */
export function chatAction<P extends Party, I extends z.ZodType, O>(
  party: P,
  enforcing: boolean,
  config: ChatActionConfig<P, I, O>,
): ActionDefinition<I, O> {
  const { run, ...rest } = config;
  return defineAction<I, O>({
    ...rest,
    run: (input, ctx) =>
      run(input, partyOf(party, ctx.principal, ctx.scope, enforcing), ctx),
  });
}

export function partyOf<P extends Party>(
  party: P,
  principal: Principal,
  scope: string,
  enforcing: boolean,
): PartyOf<P> {
  // TODO: host -> principal.kind "host" else ActionError("forbidden"), { scope, userId,
  //   host }; user -> "user" -> { scope, userId, deviceId }; "anonymous" && !enforcing ->
  //   DEV_USER_ID with no device; anything else (agent, a host on a user action) -> forbidden.
  void party;
  void principal;
  void scope;
  void enforcing;
  throw new Error("not implemented");
}
