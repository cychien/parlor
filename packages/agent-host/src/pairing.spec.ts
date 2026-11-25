import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pair, type PairInput } from "./pairing.js";
import { type Browser, memoryHostKeys, type SpecApp, startSpecApp } from "./spec-kit.js";

let app: SpecApp;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubEnv("PARLOR_APP_NAME", "Hello");
  app = await startSpecApp();
}, 60_000);

afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function connectAs(
  browser: Browser,
  options: {
    readonly decision?: "connect" | "cancel";
    readonly tokenAnswer?: Response;
    readonly landing?: string;
    readonly offerAgentTools?: boolean;
    readonly uncheck?: readonly string[];
  } = {},
) {
  const keys = memoryHostKeys();
  const opened: {
    url: string;
    page: string;
    statusesBefore: number[];
    tab: Promise<{ status: number; location: string | null; text: string }>;
  }[] = [];
  const statuses: number[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const exchange = String(args[0]).endsWith("/_parlor/auth/hosts/token");
    let response =
      exchange && options.tokenAnswer ? options.tokenAnswer : await realFetch(...args);
    if (exchange && options.landing !== undefined && response.ok) {
      response = Response.json({ ...(await response.json()), landing: options.landing });
    }
    statuses.push(response.status);
    return response;
  });
  const input: PairInput = {
    appOrigin: app.origin,
    hostName: "Alice's MacBook Pro",
    platform: "macos",
    keys,
    workspaceRoot: "/Users/alice/Parlor",
    offerAgentTools: options.offerAgentTools,
    open: async (url) => {
      const statusesBefore = [...statuses];
      const { page, answer } = await browser.consent(
        url,
        options.decision ?? "connect",
        options.uncheck,
      );
      const tab = realFetch(answer.headers.get("location")!, {
        redirect: "manual",
      }).then(async (response) => ({
        status: response.status,
        location: response.headers.get("location"),
        text: await response.text(),
      }));
      opened.push({ url, page, statusesBefore, tab });
    },
  };
  return { outcome: pair(input), keys, opened };
}

