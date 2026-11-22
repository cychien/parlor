const COOKIE = "parlor-route";
const MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * The secret that signs `parlor-route`: a split host's edge verifies it before it loads the app,
 * so it comes from the environment both read.
 */
export function routeSecret(
  env: Readonly<Record<string, unknown>> = process.env,
): string | undefined {
  for (const name of ["PARLOR_SECRET", "BETTER_AUTH_SECRET", "AUTH_SECRET"]) {
    const value = env[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * The account whose server last answered the session in `cookieHeader`, from the cookie that
 * server signed: no database read and no app code, so a split host hands the request on at
 * once. Bound to the session cookie it names, so another sign-in in the same browser is not
 * sent to the old account.
 */
export async function routedAccount(
  cookieHeader: string | null,
  secret: string | undefined,
): Promise<string | undefined> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at !== -1) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const route = cookies.get("parlor-route");
  if (!secret || !route) return undefined;
  const [account, name, print, signature, ...rest] = route.split("~");
  if (!account || !name || !print || !signature || rest.length > 0) return undefined;
  const session = cookies.get(decodeURIComponent(name));
  if (!session) return undefined;
  const encoder = new TextEncoder();
  const base64Url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const digest = base64Url(
    await crypto.subtle.digest("SHA-256", encoder.encode(session)),
  );
  if (digest.slice(0, 22) !== print) return undefined;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64Url(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`parlor-route:${account}~${name}~${print}`),
    ),
  );
  if (expected.length !== signature.length) return undefined;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return difference === 0 ? account : undefined;
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The Set-Cookie that sends the session in `sessionCookie` to `account`'s server from now on. */
export async function routeCookie(
  request: Request,
  sessionCookie: string,
  account: string,
  secret: string,
): Promise<string | undefined> {
  const session = cookieValue(request.headers.get("cookie"), sessionCookie);
  if (!session) return undefined;
  const encoder = new TextEncoder();
  const name = encodeURIComponent(sessionCookie);
  const print = toBase64Url(
    await crypto.subtle.digest("SHA-256", encoder.encode(session)),
  ).slice(0, 22);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = toBase64Url(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`parlor-route:${account}~${name}~${print}`),
    ),
  );
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${account}~${name}~${print}~${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`;
}
