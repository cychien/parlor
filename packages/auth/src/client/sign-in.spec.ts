import type { AuthBrowser } from "@parlor/capabilities";
import type { SessionSnapshot } from "@parlor/client";
import { createDatabase, type DatabaseHandle } from "@parlor/data";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Browser, ORIGIN, type TestApp } from "../testing/app.js";
import {
  ALICE,
  APP_CALLBACK,
  createSignInTestApp,
  GOOGLE_AUTHORIZE,
  lastCodeFor,
  SHELL_ORIGIN,
  stubProviders,
} from "../testing/sign-in.js";
import { type AuthClient, type AuthClientOptions, createAuthClient } from "./index.js";

const PAGE = `${ORIGIN}/sign-in`;

let database: DatabaseHandle;
let app: TestApp;

const page = globalThis as { window?: unknown; location?: unknown };

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
  await database.db.execute("select 1");
  page.window = globalThis;
}, 30_000);

afterAll(async () => {
  delete page.window;
  await database.close();
});

beforeEach(() => {
  app = createSignInTestApp(database);
  stubProviders({ "alice-code": ALICE });
});

afterEach(async () => {
  delete page.location;
  vi.unstubAllGlobals();
  await app.server.close();
});

function settled(auth: AuthClient): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("the session never settled"));
    }, 10_000);
    const check = () => {
      const session = auth.current();
      if (session.status === "loading") return;
      clearTimeout(deadline);
      queueMicrotask(stop);
      resolve(session);
    };
    const stop = auth.subscribe(check);
    check();
  });
}

