import type { AgentUiClient } from "@parlor/agent-ui/client";
import { createSyncClient, type SyncClient } from "@parlor/sync/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ActionClient } from "../action-client.js";
import type { RegisteredActions } from "../register.js";
import type { FrameworkAuth, SessionSnapshot, SessionSource } from "../session.js";
import { createAgentUiRuntime } from "./agent-ui/runtime.js";
import { type FrameworkSync, SyncBridge } from "./sync-bridge.js";
import { invalidateForEvents, type ReadTagRegistry, readTagsOf } from "./sync.js";

interface FrameworkContextValue {
  readonly client: ActionClient<RegisteredActions>;
  readonly readTags: ReadTagRegistry;
  readonly agentUi: AgentUiClient;
  readonly auth: FrameworkAuth | undefined;
  readonly sync: FrameworkSync;
  readonly bridge: SyncBridge;
}

const FrameworkContext = createContext<FrameworkContextValue | null>(null);

export interface FrameworkProviderProps {
  readonly client: ActionClient<RegisteredActions>;
  /** Defaults to the router's `context.queryClient`, so loaders and hooks share one cache. */
  readonly queryClient?: QueryClient | undefined;
  readonly sync?: boolean | undefined;
  readonly router?: AnyRouter | undefined;
  /**
   * When the signed-in user changes, cached queries reset and sync reconnects as them. Sync
   * waits for a signed-in or `anonymous` session, and after the server refuses it, for the
   * session to change. An auth client that can also sign (`device`) and pair hosts
   * (`authorizeHost`) gives the chat both.
   */
  readonly auth?: FrameworkAuth | undefined;
  readonly children: ReactNode;
}

const SIGNED_OUT: SessionSnapshot = { status: "signed-out" };

/** A server render does not know the session yet, and hydration must render what it rendered. */
const LOADING: SessionSnapshot = { status: "loading" };
const serverSession = () => LOADING;

const NO_SESSION: SessionSource = {
  current: () => SIGNED_OUT,
  subscribe: () => () => {},
};

function identityOf(session: SessionSnapshot): string {
  return session.status === "signed-in" ? `user:${session.user.id}` : session.status;
}

function routerQueryClient(router: AnyRouter | undefined): QueryClient | undefined {
  const context: unknown = router?.options.context;
  if (typeof context !== "object" || context === null || !("queryClient" in context))
    return undefined;
  return context.queryClient instanceof QueryClient ? context.queryClient : undefined;
}

/** Counts changes of the signed-in user after the first settled answer. */
function useSettledIdentityEpoch(auth: SessionSource | undefined): number {
  const source = auth ?? NO_SESSION;
  const identity = identityOf(
    useSyncExternalStore(source.subscribe, source.current, serverSession),
  );
  const [tracked, setTracked] = useState<{
    readonly settled: string | undefined;
    readonly epoch: number;
  }>({ settled: undefined, epoch: 0 });
  if (identity !== "loading" && tracked.settled !== identity) {
    setTracked({
      settled: identity,
      epoch: tracked.settled === undefined ? 0 : tracked.epoch + 1,
    });
  }
  return tracked.epoch;
}

const IdentityEpochContext = createContext(0);

/** Changes whenever the signed-in user does; state kept per user is keyed on it. */
export function useIdentityEpoch(): number {
  return useContext(IdentityEpochContext);
}

