import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import {
  type AuthBrowser,
  authBrowser,
  detectPlatform,
  type DeviceKey,
  deviceKey,
  type PairingPresenceKey,
  type PresencePublicKey,
  resolveCapability,
  type SessionStore,
  sessionStore,
} from "@parlor/capabilities";
import { decodeBase64url, encodeBase64url } from "@parlor/capabilities/encoding";
import {
  type ActionClient,
  appOrigin,
  type ComputerDisconnector,
  createActionClient,
  type DeviceLinker,
  type DeviceSource,
  type HostAuthorizer,
  LinkOnComputer,
  type PendingLink,
  type SessionDevice,
  type SessionSnapshot,
  type SessionSource,
  type SessionUser,
} from "@parlor/client";
import { ActionError } from "@parlor/core";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { createAuthClient as createBetterAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

import type { AccountActions } from "../account.js";
import type { nativeSignIn } from "../native-sign-in.js";
import {
  answerStatement,
  deviceCommitment,
  HOST_PAIRING_FRAGMENT,
  HOST_PAIRING_KEY,
  linkCode,
  normalizeLinkCode,
  pairingProof,
  promptStatement,
  removeStatement,
  type Statement,
  statementBytes,
  vouchStatement,
} from "../statements.js";

const DEFAULT_BASE_PATH = "/_parlor";
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const TOKEN_HEADER = "set-auth-token";
const HOST_IPC_REDIRECT = "urn:parlor:ipc";
const DEBUG_KEY = "parlor:debug";

const NATIVE_CALLBACK = "//_parlor/auth/callback";

function injectedServerUrl(): string {
  const env = (import.meta as { env?: { PARLOR_SERVER_URL?: string } }).env;
  return env?.PARLOR_SERVER_URL ?? "";
}

function injectedScheme(): string {
  const env = (import.meta as { env?: { PARLOR_APP_SCHEME?: string } }).env;
  return env?.PARLOR_APP_SCHEME ?? "";
}

const nativeSignInClient = {
  id: "parlor-native-sign-in",
  $InferServerPlugin: {} as ReturnType<typeof nativeSignIn>,
  atomListeners: [
    { matcher: (path: string) => path === "/native/token", signal: "$sessionSignal" },
  ],
} satisfies BetterAuthClientPlugin;

const randomText = (bytes: number) =>
  encodeBase64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64url(new Uint8Array(digest));
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
  /** Where this device's signing keys live. Defaults to the `deviceKey` capability. */
  readonly deviceKey?: DeviceKey | undefined;
  /** Where social sign-in runs. Defaults to the `authBrowser` capability. */
  readonly browser?: AuthBrowser | undefined;
  /** The app's URL scheme, where social sign-in returns in a native shell. Defaults to `app.scheme`. */
  readonly scheme?: string | undefined;
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

export type DeviceHandle = SessionDevice;

export interface SocialSignInInput {
  /** A provider in Better Auth's `socialProviders`, or a `genericOAuth` provider id. */
  readonly provider: string;
  /** On the web, the page the provider returns to once signed in. Defaults to `/`. */
  readonly callbackURL?: string | undefined;
  /** On the web, the page a failed sign-in returns to with `?error=`. Defaults to this page. */
  readonly errorCallbackURL?: string | undefined;
}

export interface AuthClient
  extends
    SessionSource,
    DeviceSource,
    HostAuthorizer,
    DeviceLinker,
    ComputerDisconnector {
  deviceSetup(): Promise<"needed" | "ready">;
  /** Plug into `createActionClient({ headers })` so every surface carries the session. */
  readonly headers: () => Promise<HeadersInit>;
  signIn(input: { readonly email: string; readonly password: string }): Promise<void>;
  signUp(input: {
    readonly name: string;
    readonly email: string;
    readonly password: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  /** Sign-in with a one-time code sent by email, through Better Auth's `emailOTP` plugin. */
  readonly emailOtp: {
    send(input: { readonly email: string }): Promise<void>;
    /** Signs in, creating the account on first use unless the plugin disables sign-up. */
    signIn(input: {
      readonly email: string;
      readonly otp: string;
      readonly name?: string | undefined;
    }): Promise<void>;
  };
  /** Sign-in with a provider such as Google, through Better Auth's `socialProviders`. */
  readonly social: {
    /** Whether this platform can run it: false in a native shell without the `authBrowser` capability. */
    available(): Promise<boolean>;
    /**
     * On the web the page leaves for the provider and comes back to `callbackURL`, so this
     * never resolves. In a native shell the provider opens in the system's sign-in browser
     * and this resolves once the app is signed in; it throws `AuthClientError` with code
     * `CANCELLED` when the user closes it.
     */
    signIn(input: SocialSignInInput): Promise<void>;
  };
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

const ANONYMOUS_SESSION: SessionSnapshot = { status: "anonymous" };

const BROWSERS = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
] as const;

const SYSTEMS = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
] as const;

function deviceName(): string {
  const agent = globalThis.navigator?.userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "This device";
}

function debugStatements(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(DEBUG_KEY)?.split(",").includes("statements") ??
      false
    );
  } catch {
    return false;
  }
}