/** A fetch that keeps cookies, as a browser tab does, through the test Browser's jar. */
const fetchThrough =
  (browser: Browser, origin?: string): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (origin) headers.set("origin", origin);
    return browser.fetch(`${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" ? {} : { body: await request.text() }),
    });
  };

function memoryStore() {
  return {
    token: undefined as string | undefined,
    get() {
      return Promise.resolve(this.token);
    },
    set(token: string | undefined) {
      this.token = token;
      return Promise.resolve();
    },
  };
}

/** The page of a web app: cookies in the tab, and the page itself goes to the provider. */
function webPage(options: Partial<AuthClientOptions> = {}, at = PAGE) {
  page.location = new URL(at);
  const tab = new Browser(app.server);
  const visits: { url: string; callbackUrl: string }[] = [];
  const browser: AuthBrowser = {
    open: (url, callbackUrl) => {
      visits.push({ url, callbackUrl });
      return new Promise(() => {});
    },
  };
  const auth = createAuthClient({
    baseUrl: ORIGIN,
    fetch: fetchThrough(tab),
    browser,
    ...options,
  });
  return { auth, tab, visits };
}

/** ASWebAuthenticationSession: its own cookies, the provider's round trip, then the app's scheme. */
function systemBrowser(
  answer: (landed: URL) => string | undefined = (landed) => landed.href,
  code = "alice-code",
) {
  const jar = new Browser(app.server);
  const opened: { url: URL; callbackUrl: string }[] = [];
  const browser: AuthBrowser = {
    open: async (url, callbackUrl) => {
      const start = new URL(url);
      opened.push({ url: start, callbackUrl });
      const toProvider = await jar.fetch(`${start.pathname}${start.search}`);
      const provider = new URL(toProvider.headers.get("location")!);
      expect(`${provider.origin}${provider.pathname}`).toBe(GOOGLE_AUTHORIZE);
      const back = await jar.fetch(
        `/_parlor/auth/callback/google?${new URLSearchParams({
          code,
          state: provider.searchParams.get("state")!,
        })}`,
      );
      const landed = new URL(back.headers.get("location")!);
      expect(landed.href.startsWith(callbackUrl)).toBe(true);
      return answer(landed);
    },
  };
  return { browser, jar, opened };
}

function nativeShell(options: Partial<AuthClientOptions> = {}) {
  const store = memoryStore();
  const auth = createAuthClient({
    baseUrl: ORIGIN,
    session: store,
    scheme: "hello",
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") request.headers.set("origin", SHELL_ORIGIN);
      return app.server.fetch(request);
    },
    ...options,
  });
  return { auth, store };
}

describe("emailOtp", () => {
  it("signs a web page in with a cookie", async () => {
    const { auth, tab } = webPage();
    await auth.emailOtp.send({ email: "web@example.com" });
    await auth.emailOtp.signIn({
      email: "web@example.com",
      otp: lastCodeFor("web@example.com")!,
      name: "Web",
    });
    expect(await settled(auth)).toMatchObject({
      status: "signed-in",
      user: { email: "web@example.com", name: "Web" },
    });
    const session = await tab.fetch("/_parlor/auth/get-session");
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
      "web@example.com",
    );
  });

  it("signs a native shell in with a bearer token in its store", async () => {
    const { auth, store } = nativeShell();
    await auth.emailOtp.send({ email: "phone@example.com" });
    await auth.emailOtp.signIn({
      email: "phone@example.com",
      otp: lastCodeFor("phone@example.com")!,
    });
    expect(store.token).toBeTruthy();
    expect(await auth.headers()).toEqual({ authorization: `Bearer ${store.token}` });
    expect(await settled(auth)).toMatchObject({
      status: "signed-in",
      user: { email: "phone@example.com" },
    });
  });

  it("reports a wrong code and stores nothing", async () => {
    const { auth, store } = nativeShell();
    await auth.emailOtp.send({ email: "typo@example.com" });
    await expect(
      auth.emailOtp.signIn({ email: "typo@example.com", otp: "nope" }),
    ).rejects.toMatchObject({ name: "AuthClientError", status: 400 });
    expect(store.token).toBeUndefined();
  });
});

describe("social sign-in on the web", () => {
  it("sends the page to Google, which returns to callbackURL signed in", async () => {
    const { auth, tab, visits } = webPage();
    void auth.social.signIn({ provider: "google", callbackURL: "/tasks" });
    await vi.waitFor(() => expect(visits).toHaveLength(1));
    const provider = new URL(visits[0]!.url);
    expect(`${provider.origin}${provider.pathname}`).toBe(GOOGLE_AUTHORIZE);
    expect(visits[0]!.callbackUrl).toBe(`${ORIGIN}/tasks`);

    const back = await tab.fetch(
      `/_parlor/auth/callback/google?code=alice-code&state=${provider.searchParams.get("state")}`,
    );
    expect(back.headers.get("location")).toBe(`${ORIGIN}/tasks`);
    expect(await auth.social.available()).toBe(true);
  });

  it("returns a failure to the sign-in page with ?error=, replacing an earlier one", async () => {
    const { auth, tab, visits } = webPage({}, `${PAGE}?error=access_denied`);
    void auth.social.signIn({ provider: "google" });
    await vi.waitFor(() => expect(visits).toHaveLength(1));
    const provider = new URL(visits[0]!.url);
    const back = await tab.fetch(
      `/_parlor/auth/callback/google?error=access_denied&state=${provider.searchParams.get("state")}`,
    );
    const landed = new URL(back.headers.get("location")!);
    expect(`${landed.origin}${landed.pathname}`).toBe(PAGE);
    expect(landed.searchParams.getAll("error")).toEqual(["access_denied"]);
  });

  it("resumes the MCP client's authorization the sign-in page was opened for", async () => {
    const agentTab = new Browser(app.server);
    const owner = nativeShell();
    await owner.auth.emailOtp.send({ email: "owner@example.com" });
    await owner.auth.emailOtp.signIn({
      email: "owner@example.com",
      otp: lastCodeFor("owner@example.com")!,
    });
    const api = app.instance.api as unknown as {
      adminCreateOAuthClient(input: {
        headers: Headers;
        body: Record<string, unknown>;
      }): Promise<{ client_id: string }>;
    };
    const client = await api.adminCreateOAuthClient({
      headers: new Headers(await owner.auth.headers()),
      body: {
        client_name: "Agent",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: ["authorization_code"],
        scope: "mcp",
      },
    });
    const authorize = await agentTab.fetch(
      `/_parlor/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43123/callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        state: "agent-state",
        scope: "mcp",
        resource: `${ORIGIN}/_parlor/mcp`,
      })}`,
      { headers: { accept: "text/html" } },
    );
    const signInPage = new URL(authorize.headers.get("location")!, ORIGIN);
    expect(signInPage.searchParams.has("sig")).toBe(true);

    const { auth, tab, visits } = webPage({}, signInPage.href);
    void auth.social.signIn({ provider: "google" });
    await vi.waitFor(() => expect(visits).toHaveLength(1));
    const provider = new URL(visits[0]!.url);
    const back = await tab.fetch(
      `/_parlor/auth/callback/google?code=alice-code&state=${provider.searchParams.get("state")}`,
      { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } },
    );
    expect(new URL(back.headers.get("location")!, ORIGIN).pathname).toBe(
      "/_parlor/auth/consent",
    );
  });
});

describe("social sign-in in a native shell", () => {
  it("runs Google in the system's sign-in browser and keeps the session as a bearer token", async () => {
    const system = systemBrowser();
    const { auth, store } = nativeShell({ browser: system.browser });
    expect(await auth.social.available()).toBe(true);
    await auth.social.signIn({ provider: "google" });

    const [{ url, callbackUrl }] = system.opened as [{ url: URL; callbackUrl: string }];
    expect(callbackUrl).toBe(APP_CALLBACK);
    expect(url.origin + url.pathname).toBe(
      `${ORIGIN}/_parlor/auth/native/sign-in/social`,
    );
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_uri")).toBe(APP_CALLBACK);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);

    expect(store.token).toBeTruthy();
    expect(await settled(auth)).toMatchObject({
      status: "signed-in",
      user: { email: ALICE.email },
    });
    expect(await (await system.jar.fetch("/_parlor/auth/get-session")).json()).toBeNull();
  });

  it("throws CANCELLED and stores nothing when the user closes the browser", async () => {
    const { auth, store } = nativeShell({ browser: { open: async () => undefined } });
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "CANCELLED",
    });
    expect(store.token).toBeUndefined();
  });

  it("reports the provider's refusal", async () => {
    const system = systemBrowser((landed) => {
      const refused = new URL(APP_CALLBACK);
      refused.search = new URLSearchParams({
        error: "access_denied",
        state: landed.searchParams.get("state")!,
      }).toString();
      return refused.href;
    });
    const { auth, store } = nativeShell({ browser: system.browser });
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "access_denied",
    });
    expect(store.token).toBeUndefined();
  });

  it("ignores a code that comes back for a sign-in it did not start", async () => {
    const system = systemBrowser((landed) => {
      landed.searchParams.set("state", "someone-else");
      return landed.href;
    });
    const { auth, store } = nativeShell({ browser: system.browser });
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      code: "STATE_MISMATCH",
    });
    expect(store.token).toBeUndefined();
  });

  it("reports a code the server refuses", async () => {
    const system = systemBrowser((landed) => {
      landed.searchParams.set("code", "forged-code");
      return landed.href;
    });
    const { auth, store } = nativeShell({ browser: system.browser });
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      name: "AuthClientError",
      status: 400,
      code: "INVALID_GRANT",
    });
    expect(store.token).toBeUndefined();
  });

  it("needs app.scheme", async () => {
    const { auth } = nativeShell({ scheme: "", browser: systemBrowser().browser });
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      code: "NO_SCHEME",
    });
  });

  it("is unavailable where no sign-in browser exists", async () => {
    const { auth } = nativeShell();
    expect(await auth.social.available()).toBe(false);
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
