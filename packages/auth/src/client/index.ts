import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { resolveCapability, type SessionStore, sessionStore } from "@parlor/capabilities";
import {
  type ActionClient,
  createActionClient,
  type HostAuthorizer,
  type SessionSnapshot,
  type SessionSource,
} from "@parlor/client";
import { createAuthClient as createBetterAuthClient } from "better-auth/client";

import type { AccountActions } from "../account.js";

const DEFAULT_BASE_PATH = "/_parlor";
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const TOKEN_HEADER = "set-auth-token";

function injectedServerUrl(): string {
  const env = (import.meta as { env?: { PARLOR_SERVER_URL?: string } }).env;
  return env?.PARLOR_SERVER_URL ?? "";
}

export interface AuthClientOptions {
  /** The backend origin; defaults to the shell's `server.url`, or this page's origin. */
  readonly baseUrl?: string | undefined;
  readonly basePath?: string | undefined;
  /**
   * Where a bearer session is kept. Defaults to the `sessionStore` capability: native
   * shells keep a bearer token, the web keeps a cookie.
   */
  readonly session?: SessionStore | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export class AuthClientError extends Error {
  override readonly name = "AuthClientError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

export interface AuthClient extends SessionSource, HostAuthorizer {
  /** Plug into `createActionClient({ headers })` so every surface carries the session. */
  readonly headers: () => Promise<HeadersInit>;
  signIn(input: { readonly email: string; readonly password: string }): Promise<void>;
  signUp(input: {
    readonly name: string;
    readonly email: string;
    readonly password: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  /** The account actions: `sessions`, `revokeSession`, `agents`, `revokeAgent`. */
  readonly account: ActionClient<AccountActions>;
}

interface BetterAuthResult {
  readonly error?: {
    readonly message?: string | undefined;
    readonly status: number;
    readonly code?: string | undefined;
  } | null;
}

function settle(result: BetterAuthResult): void {
  if (!result.error) return;
  const { message, status, code } = result.error;
  throw new AuthClientError(message || "Authentication failed.", status, code);
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const baseUrl = options.baseUrl ?? injectedServerUrl();
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const store: Promise<SessionStore | undefined> = options.session
    ? Promise.resolve(options.session)
    : resolveCapability(sessionStore).then((handle) =>
        handle.available ? handle.api : undefined,
      );

  const headers = async (): Promise<HeadersInit> => {
    const token = await (await store)?.get();
    return token ? { authorization: `Bearer ${token}` } : {};
  };

  // Built on first use: importing a module that creates the client must work outside a page.
  let client: ReturnType<typeof connect> | undefined;
  const connect = () =>
    createBetterAuthClient({
      baseURL: `${baseUrl || globalThis.location.origin}${basePath}/auth`,
      plugins: [oauthProviderClient()],
      fetchOptions: {
        ...(options.fetch ? { customFetchImpl: options.fetch } : {}),
        onRequest: async (context) => {
          for (const [name, value] of new Headers(await headers())) {
            context.headers.set(name, value);
          }
          return context;
        },
        onSuccess: async (context) => {
          const token = context.response.headers.get(TOKEN_HEADER);
          if (token) await (await store)?.set(token);
          else if (
            context.request.url.toString().endsWith("/get-session") &&
            !context.data
          ) {
            // A bearer token the server no longer knows would fail every later request.
            await (await store)?.set(undefined);
          }
        },
      },
    });
  const betterAuth = () => (client ??= connect());

  let watchers = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_BASE_MS;
  const retryAfterError = () => {
    const state = betterAuth().useSession.get();
    if (!state.error) {
      retryDelay = RETRY_BASE_MS;
      return;
    }
    if (retry !== undefined || state.isRefetching) return;
    retry = setTimeout(() => {
      retry = undefined;
      void state.refetch();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };

  let last: unknown;
  let snapshot: SessionSnapshot = { status: "loading" };
  const current = (): SessionSnapshot => {
    const state = betterAuth().useSession.get();
    if (state === last) return snapshot;
    last = state;
    // Only the server saying there is no session signs the user out, never an unreachable one.
    if (state.error) return snapshot;
    const user = state.data?.user;
    snapshot = user
      ? { status: "signed-in", user: { id: user.id, name: user.name, email: user.email } }
      : state.isPending
        ? { status: "loading" }
        : { status: "signed-out" };
    return snapshot;
  };

  return {
    headers,
    current,
    subscribe: (listener) => {
      watchers += 1;
      const stop = betterAuth().useSession.listen(() => {
        retryAfterError();
        listener();
      });
      return () => {
        stop();
        watchers -= 1;
        if (watchers === 0 && retry !== undefined) {
          clearTimeout(retry);
          retry = undefined;
        }
      };
    },
    signIn: async (input) => settle(await betterAuth().signIn.email(input)),
    signUp: async (input) => settle(await betterAuth().signUp.email(input)),
    signOut: async () => {
      try {
        settle(await betterAuth().signOut());
      } finally {
        await (await store)?.set(undefined);
      }
    },
    authorizeHost: (pairing) => {
      // TODO: POST `${basePath}/auth/hosts/authorize` with redirect urn:parlor:ipc and this
      //   session's headers; answer the code.
      void pairing;
      throw new Error("not implemented");
    },
    account: createActionClient<AccountActions>({
      baseUrl,
      fetch: options.fetch,
      basePath: `${basePath}/auth`,
      headers,
    }),
  };
}

export type { HostPairing, SessionStore } from "@parlor/capabilities";
