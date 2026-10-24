import { createHash, randomBytes } from "node:crypto";

import { createDatabase, type DatabaseHandle } from "@parlor/data";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ParlorAuthOptions } from "./better-auth.js";
import { NATIVE_CODE_TTL_MS } from "./native-sign-in.js";
import { Browser, ORIGIN, type TestApp } from "./testing/app.js";
import {
  ALICE,
  APP_CALLBACK,
  createSignInTestApp,
  FAKE_PROVIDER,
  GOOGLE_AUTHORIZE,
  lastCodeFor,
  SHELL_ORIGIN,
  stubProviders,
} from "./testing/sign-in.js";

let database: DatabaseHandle;
const apps: TestApp[] = [];

beforeAll(async () => {
  database = await createDatabase({ dataDir: "memory://" });
}, 30_000);

afterAll(async () => {
  await database.close();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.server.close();
});

function testApp(auth: Partial<ParlorAuthOptions> = {}): TestApp {
  const app = createSignInTestApp(database, auth);
  apps.push(app);
  return app;
}

/** The app's side of PKCE: the verifier never leaves it, the challenge rides the URL. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

const startUrl = (query: Record<string, string>) =>
  `/_parlor/auth/native/sign-in/social?${new URLSearchParams({
    redirect_uri: APP_CALLBACK,
    code_challenge_method: "S256",
    state: "app-state",
    ...query,
  })}`;

/** The system browser runs the provider's round trip and lands on the app's URL scheme. */
async function signInThroughBrowser(
  app: TestApp,
  { provider = "google", code = "alice-code", challenge = pkce().challenge } = {},
) {
  const browser = new Browser(app.server);
  const start = await browser.fetch(startUrl({ provider, code_challenge: challenge }));
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location")!);
  const back = await browser.fetch(
    `/_parlor/auth/callback/${provider}?${new URLSearchParams({
      code,
      state: authorize.searchParams.get("state")!,
    })}`,
  );
  return { browser, authorize, back, landed: new URL(back.headers.get("location")!) };
}

function shell(app: TestApp) {
  const browser = new Browser(app.server);
  const redeem = (code: string, verifier: string) =>
    browser.post(
      "/_parlor/auth/native/token",
      { code, code_verifier: verifier },
      { origin: SHELL_ORIGIN },
    );
  return { browser, redeem };
}

async function whoami(app: TestApp, headers: HeadersInit) {
  const response = await app.server.fetch(
    new Request(`${ORIGIN}/_parlor/actions/whoami`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      body: "{}",
    }),
  );
  const body = (await response.json()) as {
    data?: { principal?: { kind: string; userId?: string } };
  };
  return body.data ?? {};
}

const bearer = (token: string | undefined) => ({ authorization: `Bearer ${token}` });
const cookieOf = (browser: Browser) => browser.fetch("/_parlor/auth/get-session");

async function sessionsOf(app: TestApp, email: string) {
  const { internalAdapter } = await app.instance.$context;
  const user = await internalAdapter.findUserByEmail(email);
  return user ? internalAdapter.listSessions(user.user.id) : [];
}

async function signInWithCode(app: TestApp, email: string, origin = ORIGIN) {
  const browser = new Browser(app.server);
  await browser.post(
    "/_parlor/auth/email-otp/send-verification-otp",
    { email, type: "sign-in" },
    { origin },
  );
  const otp = lastCodeFor(email)!;
  const response = await browser.post(
    "/_parlor/auth/sign-in/email-otp",
    { email, otp },
    { origin },
  );
  expect(response.status).toBe(200);
  return browser;
}

describe("email OTP", () => {
  it("signs a browser in with a cookie and a native shell in with a bearer token", async () => {
    const app = testApp();
    const web = await signInWithCode(app, "otp@example.com");
    const session = (await (await cookieOf(web)).json()) as { user: { email: string } };
    expect(session.user.email).toBe("otp@example.com");
    expect(web.token).toBeDefined();

    const native = await signInWithCode(app, "otp@example.com", SHELL_ORIGIN);
    expect(native.token).toBeDefined();
    expect((await whoami(app, bearer(native.token))).principal?.kind).toBe("user");
  });

  it("refuses a wrong code", async () => {
    const app = testApp();
    const web = new Browser(app.server);
    await web.post("/_parlor/auth/email-otp/send-verification-otp", {
      email: "wrong@example.com",
      type: "sign-in",
    });
    const response = await web.post("/_parlor/auth/sign-in/email-otp", {
      email: "wrong@example.com",
      otp: "000000x",
    });
    expect(response.status).toBe(400);
  });
});

