import type { RequestId } from "@modelcontextprotocol/server";

export class McpCalls {
  readonly #inFlight = new Map<string, Set<AbortController>>();

  async run<T>(
    request: Request | undefined,
    id: RequestId,
    signals: readonly AbortSignal[],
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!request) return work(AbortSignal.any([...signals]));
    const key = keyOf(request, id);
    const cancellation = new AbortController();
    const calls = this.#inFlight.get(key) ?? new Set<AbortController>();
    calls.add(cancellation);
    this.#inFlight.set(key, calls);
    try {
      return await work(AbortSignal.any([...signals, cancellation.signal]));
    } finally {
      calls.delete(cancellation);
      if (calls.size === 0) this.#inFlight.delete(key);
    }
  }

  cancel(request: Request, id: RequestId, reason: unknown): void {
    for (const call of this.#inFlight.get(keyOf(request, id)) ?? [])
      call.abort(reason ?? new DOMException("The call was cancelled.", "AbortError"));
  }
}

const IDENTIFYING_HEADERS = ["authorization", "mcp-session-id", "user-agent"] as const;

const keyOf = (request: Request, id: RequestId): string =>
  JSON.stringify([
    ...IDENTIFYING_HEADERS.map((header) => request.headers.get(header) ?? ""),
    id,
  ]);
