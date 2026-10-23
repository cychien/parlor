import {
  ActionError,
  type ActionInput,
  type ActionMap,
  type ActionOutput,
  SHELL_ORIGINS,
  type Tag,
} from "@parlor/core";

const DEFAULT_BASE_PATH = "/_parlor";
const SOURCE_HEADER = "x-parlor-source";
const CLIENT_HEADER = "x-parlor-client";

function injectedServerUrl(): string {
  const env = (import.meta as { env?: { PARLOR_SERVER_URL?: string } }).env;
  return env?.PARLOR_SERVER_URL ?? "";
}

export function generateClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export type HeadersProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface ActionClientOptions {
  readonly baseUrl?: string | undefined;
  readonly basePath?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly headers?: HeadersProvider | undefined;
  readonly clientId?: string | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ActionEnvelope<T> {
  readonly data: T;
  readonly tags: readonly Tag[];
}

export interface ActionClient<T extends ActionMap> {
  readonly clientId: string;
  readonly basePath: string;
  call<K extends keyof T & string>(
    name: K,
    input: ActionInput<T[K]>,
    options?: CallOptions,
  ): Promise<ActionOutput<T[K]>>;
  invoke<K extends keyof T & string>(
    name: K,
    input: ActionInput<T[K]>,
    options?: CallOptions,
  ): Promise<ActionEnvelope<ActionOutput<T[K]>>>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

async function resolveHeaders(
  provider: HeadersProvider | undefined,
  clientId: string,
  extra?: HeadersInit,
): Promise<Headers> {
  const headers = new Headers(
    typeof provider === "function" ? await provider() : provider,
  );
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  headers.set(SOURCE_HEADER, "ui");
  headers.set(CLIENT_HEADER, clientId);
  return headers;
}

export async function toActionError(
  response: Response,
  options: { readonly missingIsNotFound?: boolean } = {},
): Promise<ActionError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (ActionError.isBody(body)) return ActionError.fromBody(body);
  const code =
    options.missingIsNotFound && response.status === 404 ? "not_found" : "internal";
  return new ActionError(code, `Action request failed with HTTP ${response.status}`);
}

export async function invokeAt<T extends ActionMap, K extends keyof T & string>(
  request: ActionClient<ActionMap>["request"],
  path: string,
  input: ActionInput<T[K]>,
  options: CallOptions & { readonly missingIsNotFound?: boolean } = {},
): Promise<ActionEnvelope<ActionOutput<T[K]>>> {
  const response = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: options.signal ?? null,
  });
  if (!response.ok) {
    throw await toActionError(
      response,
      options.missingIsNotFound ? { missingIsNotFound: true } : {},
    );
  }
  const body = (await response.json()) as { data: ActionOutput<T[K]>; tags?: Tag[] };
  return { data: body.data, tags: body.tags ?? [] };
}

export function resolveServerOrigin(): string {
  return injectedServerUrl() || globalThis.location?.origin || "";
}

function injectedAppOrigin(): string {
  const env = (import.meta as { env?: { PARLOR_APP_ORIGIN?: string } }).env;
  return env?.PARLOR_APP_ORIGIN ?? "";
}

/**
 * The one name of this app's backend on every surface: the page's own origin when it is
 * served over http(s) and is not a shell's webview origin, else the shell's `server.url`.
 * `parlor dev` running several targets names the web target's origin for all of them.
 * Statements are signed for it and the host is paired with it.
 */
export function appOrigin(
  serverUrl: string = resolveServerOrigin(),
  injected: string = injectedAppOrigin(),
): string {
  if (injected) return new URL(injected).origin;
  const page = globalThis.location?.origin ?? "";
  if (/^https?:\/\//.test(page) && !SHELL_ORIGINS.includes(page)) return page;
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

export function createActionClient<T extends ActionMap>(
  options: ActionClientOptions = {},
): ActionClient<T> {
  const {
    baseUrl = injectedServerUrl(),
    basePath = DEFAULT_BASE_PATH,
    headers,
    clientId = generateClientId(),
  } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const request = async (path: string, init: RequestInit = {}) =>
    fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: await resolveHeaders(headers, clientId, init.headers),
    });

  const invoke = async <K extends keyof T & string>(
    name: K,
    input: ActionInput<T[K]>,
    callOptions: CallOptions = {},
  ): Promise<ActionEnvelope<ActionOutput<T[K]>>> => {
    return invokeAt<T, K>(request, `${basePath}/actions/${name}`, input, callOptions);
  };

  return {
    clientId,
    basePath,
    request,
    invoke,
    call: async (name, input, callOptions) =>
      (await invoke(name, input, callOptions)).data,
  };
}
