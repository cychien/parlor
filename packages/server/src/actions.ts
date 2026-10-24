import type { AgentOrigin } from "@parlor/agent-ui";
import type { ConfirmationOutcome, ConfirmationRequest } from "@parlor/agent-ui/server";
import {
  ActionError,
  type ActionMap,
  ANONYMOUS,
  type ActionSource,
  type DataProvider,
  type Principal,
} from "@parlor/core";
import {
  type ActionRegistry,
  invokeAction,
  type InvokeResult,
  type PreparedCall,
} from "@parlor/core/registry";
import {
  createPruner,
  ensureSyncTables,
  recordSyncEvent,
  type SyncDatabase,
} from "@parlor/sync/server";

import { requireSurface, type Surface } from "./access.js";
import { AuthFailure } from "./auth.js";
import {
  type Caller,
  type CallerResolver,
  createCallerResolver,
  sourceFor,
} from "./caller.js";
import type { ActionAudit, ConfirmationAnswer } from "./plugin.js";
import { DEFAULT_SCOPE, type ScopeResolver } from "./scope.js";

export { clientOf, sourceOf } from "./caller.js";

export type Confirm = (request: ConfirmationRequest) => Promise<ConfirmationOutcome>;

export interface ActionRunnerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope: ScopeResolver;
  readonly database?: DataProvider | undefined;
  readonly sync: boolean;
  /** Resolves each request's identity once; without it every caller is anonymous. */
  readonly callers?: CallerResolver | undefined;
  readonly onClient?:
    | ((clientId: string | undefined, audience: string) => void)
    | undefined;
  readonly confirm?: Confirm | undefined;
  readonly audit?: ((record: ActionAudit) => void) | undefined;
  /** Awaited before every call, so it must memoize; defaults to creating the sync tables. */
  readonly ready?: (() => Promise<void>) | undefined;
}

export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly origin?: AgentOrigin | undefined;
  /** Refuses callers the surface does not admit, inside the call so the refusal is audited. */
  readonly surface?: Surface | undefined;
}

export interface ActionRunner {
  run(
    name: string,
    input: unknown,
    request: Request | undefined,
    source: ActionSource,
    options?: RunOptions,
  ): Promise<InvokeResult>;
  ready(): Promise<void>;
}

interface Gate {
  readonly confirm: Confirm;
  readonly answered: (answer: ConfirmationAnswer) => void;
  readonly scope: string;
  readonly clientId: string | undefined;
  readonly origin: AgentOrigin | undefined;
  readonly signal: AbortSignal | undefined;
}

function originOf(source: ActionSource, principal: Principal): AgentOrigin {
  const via = source === "agent" ? "agent" : "mcp";
  return principal.kind === "agent" ? { via, name: principal.agent.name } : { via };
}

function confirmationGate(gate: Gate): (call: PreparedCall) => Promise<void> {
  return async ({ action, name, input, ctx }) => {
    const turn = ctx.principal?.kind === "agent" ? ctx.principal.turn : undefined;
    const outcome = await gate.confirm({
      scope: gate.scope,
      clientId: turn?.clientId ?? gate.clientId,
      ...(turn ? { thread: { threadId: turn.threadId, turnId: turn.turnId } } : {}),
      action: name,
      description: action.description,
      input,
      origin: gate.origin ?? originOf(ctx.source, ctx.principal ?? ANONYMOUS),
      signal: gate.signal,
    });
    if (outcome !== "cancelled") {
      gate.answered(outcome === "shutdown" ? "unavailable" : outcome);
    }
    switch (outcome) {
      case "approved":
        return;
      case "declined":
        throw new ActionError(
          "declined",
          `The user declined ${name} in the app; nothing ran. Do not retry unless they ask again.`,
        );
      case "timeout":
        throw new ActionError(
          "confirmation_timeout",
          `The user did not answer in time; ${name} did not run.`,
        );
      case "unavailable":
        throw new ActionError(
          "confirmation_unavailable",
          `No open app can ask the user to confirm ${name}. Ask the user to do it in the app themselves.`,
        );
      case "shutdown":
        throw new ActionError(
          "confirmation_unavailable",
          `The server shut down before the user answered; ${name} did not run. Try again once it is back, or ask the user to do it in the app themselves.`,
        );
      case "cancelled":
        throw (
          gate.signal?.reason ?? new DOMException("The call was cancelled.", "AbortError")
        );
    }
  };
}