describe("pairing a computer from its terminal", { timeout: 30_000 }, () => {
  it("T4-06: reads the app's name without a session and pairs as the signed-in user", async () => {
    const bob = await app.signUp("Bob");
    const bobs = connectAs(bob);
    const bobOutcome = await bobs.outcome;
    expect(bobOutcome.paired).toBe(true);
    vi.restoreAllMocks();

    for (const authorization of [
      undefined,
      `ParlorHost ${await bobs.keys.assert(app.origin, {
        method: "GET",
        url: `${app.origin}/_parlor/manifest`,
      })}`,
    ]) {
      const response = await fetch(`${app.origin}/_parlor/manifest`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { app?: unknown }).app).toEqual({
        name: "Hello",
      });
    }

    const alice = await app.signUp("Alice");
    const alices = connectAs(alice);
    const outcome = await alices.outcome;

    expect(alices.opened).toHaveLength(1);
    const [opened] = alices.opened;
    expect(new URL(opened!.url).pathname).toBe("/_parlor/auth/hosts/authorize");
    expect(
      opened!.statusesBefore.filter((status) => status === 401 || status === 403),
    ).toEqual([]);
    expect(opened!.page).toContain("Connect Alice&#39;s MacBook Pro to Hello?");
    expect(opened!.page.replace(/<input [^>]*>/g, "")).not.toContain(
      new URL(opened!.url).searchParams.get("matchingCode")!,
    );
    const tab = await opened!.tab;
    expect(tab.status).toBe(303);
    const back = new URL(tab.location!);
    expect(back.origin + back.pathname).toBe(
      `${app.origin}/_parlor/auth/hosts/connected`,
    );
    const secret = new URLSearchParams(back.hash.slice(1)).get("parlor-host-pairing");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const landed = await realFetch(back);
    expect(landed.status).toBe(200);
    expect(landed.headers.get("content-security-policy")).toMatch(
      /script-src 'sha256-[A-Za-z0-9+/]+=*'/,
    );
    const html = await landed.text();
    expect(html).toContain("<h1>Connected to Hello</h1>");
    expect(html).toContain('localStorage.setItem("parlor:host-pairing",s)');
    expect(outcome).toMatchObject({
      paired: true,
      grant: {
        appOrigin: app.origin,
        appName: "Hello",
        account: { email: "alice@example.com" },
        workspace: `/Users/alice/Parlor/${new URL(app.origin).host.replace(":", "-")}`,
        pairingSecret: secret,
      },
    });
    expect(alices.keys.origins()).toEqual([app.origin]);
  });

  it("offers the agents on the computer the app, and lands on a page that names it for them", async () => {
    const attempt = connectAs(await app.signUp("Grace"), { offerAgentTools: true });
    const outcome = await attempt.outcome;
    expect(attempt.opened[0]!.page).toContain('name="useAgentTools" value="on" checked');
    expect(outcome).toMatchObject({ paired: true, grant: { agentTools: { on: true } } });
    const back = new URL((await attempt.opened[0]!.tab).location!);
    const name = `hello-${new URL(app.origin).host.replace(/[^a-z0-9]+/g, "-")}`;
    expect(back.searchParams.get("agentTools")).toBe(name);
    const landed = await (await realFetch(back)).text();
    expect(landed).toContain(`ask them to “use <code>${name}</code> to …”`);
  });

  it("keeps the app to the sidebar when the user unticks it", async () => {
    const attempt = connectAs(await app.signUp("Heidi"), {
      offerAgentTools: true,
      uncheck: ["useAgentTools"],
    });
    expect(await attempt.outcome).toMatchObject({
      paired: true,
      grant: { agentTools: { on: false } },
    });
    const back = new URL((await attempt.opened[0]!.tab).location!);
    expect(back.searchParams.has("agentTools")).toBe(false);
  });

  it("sends the pairing secret to no landing page off the app's origin", async () => {
    for (const [name, landing] of [
      ["Erin", "https://elsewhere.example/connected"],
      ["Frank", "//elsewhere.example/"],
    ] as const) {
      const attempt = connectAs(await app.signUp(name), { landing });
      expect((await attempt.outcome).paired).toBe(true);
      const back = new URL((await attempt.opened[0]!.tab).location!);
      expect(back.origin + back.pathname).toBe(`${app.origin}/`);
      expect(back.hash).toMatch(/^#parlor-host-pairing=/);
      vi.restoreAllMocks();
    }
  });

  it("connects on the consent page alone and keeps no key when the exchange fails", async () => {
    const carol = await app.signUp("Carol");
    const attempt = connectAs(carol, {
      tokenAnswer: Response.json(
        { error: { message: "This code has expired." } },
        { status: 400 },
      ),
    });
    await expect(attempt.outcome).rejects.toThrow("This code has expired.");
    expect(attempt.keys.origins()).toEqual([]);
    const { text } = await attempt.opened[0]!.tab;
    expect(text).toContain("<h1>Not connected</h1>");
    expect(text).toContain("This code has expired.");
  });

  it("stops when the consent page is cancelled", async () => {
    const dave = await app.signUp("Dave");
    const attempt = connectAs(dave, { decision: "cancel" });
    expect(await attempt.outcome).toEqual({ paired: false, reason: "declined_in_app" });
    expect(attempt.keys.origins()).toEqual([]);
    expect((await attempt.opened[0]!.tab).text).toContain(
      "You cancelled the connection.",
    );
  });

  it("T4-10: the tab shows what the app said went wrong without control characters or markup", async () => {
    const hostile = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const path = new URL(request.url ?? "/", "http://stub").pathname;
        const [status, body] =
          path === "/_parlor/manifest"
            ? [200, { protocol: 1, app: { name: "Hello" } }]
            : [400, { error: { message: "\u001b[2J<b>Expired</b>\u0007\u009b0m" } }];
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
    let tab: Promise<string> = Promise.resolve("");
    try {
      await pair({
        appOrigin: `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`,
        hostName: "Alice's MacBook Pro",
        platform: "macos",
        keys: memoryHostKeys(),
        workspaceRoot: "/Users/alice/Parlor",
        open: async (url) => {
          const asked = new URL(url);
          const callback = new URL(asked.searchParams.get("redirectUri")!);
          callback.searchParams.set("state", asked.searchParams.get("state")!);
          callback.searchParams.set("code", "code-1");
          tab = fetch(callback).then((response) => response.text());
        },
      }).catch(() => undefined);
    } finally {
      await new Promise((resolve) => hostile.close(resolve));
    }
    const html = await tab;
    expect(
      [...html].filter((char) => {
        const code = char.codePointAt(0)!;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }),
    ).toEqual([]);
    expect(html).toContain("<h1>Not connected</h1>");
    expect(html).toContain("[2J&#60;b&#62;Expired&#60;/b&#62;0m");
  });
});