describe("social sign-in on the web", () => {
  it("returns to the app's page with a session cookie after Google", async () => {
    const app = testApp();
    const { tokenRequests } = stubProviders({ "alice-code": ALICE });
    const browser = new Browser(app.server);
    const started = await browser.post("/_parlor/auth/sign-in/social", {
      provider: "google",
      callbackURL: `${ORIGIN}/tasks`,
    });
    const { url } = (await started.json()) as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(GOOGLE_AUTHORIZE);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/_parlor/auth/callback/google`,
    );

    const back = await browser.fetch(
      `/_parlor/auth/callback/google?code=alice-code&state=${authorize.searchParams.get("state")}`,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`${ORIGIN}/tasks`);
    expect(
      back.headers.getSetCookie().some((cookie) => cookie.includes("session_token")),
    ).toBe(true);
    expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();
    const session = (await (await cookieOf(browser)).json()) as {
      user: { email: string };
    };
    expect(session.user.email).toBe(ALICE.email);
  });

  it("resumes an MCP client's authorization after the user signs in with Google", async () => {
    const app = testApp();
    stubProviders({ "alice-code": ALICE });
    const browser = new Browser(app.server);
    const { challenge } = pkce();
    const owner = await signInWithCode(app, "owner@example.com", SHELL_ORIGIN);
    const api = app.instance.api as unknown as {
      adminCreateOAuthClient(input: {
        headers: Headers;
        body: Record<string, unknown>;
      }): Promise<{ client_id: string }>;
    };
    const client = await api.adminCreateOAuthClient({
      headers: new Headers(bearer(owner.token)),
      body: {
        client_name: "Agent",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        grant_types: ["authorization_code"],
        scope: "mcp",
      },
    });
    const authorize = await browser.fetch(
      `/_parlor/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:43123/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "agent-state",
        scope: "mcp",
        resource: `${ORIGIN}/_parlor/mcp`,
      })}`,
      { headers: { accept: "text/html" } },
    );
    const signInPage = new URL(authorize.headers.get("location")!, ORIGIN);
    expect(signInPage.pathname).toBe("/sign-in");
    expect(signInPage.searchParams.has("sig")).toBe(true);

    const started = await browser.post("/_parlor/auth/sign-in/social", {
      provider: "google",
      callbackURL: `${ORIGIN}/`,
      oauth_query: signInPage.search.slice(1),
    });
    const google = new URL(((await started.json()) as { url: string }).url);
    const back = await browser.fetch(
      `/_parlor/auth/callback/google?code=alice-code&state=${google.searchParams.get("state")}`,
      { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } },
    );
    expect(back.status).toBe(302);
    expect(new URL(back.headers.get("location")!, ORIGIN).pathname).toBe(
      "/_parlor/auth/consent",
    );
  });
});

describe("social sign-in in a native shell", () => {
  it("ends in the app with a bearer token and leaves no session in the system browser", async () => {
    const app = testApp();
    stubProviders({ "alice-code": ALICE });
    const { verifier, challenge } = pkce();
    const { authorize, back, landed, browser } = await signInThroughBrowser(app, {
      challenge,
    });
    expect(`${authorize.origin}${authorize.pathname}`).toBe(GOOGLE_AUTHORIZE);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/_parlor/auth/callback/google`,
    );

    expect(back.status).toBe(302);
    expect(`${landed.protocol}//${landed.host}${landed.pathname}`).toBe(APP_CALLBACK);
    expect(landed.searchParams.get("state")).toBe("app-state");
    const code = landed.searchParams.get("code")!;
    expect(code).toMatch(/^[\w-]{32}$/);
    expect(
      back.headers.getSetCookie().some((cookie) => cookie.includes("session_")),
    ).toBe(false);
    expect(back.headers.get("set-auth-token")).toBeNull();
    expect(await (await cookieOf(browser)).json()).toBeNull();

    const app_ = shell(app);
    const redeemed = await app_.redeem(code, verifier);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.getSetCookie()).toEqual([]);
    const { token } = (await redeemed.json()) as { token: string };
    expect(app_.browser.token).toBe(token);
    const me = await whoami(app, bearer(token));
    expect(me.principal?.kind).toBe("user");
  });

  it("describes the session as the app that redeemed it, not the system browser", async () => {
    const app = testApp();
    stubProviders({
      "agent-code": { sub: "g-agent", email: "agent@example.com", name: "A" },
    });
    const { verifier, challenge } = pkce();
    const browser = new Browser(app.server);
    const start = await browser.fetch(
      startUrl({ provider: "google", code_challenge: challenge }),
      {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Chrome/155.0",
        },
      },
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await browser.fetch(
      `/_parlor/auth/callback/google?code=agent-code&state=${state}`,
      {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Chrome/155.0",
        },
      },
    );
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    await new Browser(app.server).post(
      "/_parlor/auth/native/token",
      { code, code_verifier: verifier },
      { origin: SHELL_ORIGIN, "user-agent": "Hello/1.0 (iPhone; iOS 26.5)" },
    );
    const [session] = await sessionsOf(app, "agent@example.com");
    expect(session!.userAgent).toBe("Hello/1.0 (iPhone; iOS 26.5)");
  });

  it("keeps the session short-lived until the app redeems its code", async () => {
    const app = testApp();
    stubProviders({
      "pending-code": { sub: "g-pending", email: "pending@example.com", name: "P" },
    });
    const { verifier, challenge } = pkce();
    const { landed } = await signInThroughBrowser(app, {
      code: "pending-code",
      challenge,
    });
    const [pending] = await sessionsOf(app, "pending@example.com");
    expect(pending!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      NATIVE_CODE_TTL_MS,
    );

    await shell(app).redeem(landed.searchParams.get("code")!, verifier);
    const [redeemed] = await sessionsOf(app, "pending@example.com");
    expect(redeemed!.expiresAt.getTime() - Date.now()).toBeGreaterThan(24 * 3600_000);
  });

  it("redeems a code once", async () => {
    const app = testApp();
    stubProviders({ "alice-code": ALICE });
    const { verifier, challenge } = pkce();
    const { landed } = await signInThroughBrowser(app, { challenge });
    const code = landed.searchParams.get("code")!;
    const app_ = shell(app);
    expect((await app_.redeem(code, verifier)).status).toBe(200);
    const replay = await app_.redeem(code, verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code: string }).code).toBe("INVALID_GRANT");
  });

  it("refuses a code redeemed after it expires", async () => {
    const app = testApp();
    stubProviders({
      "late-code": { sub: "g-late", email: "late@example.com", name: "Late" },
    });
    const { verifier, challenge } = pkce();
    const { landed } = await signInThroughBrowser(app, { code: "late-code", challenge });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + NATIVE_CODE_TTL_MS + 1000);
    const late = await shell(app).redeem(landed.searchParams.get("code")!, verifier);
    expect(late.status).toBe(400);
    expect(((await late.json()) as { code: string }).code).toBe("INVALID_GRANT");
  });

  it("refuses another app that caught the redirect without the verifier, and burns the code and its session", async () => {
    const app = testApp();
    stubProviders({
      "stolen-code": { sub: "g-victim", email: "victim@example.com", name: "V" },
    });
    const { verifier, challenge } = pkce();
    const { landed } = await signInThroughBrowser(app, {
      code: "stolen-code",
      challenge,
    });
    const code = landed.searchParams.get("code")!;

    const attacker = shell(app);
    const stolen = await attacker.redeem(code, pkce().verifier);
    expect(stolen.status).toBe(400);
    expect(attacker.browser.token).toBeUndefined();
    expect(await sessionsOf(app, "victim@example.com")).toEqual([]);

    expect((await shell(app).redeem(code, verifier)).status).toBe(400);
  });

  it("returns a provider's refusal to the app instead of a session", async () => {
    const app = testApp();
    const browser = new Browser(app.server);
    const start = await browser.fetch(
      startUrl({ provider: "google", code_challenge: pkce().challenge }),
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const back = await browser.fetch(
      `/_parlor/auth/callback/google?error=access_denied&state=${state}`,
    );
    const landed = new URL(back.headers.get("location")!);
    expect(`${landed.protocol}//${landed.host}${landed.pathname}`).toBe(APP_CALLBACK);
    expect(landed.searchParams.get("error")).toBe("access_denied");
    expect(landed.searchParams.get("state")).toBe("app-state");
    expect(landed.searchParams.has("code")).toBe(false);
  });

  it("works with a generic OAuth provider", async () => {
    const app = testApp();
    stubProviders({
      "fake-code": { sub: "fake-bob", email: "bob@example.com", name: "Bob" },
    });
    const { verifier, challenge } = pkce();
    const { authorize, landed } = await signInThroughBrowser(app, {
      provider: "fake",
      code: "fake-code",
      challenge,
    });
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${FAKE_PROVIDER}/authorize`);
    const redeemed = await shell(app).redeem(landed.searchParams.get("code")!, verifier);
    const { token } = (await redeemed.json()) as { token: string };
    expect((await whoami(app, bearer(token))).principal?.kind).toBe("user");
  });

  it("sends an unknown provider back to the app", async () => {
    const app = testApp();
    const start = await new Browser(app.server).fetch(
      startUrl({ provider: "nope", code_challenge: pkce().challenge }),
    );
    const landed = new URL(start.headers.get("location")!);
    expect(landed.protocol).toBe("hello:");
    expect(landed.searchParams.get("error")).toBe("provider_not_found");
    expect(landed.searchParams.get("state")).toBe("app-state");
  });

  it.each([
    ["https://evil.example/callback"],
    ["other://_parlor/auth/callback"],
    ["not a url"],
  ])("refuses to return anywhere but the app's scheme (%s)", async (redirect) => {
    const app = testApp();
    const start = await new Browser(app.server).fetch(
      startUrl({
        provider: "google",
        code_challenge: pkce().challenge,
        redirect_uri: redirect,
      }),
    );
    expect(start.status).toBe(400);
    expect(start.headers.get("location")).toBeNull();
    expect(await start.text()).toContain("hello:");
  });

  it("refuses when the app has no URL scheme", async () => {
    const app = testApp({ scheme: undefined });
    const start = await new Browser(app.server).fetch(
      startUrl({ provider: "google", code_challenge: pkce().challenge }),
    );
    expect(start.status).toBe(400);
    expect(await start.text()).toContain("app.scheme");
  });

  it("refuses a challenge that is not S256", async () => {
    const app = testApp();
    const start = await new Browser(app.server).fetch(
      startUrl({
        provider: "google",
        code_challenge: "plain",
        code_challenge_method: "plain",
      }),
    );
    expect(start.status).toBe(400);
  });
});