async function logSigned(statement: Statement): Promise<void> {
  if (!debugStatements()) return;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(statementBytes(statement)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  console.info(`[parlor] signed ${statement.kind} sha256=${hex}`);
}

/** Takes the host's pairing secret off this page's URL, where only that redirect puts it. */
function keepHostPairing(): void {
  try {
    const location = globalThis.location;
    if (!location?.hash) return;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const secret = fragment.get(HOST_PAIRING_FRAGMENT);
    if (!secret) return;
    globalThis.localStorage?.setItem(HOST_PAIRING_KEY, secret);
    fragment.delete(HOST_PAIRING_FRAGMENT);
    const rest = fragment.toString();
    globalThis.history?.replaceState(
      globalThis.history.state,
      "",
      `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`,
    );
  } catch {}
}

function watchHostPairing(listener: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key === HOST_PAIRING_KEY || event.key === null) listener();
  };
  globalThis.addEventListener?.("storage", changed);
  return () => globalThis.removeEventListener?.("storage", changed);
}

function hostPairing(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(HOST_PAIRING_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const serverHasNoAuth = (error: { readonly status?: unknown }) => error.status === 404;

function enrollmentPresence(presence: PresencePublicKey | undefined, rpId: string) {
  if (!presence) return undefined;
  return presence.format === "webauthn"
    ? {
        format: "webauthn" as const,
        credentialId: presence.credentialId,
        rpId,
        publicKey: { ...presence.publicKey },
        attestation: presence.attestation,
      }
    : {
        format: "es256-raw" as const,
        keyId: presence.keyId,
        publicKey: { ...presence.publicKey },
      };
}

function registered(
  presence: ReturnType<typeof enrollmentPresence>,
): PairingPresenceKey | undefined {
  if (presence?.format !== "webauthn") return presence;
  const { attestation: _attestation, ...key } = presence;
  return key;
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return globalThis.location.hostname;
  }
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  keepHostPairing();
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
      plugins: [oauthProviderClient(), emailOTPClient(), nativeSignInClient],
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
    if (!state.error || serverHasNoAuth(state.error)) {
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
    if (state.error) {
      if (serverHasNoAuth(state.error)) snapshot = ANONYMOUS_SESSION;
      // Only the server saying there is no session signs the user out, never an unreachable one.
      return snapshot;
    }
    const user = state.data?.user;
    snapshot = user
      ? { status: "signed-in", user: { id: user.id, name: user.name, email: user.email } }
      : state.isPending
        ? { status: "loading" }
        : { status: "signed-out" };
    return snapshot;
  };

  const account = createActionClient<AccountActions>({
    baseUrl,
    fetch: options.fetch,
    basePath: `${basePath}/auth`,
    headers,
  });

  const signInBrowser = async (): Promise<AuthBrowser | undefined> => {
    if (options.browser) return options.browser;
    const handle = await resolveCapability(authBrowser);
    return handle.available ? handle.api : undefined;
  };

  const signInOnThePage = async (browser: AuthBrowser, input: SocialSignInInput) => {
    const page = new URL(globalThis.location.href);
    const callbackURL = new URL(input.callbackURL ?? "/", page).href;
    const errorPage = new URL(input.errorCallbackURL ?? page, page);
    errorPage.searchParams.delete("error");
    errorPage.searchParams.delete("error_description");
    const result = await betterAuth().signIn.social({
      provider: input.provider,
      callbackURL,
      errorCallbackURL: errorPage.href,
      disableRedirect: true,
    });
    settle(result);
    const url = result.data?.url;
    if (!url)
      throw new AuthClientError("The provider gave no sign-in page.", 500, undefined);
    await browser.open(url, callbackURL);
  };

  const signInInTheApp = async (browser: AuthBrowser, provider: string) => {
    const scheme = options.scheme ?? injectedScheme();
    if (!scheme) {
      throw new AuthClientError(
        "Set app.scheme in parlor.config.ts to sign in with a provider in the app.",
        0,
        "NO_SCHEME",
      );
    }
    const callback = `${scheme}:${NATIVE_CALLBACK}`;
    const verifier = randomText(32);
    const state = randomText(16);
    const start = new URL(
      `${baseUrl || globalThis.location.origin}${basePath}/auth/native/sign-in/social`,
    );
    start.search = new URLSearchParams({
      provider,
      redirect_uri: callback,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      state,
    }).toString();
    const returned = await browser.open(start.href, callback);
    if (!returned) throw new AuthClientError("Sign-in was cancelled.", 0, "CANCELLED");
    const answer = new URL(returned).searchParams;
    if (answer.get("state") !== state) {
      throw new AuthClientError(
        "This sign-in was not started here.",
        0,
        "STATE_MISMATCH",
      );
    }
    const failed = answer.get("error");
    const code = answer.get("code");
    if (failed || !code) {
      throw new AuthClientError(
        answer.get("error_description") || `Sign-in failed (${failed ?? "no code"}).`,
        400,
        failed ?? undefined,
      );
    }
    settle(await betterAuth().native.token({ code, code_verifier: verifier }));
  };

  const keysOfThisPlatform = async (): Promise<DeviceKey | undefined> => {
    const handle = await resolveCapability(deviceKey);
    return handle.available ? handle.api : undefined;
  };

  const devices = new Map<string, Promise<DeviceHandle | undefined>>();
  const enroll = async (
    user: SessionUser,
    wantsPresence: boolean,
  ): Promise<DeviceHandle | undefined> => {
    const key = options.deviceKey ?? (await keysOfThisPlatform());
    if (!key) return undefined;
    const app = appOrigin(baseUrl || undefined);
    const rpId = hostnameOf(app);
    const { challenge } = await account.call("deviceChallenge", {});
    const keys = await key.publicKeys(
      {
        rpId,
        userId: user.id,
        userName: user.email,
        challenge: decodeBase64url(challenge),
      },
      { presence: wantsPresence },
    );
    const presence = enrollmentPresence(keys.presence, rpId);
    const name = deviceName();
    const platform = detectPlatform();
    const signingKey = { ...keys.signing.publicKey };
    const { id } = await account.call("enrollDevice", {
      name,
      platform,
      challenge,
      signing: { keyId: keys.signing.keyId, publicKey: signingKey },
      ...(presence ? { presence } : {}),
      proof: keys.proof,
    });
    return {
      id,
      keys: {
        deviceId: id,
        name,
        platform,
        signingKey,
        presenceKey: registered(presence),
      },
      signPrompt: async (prompt, wanted) => {
        const at = Date.now();
        const statement = await promptStatement(app, prompt, at);
        const bytes = statementBytes(statement);
        const signature = wanted?.presence
          ? await key.sign(bytes, { presence: true })
          : await key.sign(bytes, { presence: false });
        await logSigned(statement);
        const secret = hostPairing();
        const pairing = secret && (await pairingProof(secret, id, signingKey));
        return { deviceId: id, at, signature, ...(pairing ? { pairing } : {}) };
      },
      signAnswer: async (answer, { presence: wanted }) => {
        const at = Date.now();
        const statement = await answerStatement(app, answer, at);
        const bytes = statementBytes(statement);
        const signature = wanted
          ? await key.sign(bytes, { presence: true })
          : await key.sign(bytes, { presence: false });
        await logSigned(statement);
        return { deviceId: id, at, signature };
      },
    };
  };

  const device = async (wanted?: {
    readonly presence?: boolean;
  }): Promise<DeviceHandle | undefined> => {
    const session = current();
    if (session.status !== "signed-in") return undefined;
    const known = devices.get(session.user.id);
    if (known) return known;
    // The browser that approved `connect` is on the computer, which answers its permission questions.
    const presence = wanted?.presence ?? hostPairing() === undefined;
    const enrolling = enroll(session.user, presence).catch((error: unknown) => {
      if (error instanceof ActionError && error.code === "not_found") return undefined;
      throw error;
    });
    devices.set(session.user.id, enrolling);
    enrolling.then(
      (enrolled) => {
        if (!enrolled) devices.delete(session.user.id);
      },
      () => devices.delete(session.user.id),
    );
    return enrolling;
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
    emailOtp: {
      send: async ({ email }) =>
        settle(
          await betterAuth().emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
        ),
      signIn: async ({ email, otp, name }) =>
        settle(
          await betterAuth().signIn.emailOtp({ email, otp, ...(name ? { name } : {}) }),
        ),
    },
    social: {
      available: async () => (await signInBrowser()) !== undefined,
      signIn: async (input) => {
        const browser = await signInBrowser();
        if (!browser) {
          throw new AuthClientError(
            `Signing in with ${input.provider} is not available here.`,
            0,
            "UNSUPPORTED",
          );
        }
        if (await store) await signInInTheApp(browser, input.provider);
        else await signInOnThePage(browser, input);
      },
    },
    signOut: async () => {
      try {
        settle(await betterAuth().signOut());
      } finally {
        await (await store)?.set(undefined);
      }
    },
    subscribeLink: watchHostPairing,
    linkState: async () => {
      const pairing = hostPairing() !== undefined;
      const session = current();
      if (session.status !== "signed-in") return { vouched: false, pairing };
      const known = devices.get(session.user.id);
      const key = options.deviceKey ?? (await keysOfThisPlatform());
      const silent =
        known !== undefined ||
        (key !== undefined && (await key.presenceSetup?.()) !== "needed");
      const own = silent ? await device() : undefined;
      if (!own) return { vouched: false, pairing };
      const listed = await account.call("devices", {});
      const listing = listed.find((entry) => entry.id === own.id);
      if (!listing) {
        devices.delete(session.user.id);
        return { vouched: false, pairing };
      }
      return { deviceId: own.id, vouched: listing.vouched, pairing };
    },
    startLink: async (wanted) => {
      const own = await device(wanted);
      if (!own) throw new Error("Sign in on this device first.");
      const app = appOrigin(baseUrl || undefined);
      const commitment = await deviceCommitment(
        app,
        own.id,
        own.keys.signingKey,
        own.keys.presenceKey?.publicKey,
      );
      const code = linkCode(commitment);
      const { expiresAt } = await account.call("startDeviceLink", {
        device: own.id,
        code,
      });
      return { deviceId: own.id, code, commitment, expiresAt };
    },
    resolveLink: async (from): Promise<PendingLink> => {
      const code = typeof from === "string" ? normalizeLinkCode(from) : undefined;
      const found = await account.call(
        "resolveDeviceLink",
        code ? { code } : { device: (from as { deviceId: string }).deviceId },
      );
      const commitment = await deviceCommitment(
        appOrigin(baseUrl || undefined),
        found.id,
        found.signingKey,
        found.presenceKey?.publicKey,
      );
      const matches =
        typeof from === "string"
          ? linkCode(commitment) === code
          : found.id === from.deviceId && commitment === from.commitment;
      if (!matches) {
        throw new Error(
          "The app returned a device whose keys do not match this code, so it was not linked.",
        );
      }
      return {
        id: found.id,
        name: found.name,
        platform: found.platform,
        commitment,
        code: linkCode(commitment),
      };
    },
    disconnectComputer: async (hostId) => {
      await account.call("revokeHost", { hostId });
    },
    listDevices: async () => {
      const session = current();
      if (session.status !== "signed-in") return [];
      const own = devices.has(session.user.id) ? await device() : undefined;
      const listed = await account.call("devices", {});
      return listed.map((entry) => ({ ...entry, current: entry.id === own?.id }));
    },
    removeDevice: async (id) => {
      const own = await device();
      const key = options.deviceKey ?? (await keysOfThisPlatform());
      if (!own?.keys.presenceKey || !key) {
        throw new LinkOnComputer("This device cannot confirm it is you.");
      }
      const app = appOrigin(baseUrl || undefined);
      const at = Date.now();
      const signature = await key.sign(
        statementBytes(removeStatement(app, own.id, id, at)),
        {
          presence: true,
        },
      );
      await account.call("removeDevice", {
        device: id,
        actor: own.id,
        app,
        at,
        signature,
      });
      const session = current();
      if (id === own.id && session.status === "signed-in")
        devices.delete(session.user.id);
    },
    canVouch: async () => {
      const session = current();
      if (session.status !== "signed-in") return false;
      const known = devices.get(session.user.id);
      const key = options.deviceKey ?? (await keysOfThisPlatform());
      if (!known && (await key?.presenceSetup?.()) === "needed") return false;
      return (await device())?.keys.presenceKey !== undefined;
    },
    vouch: async (link) => {
      const own = await device();
      const key = options.deviceKey ?? (await keysOfThisPlatform());
      if (!own?.keys.presenceKey || !key) {
        throw new LinkOnComputer("This device cannot confirm it is you.");
      }
      const app = appOrigin(baseUrl || undefined);
      const at = Date.now();
      const statement = vouchStatement(app, own.id, link.id, link.commitment, at);
      const signature = await key.sign(statementBytes(statement), { presence: true });
      await account.call("vouchDevice", {
        device: link.id,
        voucher: own.id,
        app,
        commitment: link.commitment,
        at,
        signature,
      });
    },
    deviceSetup: async () => {
      const session = current();
      if (session.status !== "signed-in" || devices.has(session.user.id)) return "ready";
      const key = options.deviceKey ?? (await keysOfThisPlatform());
      return (await key?.presenceSetup?.()) === "needed" ? "needed" : "ready";
    },
    device,
    authorizeHost: async (pairing) => {
      const response = await (options.fetch ?? fetch)(
        `${baseUrl}${basePath}/auth/hosts/authorize`,
        {
          method: "POST",
          headers: { ...(await headers()), "content-type": "application/json" },
          body: JSON.stringify({
            ...pairing,
            redirectUri: HOST_IPC_REDIRECT,
            decision: "connect",
          }),
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        | { code?: unknown; state?: unknown; error?: { message?: string; code?: string } }
        | undefined;
      if (
        !response.ok ||
        typeof body?.code !== "string" ||
        body.state !== pairing.state
      ) {
        throw new AuthClientError(
          body?.error?.message ?? "The computer could not be connected.",
          response.status,
          body?.error?.code,
        );
      }
      return body.code;
    },
    account,
  };
}

export type { AuthBrowser, HostPairing, SessionStore } from "@parlor/capabilities";
