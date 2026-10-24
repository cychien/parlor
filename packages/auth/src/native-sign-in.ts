import { createHash } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import {
  addOAuthServerContext,
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getIP,
  getOAuthState,
} from "better-auth/api";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";
import {
  generateIdTokenNonce,
  generateState,
  getOAuthCallbackPath,
} from "better-auth/oauth2";
import { z } from "zod";

import { failure } from "./pages.js";

export const NATIVE_SIGN_IN_PATH = "/native/sign-in/social";
export const NATIVE_TOKEN_PATH = "/native/token";
/** How long the app has to redeem the code its URL scheme received. */
export const NATIVE_CODE_TTL_MS = 60_000;

const NATIVE_REQUEST = "parlorNativeSignIn";
const CODE_IDENTIFIER = "parlor-native-sign-in:";
const TOKEN_HEADER = "set-auth-token";

interface NativeRequest {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}

interface PendingCode {
  readonly sessionToken: string;
  readonly codeChallenge: string;
}

interface OAuthProvider {
  readonly id: string;
  readonly requiresIdTokenNonce?: boolean | undefined;
  readonly callbackPath?: string | undefined;
  createAuthorizationURL(input: {
    state: string;
    codeVerifier: string;
    idTokenNonce?: string | undefined;
    redirectURI: string;
  }): Promise<URL> | URL;
}

type Lazy<T> = T | (() => T | Promise<T>);

const sha256 = (text: string) => createHash("sha256").update(text).digest("base64url");
const codeIdentifier = (code: string) => `${CODE_IDENTIFIER}${sha256(code)}`;

function returnsToApp(redirectUri: string, scheme: string | undefined): boolean {
  if (!scheme) return false;
  try {
    return new URL(redirectUri).protocol === `${scheme}:`;
  } catch {
    return false;
  }
}

function withParams(url: string, params: Record<string, string | null | undefined>) {
  const target = new URL(url);
  for (const [name, value] of Object.entries(params)) {
    if (value) target.searchParams.set(name, value);
  }
  return target.href;
}

async function providerOf(
  providers: readonly Lazy<OAuthProvider>[] | undefined,
  id: string,
): Promise<OAuthProvider | undefined> {
  for (const entry of providers ?? []) {
    const provider = typeof entry === "function" ? await entry() : entry;
    if (provider.id === id) return provider;
  }
  return undefined;
}

/** Leaves the browser that ran the sign-in without the session: only the app gets it. */
function withoutSession(headers: Headers, cookies: readonly string[]): void {
  const kept = headers
    .getSetCookie()
    .filter(
      (cookie) =>
        !cookies.some(
          (name) => cookie.startsWith(`${name}=`) || cookie.startsWith(`${name}.`),
        ),
    );
  headers.delete("set-cookie");
  for (const cookie of kept) headers.append("set-cookie", cookie);
  headers.delete(TOKEN_HEADER);
}

const invalidGrant = () =>
  new APIError("BAD_REQUEST", {
    message: "This sign-in has expired or was already used. Sign in again.",
    code: "INVALID_GRANT",
  });

/**
 * Social sign-in for native shells, whose webview a provider such as Google refuses. The
 * app opens `/native/sign-in/social` in the system's sign-in browser with a PKCE challenge;
 * after Better Auth's callback the browser keeps no session and is sent to the app's URL
 * scheme with a single-use code, which only the app holding the verifier can redeem at
 * `/native/token` for a bearer token.
 */
