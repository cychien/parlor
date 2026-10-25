import { QueryClient } from "@tanstack/react-query";
import {
  type AnyRoute,
  createRouter,
  type RouterConstructorOptions,
  type RouterHistory,
  type TrailingSlashOption,
} from "@tanstack/react-router";

import type { ActionClient } from "../action-client.js";
import type { ActionQueryContext } from "../react/action-query.js";
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

/**
 * `createRouter` with `client` and `queryClient` (a new one unless given) in every loader's
 * `context`, links that preload on hover, and TanStack Query deciding when data is stale
 * (`defaultPreloadStaleTime: 0`). `FrameworkProvider` given this router uses its `queryClient`.
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
  const { client, queryClient = new QueryClient(), context, ...rest } = options;
  const routerOptions = {
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    ...rest,
    context: { ...context, client, queryClient },
  } as RouterOptions<
    TRouteTree,
    TTrailingSlashOption,
    TDefaultStructuralSharingOption,
    TRouterHistory
  >;
  return createRouter(routerOptions);
}
