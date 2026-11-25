import {
  ActionError,
  type ActionInput,
  type ActionMap,
  type ActionOutput,
  encodeReadRequests,
  type ReadRequest,
  REFRESH_HEADER,
  type RefreshedRead,
  type Tag,
} from "@parlor/core";

const DEFAULT_BASE_PATH = "/_parlor";
const SOURCE_HEADER = "x-parlor-source";
const CLIENT_HEADER = "x-parlor-client";

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
  /** For a write: the reads the page shows, to answer with fresh the ones it changed. */
  readonly refresh?: readonly ReadRequest[] | undefined;
}

export interface ActionEnvelope<T> {
  readonly data: T;
  readonly tags: readonly Tag[];
  /** The sync cursor a read's data reflects, when the server tracks it. */
  readonly cursor?: string | undefined;
  /** For a call with `refresh`, when the server knows it: what the write changed. */
  readonly writes?: readonly Tag[] | undefined;
  /** For a call with `refresh`, when the server knows it: each read named, in order. */
  readonly refreshed?: readonly RefreshedRead[] | undefined;
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
  /** The origin `request` reaches, for a socket to the same server; undefined when unknown. */
  origin?(): string | undefined;
  /** Hears every response the client gets, such as the sync client reading the server's build. */
  onResponse?(listener: (response: Response) => void): () => void;
}

async function resolveHeaders(
  provider: HeadersProvider | undefined,
  clientId: string,
  extra?: HeadersInit,
): Promise<Headers> {
  const headers = new Headers(
    typeof provider === "function" ? await provider() : provider,
  );
  const own = new Headers(extra);
  own.forEach((value, key) => headers.set(key, value));
  if (!own.has(SOURCE_HEADER)) headers.set(SOURCE_HEADER, "ui");
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
    headers: {
      "content-type": "application/json",
      ...(options.refresh?.length
        ? { [REFRESH_HEADER]: encodeReadRequests(options.refresh) }
        : {}),
    },
    body: JSON.stringify(input ?? {}),
    signal: options.signal ?? null,
  });
  if (!response.ok) {
    throw await toActionError(
      response,
      options.missingIsNotFound ? { missingIsNotFound: true } : {},
    );
  }
  const body = (await response.json()) as {
    data: ActionOutput<T[K]>;
    tags?: Tag[];
    cursor?: string;
    writes?: Tag[];
    refreshed?: RefreshedRead[];
  };
  return {
    data: body.data,
    tags: body.tags ?? [],
    ...(typeof body.cursor === "string" ? { cursor: body.cursor } : {}),
    ...(Array.isArray(body.writes) && Array.isArray(body.refreshed)
      ? { writes: body.writes, refreshed: body.refreshed }
      : {}),
  };
}

export function resolveServerOrigin(): string {
  return globalThis.location?.origin ?? "";
}

/**
 * The one name of this app's backend on every surface: the page's own origin, else
 * `serverUrl` off a page. Statements are signed for it and the host is paired with it.
 */
export function appOrigin(serverUrl: string = resolveServerOrigin()): string {
  const page = globalThis.location?.origin ?? "";
  if (/^https?:\/\//.test(page)) return page;
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

export function createActionClient<T extends ActionMap>(
  options: ActionClientOptions = {},
): ActionClient<T> {
  const { baseUrl = "", basePath = DEFAULT_BASE_PATH, headers } = options;
  // Drawn on first use: workerd allows no random values while a module loads.
  let clientId = options.clientId;
  const ownId = () => (clientId ??= generateClientId());
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const listeners = new Set<(response: Response) => void>();

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: await resolveHeaders(headers, ownId(), init.headers),
    });
    for (const listener of listeners) listener(response);
    return response;
  };

  const invoke = async <K extends keyof T & string>(
    name: K,
    input: ActionInput<T[K]>,
    callOptions: CallOptions = {},
  ): Promise<ActionEnvelope<ActionOutput<T[K]>>> => {
    return invokeAt<T, K>(request, `${basePath}/actions/${name}`, input, callOptions);
  };

  return {
    get clientId() {
      return ownId();
    },
    basePath,
    request,
    invoke,
    origin() {
      try {
        return new URL(baseUrl || "/", globalThis.location?.href).origin;
      } catch {
        return undefined;
      }
    },
    onResponse(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    call: async (name, input, callOptions) =>
      (await invoke(name, input, callOptions)).data,
  };
}