export function nativeSignIn(options: { readonly scheme: string | undefined }) {
  const { scheme } = options;
  return {
    id: "parlor-native-sign-in",
    endpoints: {
      nativeSignInSocial: createAuthEndpoint(
        NATIVE_SIGN_IN_PATH,
        {
          method: "GET",
          query: z.object({
            provider: z.string().min(1),
            redirect_uri: z.string(),
            code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            code_challenge_method: z.literal("S256"),
            state: z.string().min(1).max(512),
          }),
        },
        async (ctx) => {
          const { provider: id, redirect_uri: redirectUri, state } = ctx.query;
          if (!returnsToApp(redirectUri, scheme)) {
            return failure(
              scheme
                ? `Sign-in can only return to this app's ${scheme}: links.`
                : "Set app.scheme in parlor.config.ts to sign in from the app.",
              400,
            );
          }
          const providers = ctx.context
            .socialProviders as unknown as Lazy<OAuthProvider>[];
          const provider = await providerOf(providers, id);
          if (!provider) {
            throw ctx.redirect(
              withParams(redirectUri, { error: "provider_not_found", state }),
            );
          }
          const request: NativeRequest = {
            redirectUri,
            codeChallenge: ctx.query.code_challenge,
            state,
          };
          await addOAuthServerContext({ [NATIVE_REQUEST]: request });
          const idTokenNonce = generateIdTokenNonce(provider);
          const flow = await generateState(ctx, { idTokenNonce });
          const url = await provider.createAuthorizationURL({
            ...flow,
            idTokenNonce,
            redirectURI: `${ctx.context.baseURL}${getOAuthCallbackPath(provider)}`,
          });
          throw ctx.redirect(url.toString());
        },
      ),
      nativeToken: createAuthEndpoint(
        NATIVE_TOKEN_PATH,
        {
          method: "POST",
          body: z.object({
            code: z.string().min(1),
            code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
          }),
        },
        async (ctx) => {
          const { internalAdapter, sessionConfig } = ctx.context;
          const stored = await internalAdapter.consumeVerificationValue(
            codeIdentifier(ctx.body.code),
          );
          if (!stored) throw invalidGrant();
          const pending = JSON.parse(stored.value) as PendingCode;
          if (!constantTimeEqual(sha256(ctx.body.code_verifier), pending.codeChallenge)) {
            await internalAdapter.deleteSession(pending.sessionToken);
            throw invalidGrant();
          }
          const headers = ctx.request?.headers;
          const session = await internalAdapter.updateSession(pending.sessionToken, {
            expiresAt: new Date(Date.now() + sessionConfig.expiresIn * 1000),
            ...(headers
              ? {
                  userAgent: headers.get("user-agent") ?? "",
                  ipAddress: getIP(headers, ctx.context.options) ?? "",
                }
              : {}),
          });
          if (!session) throw invalidGrant();
          ctx.setHeader(TOKEN_HEADER, pending.sessionToken);
          ctx.setHeader("access-control-expose-headers", TOKEN_HEADER);
          return ctx.json({ token: pending.sessionToken });
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => Boolean(ctx.path?.startsWith("/callback/")),
          handler: createAuthMiddleware(async (ctx) => {
            const request = (await getOAuthState())?.serverContext?.[NATIVE_REQUEST] as
              | NativeRequest
              | undefined;
            const headers = ctx.context.responseHeaders;
            const location = headers?.get("location");
            if (!request || !headers || !location) return;
            const session = ctx.context.newSession;
            let outcome: Record<string, string | null>;
            if (session) {
              const code = generateRandomString(32);
              const expiresAt = new Date(Date.now() + NATIVE_CODE_TTL_MS);
              const pending: PendingCode = {
                sessionToken: session.session.token,
                codeChallenge: request.codeChallenge,
              };
              await ctx.context.internalAdapter.updateSession(pending.sessionToken, {
                expiresAt,
              });
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: codeIdentifier(code),
                value: JSON.stringify(pending),
                expiresAt,
              });
              outcome = { code };
            } else {
              const failed = new URL(location, ctx.context.baseURL).searchParams;
              outcome = {
                error: failed.get("error") ?? "sign_in_failed",
                error_description: failed.get("error_description"),
              };
            }
            const { sessionToken, sessionData, dontRememberToken, accountData } =
              ctx.context.authCookies;
            withoutSession(
              headers,
              [sessionToken, sessionData, dontRememberToken, accountData].map(
                (cookie) => cookie.name,
              ),
            );
            headers.set(
              "location",
              withParams(request.redirectUri, { ...outcome, state: request.state }),
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
