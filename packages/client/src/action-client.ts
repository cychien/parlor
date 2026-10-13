import {
  ActionError,
  type ActionInput,
  type ActionMap,
  type ActionOutput,
} from "@parlor/core";

const DEFAULT_BASE_PATH = "/_parlor";
const SOURCE_HEADER = "x-parlor-source";

function injectedServerUrl(): string {
  const env = (import.meta as { env?: { PARLOR_SERVER_URL?: string } }).env;
  return env?.PARLOR_SERVER_URL ?? "";
}

export type HeadersProvider = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

export interface ActionClientOptions {
  readonly baseUrl?: string | undefined;
  readonly basePath?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly headers?: HeadersProvider | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ActionClient<T extends ActionMap> {
  call<K extends keyof T & string>(
    name: K,
    input: ActionInput<T[K]>,
    options?: CallOptions,
  ): Promise<ActionOutput<T[K]>>;
}

async function resolveHeaders(provider: HeadersProvider | undefined): Promise<Headers> {
  const headers = new Headers(
    typeof provider === "function" ? await provider() : provider,
  );
  headers.set("content-type", "application/json");
  headers.set(SOURCE_HEADER, "ui");
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
  } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async call(name, input, callOptions = {}) {
      const response = await fetchImpl(`${baseUrl}${basePath}/actions/${name}`, {
        method: "POST",
        headers: await resolveHeaders(headers),
        body: JSON.stringify(input ?? {}),
        signal: callOptions.signal ?? null,
      });
      if (!response.ok) throw await toActionError(response);
      const { data } = (await response.json()) as { data: ActionOutput<T[typeof name]> };
      return data;
    },
  };
}
