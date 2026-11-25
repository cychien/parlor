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
  createSignInTestApp,
  GOOGLE_AUTHORIZE,
  lastCodeFor,
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

  it("reports a wrong code and signs nobody in", async () => {
    const { auth, tab } = webPage();
    await auth.emailOtp.send({ email: "typo@example.com" });
    await expect(
      auth.emailOtp.signIn({ email: "typo@example.com", otp: "nope" }),
    ).rejects.toMatchObject({ name: "AuthClientError", status: 400 });
    const session = await tab.fetch("/_parlor/auth/get-session");
    expect(await session.json()).toBeNull();
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
    const owner = webPage();
    await owner.auth.emailOtp.send({ email: "owner@example.com" });
    await owner.auth.emailOtp.signIn({
      email: "owner@example.com",
      otp: lastCodeFor("owner@example.com")!,
    });
    delete page.location;
    const api = app.instance.api as unknown as {
      adminCreateOAuthClient(input: {
        headers: Headers;
        body: Record<string, unknown>;
      }): Promise<{ client_id: string }>;
    };
    const client = await api.adminCreateOAuthClient({
      headers: new Headers({ authorization: `Bearer ${owner.tab.token}` }),
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

describe("social sign-in off a page", () => {
  it("is unavailable where there is no page to send to the provider", async () => {
    const auth = createAuthClient({
      baseUrl: ORIGIN,
      fetch: fetchThrough(new Browser(app.server)),
    });
    expect(await auth.social.available()).toBe(false);
    await expect(auth.social.signIn({ provider: "google" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
