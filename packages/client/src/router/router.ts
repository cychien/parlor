import type { Tag } from "@parlor/core";
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  QueryClient,
} from "@tanstack/react-query";
import {
  type AnyRoute,
  createRouter,
  type RouterConstructorOptions,
  type RouterHistory,
  type TrailingSlashOption,
} from "@tanstack/react-router";

import type { ActionClient } from "../action-client.js";
import type { ActionQueryContext } from "../react/action-query.js";
import { readTagsOf } from "../react/sync.js";
import type { RegisteredActions } from "../register.js";

/** The router context Parlor's loaders read: `createRootRouteWithContext<ParlorRouterContext>()`. */
export type ParlorRouterContext = ActionQueryContext;

type Dehydrated = Record<string, unknown>;

type RouterOptions<
  TRouteTree extends AnyRoute,
  TTrailingSlashOption extends TrailingSlashOption,
  TDefaultStructuralSharingOption extends boolean,
  TRouterHistory extends RouterHistory,
> = RouterConstructorOptions<
  TRouteTree,
  TTrailingSlashOption,
  TDefaultStructuralSharingOption,
  TRouterHistory,
  Dehydrated
>;

type AppContext<TRouteTree extends AnyRoute> = Omit<
  NonNullable<RouterOptions<TRouteTree, "never", false, RouterHistory>["context"]>,
  keyof ParlorRouterContext
>;

export type ParlorRouterOptions<
  TRouteTree extends AnyRoute,
  TTrailingSlashOption extends TrailingSlashOption = "never",
  TDefaultStructuralSharingOption extends boolean = false,
  TRouterHistory extends RouterHistory = RouterHistory,
> = Omit<
  RouterOptions<
    TRouteTree,
    TTrailingSlashOption,
    TDefaultStructuralSharingOption,
    TRouterHistory
  >,
  "context"
> & {
  readonly client: ActionClient<RegisteredActions>;
  readonly queryClient?: QueryClient | undefined;
} & ({} extends AppContext<TRouteTree>
    ? { readonly context?: AppContext<TRouteTree> }
    : { readonly context: AppContext<TRouteTree> });

const QUERY_CACHE = "parlorQueryCache";

interface DehydratedQueryCache {
  readonly state: DehydratedState;
  readonly readTags: readonly (readonly [string, readonly Tag[]])[];
}

function dehydrateQueryCache(queryClient: QueryClient): DehydratedQueryCache {
  return { state: dehydrate(queryClient), readTags: readTagsOf(queryClient).entries() };
}

function hydrateQueryCache(queryClient: QueryClient, cache: unknown): void {
  if (!cache) return;
  const { state, readTags } = cache as DehydratedQueryCache;
  hydrate(queryClient, state);
  const registry = readTagsOf(queryClient);
  for (const [hash, tags] of readTags) registry.record(hash, tags);
}

/**
 * `createRouter` with `client` and `queryClient` (a new one unless given) in every loader's
 * `context`, links that preload on hover, and TanStack Query deciding when data is stale
 * (`defaultPreloadStaleTime: 0`). `FrameworkProvider` given this router uses its `queryClient`.
 *
 * A route renders on the server only when it sets `ssr: true` (`defaultSsr: false`). The query
 * cache a server render filled, with its read tags, comes along to the browser, so sync keeps it fresh.
 */
export function createParlorRouter<
  TRouteTree extends AnyRoute,
  TTrailingSlashOption extends TrailingSlashOption = "never",
  TDefaultStructuralSharingOption extends boolean = false,
  TRouterHistory extends RouterHistory = RouterHistory,
>(
  options: ParlorRouterOptions<
    TRouteTree,
    TTrailingSlashOption,
    TDefaultStructuralSharingOption,
    TRouterHistory
  >,
) {
  const {
    client,
    queryClient = new QueryClient(),
    context,
    dehydrate: dehydrateApp,
    hydrate: hydrateApp,
    ...rest
  } = options;
  const routerOptions = {
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultSsr: false,
    ...rest,
    context: { ...context, client, queryClient },
    dehydrate: async (): Promise<Dehydrated> => ({
      ...(await dehydrateApp?.()),
      [QUERY_CACHE]: dehydrateQueryCache(queryClient),
    }),
    hydrate: async (dehydrated: Dehydrated) => {
      hydrateQueryCache(queryClient, dehydrated[QUERY_CACHE]);
      await hydrateApp?.(dehydrated);
    },
  } as RouterOptions<
    TRouteTree,
    TTrailingSlashOption,
    TDefaultStructuralSharingOption,
    TRouterHistory
  >;
  return createRouter(routerOptions);
}
