import {
  ActionError,
  type ActionConfig,
  type ActionContext,
  type ActionDefinition,
  defineAction,
  type DeviceId,
  DEV_USER_ID,
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

type PartyResolvers = {
  readonly [P in Party]: (
    principal: Principal,
    scope: string,
    enforcing: boolean,
  ) => PartyOf<P>;
};

const resolvers: PartyResolvers = {
  host: (principal, scope) => {
    if (principal.kind !== "host") {
      throw new ActionError("forbidden", "Only a connected computer can call this.");
    }
    return { scope, userId: principal.userId, host: principal };
  },
  user: (principal, scope, enforcing) => {
    if (principal.kind === "user") {
      return { scope, userId: principal.userId, deviceId: principal.deviceId };
    }
    if (principal.kind === "anonymous") {
      if (enforcing) throw new ActionError("unauthenticated", "Sign in first.");
      return { scope, userId: DEV_USER_ID, deviceId: undefined };
    }
    throw new ActionError(
      "forbidden",
      `A ${principal.kind} principal cannot use the chat.`,
    );
  },
};

export function partyOf<P extends Party>(
  party: P,
  principal: Principal,
  scope: string,
  enforcing: boolean,
): PartyOf<P> {
  return resolvers[party](principal, scope, enforcing);
}
