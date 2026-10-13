import {
  ActionError,
  type ActionInput,
  type ActionMap,
  type ActionOutput,
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

async function toActionError(response: Response): Promise<ActionError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (ActionError.isBody(body)) return ActionError.fromBody(body);
  return new ActionError(
    "internal",
    `Action request failed with HTTP ${response.status}`,
  );
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
    const response = await request(`${basePath}/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
      signal: callOptions.signal ?? null,
    });
    if (!response.ok) throw await toActionError(response);
    const body = (await response.json()) as { data: ActionOutput<T[K]>; tags?: Tag[] };
    return { data: body.data, tags: body.tags ?? [] };
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
