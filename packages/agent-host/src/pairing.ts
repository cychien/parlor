import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  HOST_PAIRING_FRAGMENT,
  type HostGrantResponse,
  type HostPairing,
} from "@parlor/auth";

import { agentToolsName } from "./agent-tools.js";
import type { AppGrant, HostKeyPair, HostKeys } from "./grants.js";
import { workspaceOf } from "./naming.js";
import { printable } from "./prompter.js";

export const PAIRING_TIMEOUT_MS = 10 * 60_000;

export interface PairInput {
  readonly appOrigin: string;
  readonly hostName: string;
  readonly platform: string;
  /** Opens the consent page; a one-shot 127.0.0.1 listener (RFC 8252) takes its answer. */
  open(url: string): Promise<void>;
  readonly keys: HostKeys;
  readonly workspaceRoot: string;
  /** Offers, on the consent page, to let the coding agents here use the app outside its sidebar. */
  readonly offerAgentTools?: boolean | undefined;
}

export type PairOutcome =
  | {
      readonly paired: true;
      readonly grant: AppGrant;
      readonly approvedBy: HostGrantResponse["approvedBy"];
    }
  | {
      readonly paired: false;
      readonly reason: "declined_in_app" | "timeout";
    };

const MATCHING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

function matchingCode(): string {
  const part = () =>
    Array.from(
      { length: 3 },
      () => MATCHING_ALPHABET[randomInt(MATCHING_ALPHABET.length)],
    ).join("");
  return `${part()}-${part()}`;
}

async function appNameOf(origin: string): Promise<string> {
  const response = await fetch(`${origin}/_parlor/manifest`);
  if (!response.ok) {
    throw new Error(`${origin} answered HTTP ${response.status}; is it a Parlor app?`);
  }
  const manifest = (await response.json()) as {
    readonly app?: { readonly name?: unknown };
  };
  return typeof manifest.app?.name === "string"
    ? manifest.app.name
    : new URL(origin).host;
}

type Callback =
  | { readonly code: string; readonly agentTools?: boolean | undefined }
  | { readonly declined: true };

const escapeHtml = (text: string) =>
  printable(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const RESULT_STYLE = `:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--text:#1d1d1b;--muted:#5f5f5a;--line:#e2e2dc}@media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1f1f1d;--text:#ededea;--muted:#a3a39d;--line:#34342f}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}h1{font-size:20px;line-height:1.3;margin:0 0 8px}p{margin:0;color:var(--muted)}`;

function resultPage(heading: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(heading)}</title><style>${RESULT_STYLE}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

/** Holds the browser's request until the exchange settles, so the tab says what happened. */
async function loopback(state: string): Promise<{
  readonly redirectUri: string;
  readonly callback: Promise<Callback>;
  readonly answer: (heading: string, detail: string) => void;
  readonly redirect: (url: string) => void;
  readonly close: () => void;
}> {
  let deliver: (callback: Callback) => void = () => undefined;
  const callback = new Promise<Callback>((resolve) => (deliver = resolve));
  let waiting: ServerResponse | undefined;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      waiting ||
      url.pathname !== "/callback" ||
      url.searchParams.get("state") !== state
    ) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("Not this connection.");
      return;
    }
    waiting = response;
    const code = url.searchParams.get("code");
    const agentTools = url.searchParams.get("agentTools");
    deliver(
      code
        ? { code, ...(agentTools === null ? {} : { agentTools: agentTools === "on" }) }
        : { declined: true },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const answer = (heading: string, detail: string) => {
    if (!waiting || waiting.headersSent) return;
    waiting
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(resultPage(heading, detail));
  };
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    callback,
    answer,
    redirect: (url) => {
      if (!waiting || waiting.headersSent) return;
      waiting.writeHead(303, { location: url, "cache-control": "no-store" }).end();
    },
    close: () => {
      answer("Parlor Host stopped", "Go back to your terminal.");
      server.close();
    },
  };
}