export function FrameworkProvider({
  client,
  queryClient,
  sync = true,
  router,
  auth,
  children,
}: FrameworkProviderProps) {
  const [ownQueryClient] = useState(
    () => queryClient ?? routerQueryClient(router) ?? new QueryClient(),
  );
  const [value] = useState<FrameworkContextValue>(() => {
    const bridge = new SyncBridge();
    return {
      client,
      readTags: readTagsOf(ownQueryClient),
      agentUi: createAgentUiRuntime({ client, queryClient: ownQueryClient, router }),
      auth,
      sync: bridge,
      bridge,
    };
  });
  const epoch = useSettledIdentityEpoch(auth);
  const appliedEpoch = useRef(epoch);

  useLayoutEffect(() => {
    if (appliedEpoch.current === epoch) return;
    appliedEpoch.current = epoch;
    void ownQueryClient.resetQueries();
    void router?.invalidate();
    value.agentUi.reset();
  }, [epoch, ownQueryClient, router, value]);

  useEffect(() => value.agentUi.start(), [value]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let uninstall: (() => void) | undefined;
    let active = true;
    void import("./agent-ui/dev.js").then(({ installAgentUiDevtools }) => {
      if (active)
        uninstall = installAgentUiDevtools(value.agentUi, value.client.clientId);
    });
    return () => {
      active = false;
      uninstall?.();
    };
  }, [value]);

  return (
    <FrameworkContext.Provider value={value}>
      <IdentityEpochContext.Provider value={epoch}>
        <QueryClientProvider client={ownQueryClient}>
          {sync && (
            <SyncConnection key={epoch} value={value} queryClient={ownQueryClient} />
          )}
          {children}
        </QueryClientProvider>
      </IdentityEpochContext.Provider>
    </FrameworkContext.Provider>
  );
}

/** The server refuses a signed-out visitor sync, unless it signs nobody in (`anonymous`). */
function syncsAs(session: SessionSnapshot | undefined): boolean {
  return !session || session.status === "signed-in" || session.status === "anonymous";
}

/**
 * One sync connection; remounted with a fresh cursor whenever the signed-in user changes. It
 * runs while the session can sync, and after the server refuses it, until the session changes.
 */
function SyncConnection({
  value,
  queryClient,
}: {
  readonly value: FrameworkContextValue;
  readonly queryClient: QueryClient;
}) {
  // Data loaded outside action queries (plugin calls, the auth client) has no cursor but is read after this render.
  const [loadedAfter] = useState(() => value.readTags.latest());
  useEffect(() => {
    const { client, auth } = value;
    let refused: SessionSnapshot | undefined;
    const syncClient: SyncClient = createSyncClient({
      request: (path, init) => client.request(path, init),
      basePath: client.basePath,
      clientId: client.clientId,
      startAt: () => value.readTags.position(loadedAfter),
      onEvents: (events) => {
        void invalidateForEvents(queryClient, value.readTags, events);
        value.bridge.emit(events);
      },
      isHidden: () => globalThis.document?.visibilityState === "hidden",
      channels: [value.agentUi],
      onNegotiated: (transport) => value.bridge.negotiated(transport),
      onResume: () => value.bridge.resumed(),
      ...(auth
        ? {
            onUnauthorized: () => {
              refused = auth.current();
              syncClient.stop();
            },
          }
        : {}),
    });
    let settled: string | undefined;
    const follow = () => {
      const session = auth?.current();
      if (session?.status === "loading") return;
      if (session !== refused) refused = undefined;
      if (session) settled ??= identityOf(session);
      // The provider remounts this connection for another user.
      const anotherUser = session !== undefined && identityOf(session) !== settled;
      if (syncsAs(session) && refused === undefined && !anotherUser) syncClient.start();
      else syncClient.stop();
    };
    const reconnectWhenVisible = () => {
      if (globalThis.document?.visibilityState !== "hidden") syncClient.reconnectNow();
    };
    const reconnect = () => syncClient.reconnectNow();
    globalThis.addEventListener?.("online", reconnect);
    globalThis.document?.addEventListener("visibilitychange", reconnectWhenVisible);
    const detach = value.bridge.attach(syncClient);
    const unfollow = auth?.subscribe(follow);
    follow();
    return () => {
      unfollow?.();
      globalThis.removeEventListener?.("online", reconnect);
      globalThis.document?.removeEventListener("visibilitychange", reconnectWhenVisible);
      syncClient.stop();
      detach();
    };
  }, [value, queryClient, loadedAfter]);
  return null;
}

export function useFramework(): FrameworkContextValue {
  const value = useContext(FrameworkContext);
  if (!value) throw new Error("useActionClient must be used inside <FrameworkProvider>");
  return value;
}

export function useActionClient(): ActionClient<RegisteredActions> {
  return useFramework().client;
}

/** The session of the `auth` given to `FrameworkProvider`. */
export function useSession(): SessionSnapshot {
  const { auth } = useFramework();
  if (!auth) throw new Error("useSession needs <FrameworkProvider auth={...}>");
  return useSyncExternalStore(auth.subscribe, auth.current, serverSession);
}
