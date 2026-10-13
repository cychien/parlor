import type { ActionMap, ActionSource, DataProvider } from "@parlor/core";
import {
  type ActionRegistry,
  invokeAction,
  type InvokeResult,
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

export interface ActionRunnerOptions<T extends ActionMap> {
  readonly actions: ActionRegistry<T>;
  readonly scope: ScopeResolver;
  readonly database?: DataProvider | undefined;
  readonly sync: boolean;
}

export interface ActionRunner {
  run(
    name: string,
    input: unknown,
    request: Request | undefined,
    source: ActionSource,
  ): Promise<InvokeResult>;
  ready(): Promise<void>;
}

export function createActionRunner<T extends ActionMap>(
  options: ActionRunnerOptions<T>,
): ActionRunner {
  const { actions, scope, database, sync } = options;
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
    async run(name, input, request, source) {
      await ready();
      const resolvedScope = request ? await scope(request) : "default";
      const client = request ? clientOf(request) : undefined;
      const result = await invokeAction(
        actions,
        name,
        input,
        { scope: resolvedScope, source, signal: request?.signal },
        {
          data: database,
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