const INTERNAL_CALLER: Caller = {
  principal: ANONYMOUS,
  scope: DEFAULT_SCOPE,
  audience: DEFAULT_SCOPE,
  clientId: undefined,
};

export function createActionRunner<T extends ActionMap>(
  options: ActionRunnerOptions<T>,
): ActionRunner {
  const { actions, scope, database, sync, onClient, confirm, audit } = options;
  const callers = options.callers ?? createCallerResolver(undefined, scope);
  const pruner = sync && database ? createPruner(database) : undefined;
  let prepared: Promise<void> | undefined;
  const ready =
    options.ready ??
    (() => {
      prepared ??=
        sync && database
          ? ensureSyncTables(database.read() as SyncDatabase)
          : Promise.resolve();
      return prepared;
    });

  const invoke = async (
    name: string,
    input: unknown,
    request: Request | undefined,
    caller: Caller,
    source: ActionSource,
    runOptions: RunOptions,
    trace: Trace,
  ): Promise<InvokeResult> => {
    if (runOptions.surface) requireSurface(caller, runOptions.surface, callers.enforcing);
    const client = caller.clientId;
    onClient?.(client, caller.audience);
    const signal = runOptions.signal ?? request?.signal;
    const resolvedScope = caller.scope;
    const result = await invokeAction(
      actions,
      name,
      input,
      { scope: resolvedScope, source, principal: caller.principal, signal, request },
      {
        data: database,
        enforcing: callers.enforcing,
        onRun: () => {
          trace.stage = "ran";
        },
        confirm: confirm
          ? confirmationGate({
              confirm,
              answered: (answer) => {
                trace.confirmation = answer;
              },
              scope: caller.audience,
              clientId: client,
              origin: runOptions.origin,
              signal,
            })
          : undefined,
        onWrite:
          sync && database
            ? async ({ action, tags, tx }) => {
                if (tags.length === 0) return;
                await recordSyncEvent(tx as SyncDatabase, {
                  scope: action.notifies === "user" ? caller.audience : resolvedScope,
                  tags,
                  source: client,
                });
              }
            : undefined,
      },
    );
    if (result.writes.length > 0) pruner?.touch();
    return result;
  };

  return {
    ready,
    async run(name, input, request, declared, runOptions = {}) {
      await ready();
      const caller = request ? await callers(request) : INTERNAL_CALLER;
      const source = sourceFor(declared, caller, callers.enforcing);
      const trace: Trace = { stage: "refused", confirmation: undefined };
      if (!audit) return invoke(name, input, request, caller, source, runOptions, trace);
      const at = Date.now();
      const record = async (outcome: ActionAudit["outcome"]) => {
        try {
          audit({
            at,
            action: name,
            principal: caller.principal,
            source,
            scope: caller.scope,
            inputDigest: await digest(input),
            stage: trace.stage,
            outcome,
            ...(trace.confirmation ? { confirmation: trace.confirmation } : {}),
          });
        } catch (error) {
          console.error("[parlor] audit failed:", error);
        }
      };
      try {
        const result = await invoke(
          name,
          input,
          request,
          caller,
          source,
          runOptions,
          trace,
        );
        await record("ok");
        return result;
      } catch (error) {
        await record(outcomeOf(error));
        throw error;
      }
    },
  };
}

interface Trace {
  stage: ActionAudit["stage"];
  confirmation: ConfirmationAnswer | undefined;
}

function outcomeOf(error: unknown): ActionAudit["outcome"] {
  if (error instanceof ActionError) return error.code;
  if (error instanceof AuthFailure) return "unauthenticated";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "internal";
}

async function digest(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input ?? null));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
