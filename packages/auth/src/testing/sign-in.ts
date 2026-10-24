import type { DatabaseHandle } from "@parlor/data";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import { SignJWT } from "jose";
import { vi } from "vitest";

import type { ParlorAuthOptions } from "../better-auth.js";
import { createTestApp, type TestApp } from "./app.js";

export const SHELL_ORIGIN = "tauri://localhost";
export const APP_CALLBACK = "hello://_parlor/auth/callback";
export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const FAKE_PROVIDER = "https://id.example.test";

export interface Person {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

export const ALICE: Person = {
  sub: "google-alice",
  email: "alice@example.com",
  name: "Alice",
};

/**
 * Google's and a generic OIDC provider's back channel, in place of the network: each code
 * a browser brings back names a person. Undo with `vi.unstubAllGlobals()`.
 */
export function stubProviders(people: Readonly<Record<string, Person>>) {
  const tokenRequests: URLSearchParams[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === GOOGLE_TOKEN || request.url === `${FAKE_PROVIDER}/token`) {
      const body = new URLSearchParams(await request.text());
      tokenRequests.push(body);
      const person = people[body.get("code") ?? ""];
      if (!person) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const idToken = await new SignJWT({
        ...person,
        email_verified: true,
        aud: "google-client",
        iss: "https://accounts.google.com",
      })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode("google-signing-key-for-tests-only"));
      return Response.json({
        access_token: `access-${person.sub}`,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      });
    }
    if (request.url === `${FAKE_PROVIDER}/userinfo`) {
      const person = Object.values(people).find(
        (candidate) =>
          request.headers.get("authorization") === `Bearer access-${candidate.sub}`,
      );
      if (!person) return new Response(null, { status: 401 });
      return Response.json({ ...person, id: person.sub, email_verified: true });
    }
    return real(input, init);
  });
  return { tokenRequests };
}

/** Every code the `emailOTP` plugin sent, newest last. */
export const sentCodes: { email: string; otp: string }[] = [];

export const lastCodeFor = (email: string) =>
  sentCodes.findLast((entry) => entry.email === email)?.otp;

/** The test app signing in with email codes, Google and a generic OAuth provider, never a password. */
export function createSignInTestApp(
  database: DatabaseHandle,
  auth: Partial<ParlorAuthOptions> = {},
): TestApp {
  return createTestApp(database, {
    auth: {
      scheme: "hello",
      emailAndPassword: { enabled: false },
      socialProviders: {
        google: { clientId: "google-client", clientSecret: "google-secret" },
      },
      plugins: [
        emailOTP({
          sendVerificationOTP: async ({ email, otp }) => {
            sentCodes.push({ email, otp });
          },
        }),
        genericOAuth({
          config: [
            {
              providerId: "fake",
              clientId: "fake-client",
              clientSecret: "fake-secret",
              authorizationUrl: `${FAKE_PROVIDER}/authorize`,
              tokenUrl: `${FAKE_PROVIDER}/token`,
              userInfoUrl: `${FAKE_PROVIDER}/userinfo`,
              scopes: ["openid", "email", "profile"],
            },
          ],
        }),
      ],
      ...auth,
    },
  });
}
