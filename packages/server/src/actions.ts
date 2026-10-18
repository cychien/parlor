import type { AgentOrigin } from "@parlor/agent-ui";
import type { ConfirmationOutcome, ConfirmationRequest } from "@parlor/agent-ui/server";
import {
  ActionError,
  type ActionMap,
  type ActionSource,
  type DataProvider,
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

import { CLIENT_HEADER, SOURCE_HEADER } from "./protocol.js";
import type { ScopeResolver } from "./scope.js";

const SOURCES: ReadonlySet<string> = new Set<ActionSource>([
  "ui",
  "agent",
  "http",
  "mcp",
]);

export function sourceOf(request: Request): ActionSource {
  const header = request.headers.get(SOURCE_HEADER);
  return header && SOURCES.has(header) ? (header as ActionSource) : "http";
}

export function clientOf(request: Request): string | undefined {
  return request.headers.get(CLIENT_HEADER) ?? undefined;
}

export type Confirm = (request: ConfirmationRequest) => Promise<ConfirmationOutcome>;

export interface ActionRunnerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope: ScopeResolver;
  readonly database?: DataProvider | undefined;
  readonly sync: boolean;
  readonly onClient?: ((clientId: string | undefined) => void) | undefined;
  readonly confirm?: Confirm | undefined;
}

export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly origin?: AgentOrigin | undefined;
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
  readonly scope: string;
  readonly clientId: string | undefined;
  readonly origin: AgentOrigin | undefined;
  readonly signal: AbortSignal | undefined;
}

const originOfSource = (source: ActionSource): AgentOrigin => ({
  via: source === "agent" ? "agent" : "mcp",
});

function confirmationGate(gate: Gate): (call: PreparedCall) => Promise<void> {
  return async ({ action, name, input, ctx }) => {
    const outcome = await gate.confirm({
      scope: gate.scope,
      clientId: gate.clientId,
      action: name,
      description: action.description,
      input,
      origin: gate.origin ?? originOfSource(ctx.source),
      signal: gate.signal,
    });
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
      case "cancelled":
        throw (
          gate.signal?.reason ?? new DOMException("The call was cancelled.", "AbortError")
        );
    }
  };
}

export function createActionRunner<T extends ActionMap>(
  options: ActionRunnerOptions<T>,
): ActionRunner {
  const { actions, scope, database, sync, onClient, confirm } = options;
  const pruner = sync && database ? createPruner(database) : undefined;
  let prepared: Promise<void> | undefined;
  const ready = () => {
    prepared ??=
      sync && database
        ? ensureSyncTables(database.read() as SyncDatabase)
        : Promise.resolve();
    return prepared;
  };

  return {
    ready,
    async run(name, input, request, source, runOptions = {}) {
      await ready();
      const resolvedScope = request ? await scope(request) : "default";
      const client = request ? clientOf(request) : undefined;
      onClient?.(client);
      const signal = runOptions.signal ?? request?.signal;
      const result = await invokeAction(
        actions,
        name,
        input,
        { scope: resolvedScope, source, signal },
        {
          data: database,
          confirm: confirm
            ? confirmationGate({
                confirm,
                scope: resolvedScope,
                clientId: client,
                origin: runOptions.origin,
                signal,
              })
            : undefined,
          onWrite:
            sync && database
              ? async ({ tags, tx }) => {
                  if (tags.length === 0) return;
                  await recordSyncEvent(tx as SyncDatabase, {
                    scope: resolvedScope,
                    tags,
                    source: client,
                  });
                }
              : undefined,
        },
      );
      if (result.writes.length > 0) pruner?.touch();
      return result;
    },
  };
}