async function exchange(
  origin: string,
  key: HostKeyPair,
  code: string,
  codeVerifier: string,
): Promise<HostGrantResponse> {
  const response = await fetch(`${origin}/_parlor/auth/hosts/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier,
      publicKey: key.publicKey,
      proof: await key.sign(new TextEncoder().encode(code)),
    }),
  });
  const body = (await response.json().catch(() => undefined)) as
    | (HostGrantResponse & { readonly error?: { readonly message?: string } })
    | undefined;
  if (!response.ok || !body?.grant) {
    throw new Error(body?.error?.message ?? `The app answered HTTP ${response.status}.`);
  }
  return body;
}

function timeout(ms: number): {
  readonly expired: Promise<"timeout">;
  readonly clear: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/** The pairing secret goes nowhere but the app's own origin; an older app has no landing page. */
function landingOf(origin: string, landing: string | undefined): URL {
  const url = landing === undefined ? undefined : URL.parse(landing, origin);
  return url?.origin === origin ? url : new URL("/", origin);
}

/**
 * Only the host starts a pairing: it makes the PKCE verifier, `state`, the matching code
 * and the key pair, so nothing from the web side can complete one.
 */
export async function pair(input: PairInput): Promise<PairOutcome> {
  const origin = new URL(input.appOrigin).origin;
  const appName = await appNameOf(origin);
  const toolsName = input.offerAgentTools ? agentToolsName(appName, origin) : undefined;
  const key = await input.keys.create(origin);
  const codeVerifier = base64url(randomBytes(32));
  const pairing: HostPairing = {
    hostName: input.hostName,
    platform: input.platform,
    codeChallenge: base64url(createHash("sha256").update(codeVerifier).digest()),
    state: base64url(randomBytes(16)),
    matchingCode: matchingCode(),
    keyThumbprint: key.thumbprint,
  };
  const grantOf = (granted: HostGrantResponse): AppGrant => ({
    appOrigin: origin,
    appName,
    grantId: granted.grant.id,
    hostId: granted.grant.hostId,
    account: granted.account,
    workspace: workspaceOf(input.workspaceRoot, origin),
    createdAt: Date.now(),
  });
  const deadline = timeout(PAIRING_TIMEOUT_MS);
  try {
    const listener = await loopback(pairing.state);
    try {
      const query = new URLSearchParams({
        redirectUri: listener.redirectUri,
        ...pairing,
        ...(toolsName ? { agentTools: "offered" } : {}),
      });
      await input.open(`${origin}/_parlor/auth/hosts/authorize?${query}`);
      const callback = await Promise.race([listener.callback, deadline.expired]);
      if (callback === "timeout") return { paired: false, reason: "timeout" };
      if (!("code" in callback)) {
        listener.answer("Not connected", "You cancelled the connection.");
        return { paired: false, reason: "declined_in_app" };
      }
      let granted: HostGrantResponse;
      try {
        granted = await exchange(origin, key, callback.code, codeVerifier);
      } catch (error) {
        listener.answer("Not connected", (error as Error).message);
        throw error;
      }
      await key.keep(granted.grant.id);
      const pairingSecret = base64url(randomBytes(32));
      const landing = landingOf(origin, granted.landing);
      const agentTools =
        toolsName && "agentTools" in callback ? callback.agentTools : undefined;
      if (agentTools && toolsName) landing.searchParams.set("agentTools", toolsName);
      landing.hash = new URLSearchParams({
        [HOST_PAIRING_FRAGMENT]: pairingSecret,
      }).toString();
      listener.redirect(landing.href);
      return {
        paired: true,
        grant: {
          ...grantOf(granted),
          pairingSecret,
          ...(agentTools === undefined ? {} : { agentTools: { on: agentTools } }),
        },
        approvedBy: granted.approvedBy,
      };
    } finally {
      listener.close();
    }
  } finally {
    deadline.clear();
  }
}
