import {
  type AgentOrigin,
  type UiError,
  type UiOp,
  type UiOpInput,
  type UiOpResults,
  uiOpReadOnly,
  type UiReply,
} from "../protocol.js";
import type { ClientTarget } from "./directory.js";

export class UiFailure extends Error {
  constructor(readonly error: UiError) {
    super(error.message);
  }
}

export interface BrokerOptions {
  readonly timeoutMs: number;
  readonly maxPendingPerClient?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly newId?: (() => string) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimeout?: typeof globalThis.setTimeout | undefined;
  readonly clearTimeout?: typeof globalThis.clearTimeout | undefined;
}

interface Pending {
  readonly id: string;
  readonly clientId: string;
  readonly frame: string;
  readonly readOnly: boolean;
  readonly deadline: number;
  dispatched: boolean;
  settle(outcome: UiReply | UiError): void;
}

interface Lane {
  target: ClientTarget;
  readonly queue: Pending[];
}

export interface UiReceipt {
  readonly accepted: boolean;
  readonly next?: string | undefined;
}

function unanswered(pending: Pending, reason: string): UiError {
  if (!pending.dispatched) {
    return { code: "timeout", message: `${reason} The app did not receive it.` };
  }
  if (pending.readOnly) {
    return {
      code: "timeout",
      message: `${reason} Nothing on screen changed; retrying is safe.`,
    };
  }
  return {
    code: "outcome_unknown",
    message: `${reason} The app may still have applied it; read the screen before retrying.`,
  };
}

const DEFAULT_MAX_PENDING_PER_CLIENT = 8;
const DEFAULT_MAX_PENDING = 256;

export class UiBroker {
  readonly #timeoutMs: number;
  readonly #maxPendingPerClient: number;
  readonly #maxPending: number;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #lanes = new Map<string, Lane>();

  constructor(options: BrokerOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#maxPendingPerClient =
      options.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  }

  request<O extends UiOp>(
    target: ClientTarget,
    op: O,
    input: UiOpInput<O>,
    origin: AgentOrigin,
    signal?: AbortSignal,
  ): Promise<UiOpResults[O]> {
    const clientId = target.client.id;
    if (
      this.#pending.size >= this.#maxPending ||
      (this.#lanes.get(clientId)?.queue.length ?? 0) >= this.#maxPendingPerClient
    ) {
      return Promise.reject(
        new UiFailure({
          code: "busy",
          message: "Too many UI requests are waiting for this app; try again shortly.",
        }),
      );
    }
    const id = this.#newId();
    const frame = JSON.stringify({ id, op, input, origin, timeoutMs: this.#timeoutMs });

    return new Promise<UiOpResults[O]>((resolve, reject) => {
      const giveUp = (reason: string) => this.#giveUp(pending, reason);
      const onAbort = () => giveUp("The UI request was cancelled.");
      const timer = this.#setTimeout(
        () => giveUp(`The app did not answer within ${this.#timeoutMs} ms.`),
        this.#timeoutMs,
      );
      const pending: Pending = {
        id,
        clientId,
        frame,
        readOnly: uiOpReadOnly[op],
        deadline: this.#now() + this.#timeoutMs,
        dispatched: false,
        settle: (outcome) => {
          this.#clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (!("type" in outcome)) reject(new UiFailure(outcome));
          else if (outcome.ok) resolve(outcome.result as UiOpResults[O]);
          else reject(new UiFailure(outcome.error));
        },
      };
      this.#pending.set(id, pending);
      const lane = this.#lanes.get(clientId) ?? { target, queue: [] };
      lane.target = target;
      lane.queue.push(pending);
      this.#lanes.set(clientId, lane);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (lane.queue[0] === pending) pending.dispatched = target.send(frame);
      if (signal?.aborted) onAbort();
    });
  }

  reply(clientId: string, reply: UiReply): UiReceipt {
    const pending = this.#pending.get(reply.id);
    if (!pending || pending.clientId !== clientId) return { accepted: false };
    this.#finish(pending, reply);
    return { accepted: true, next: this.#handOver(clientId) };
  }

  reconnected(target: ClientTarget): void {
    const lane = this.#lanes.get(target.client.id);
    if (!lane) return;
    lane.target = target;
    const head = lane.queue[0];
    if (head && target.send(head.frame)) head.dispatched = true;
  }

  abandon(clientId: string): void {
    for (const pending of [...(this.#lanes.get(clientId)?.queue ?? [])]) {
      this.#finish(
        pending,
        unanswered(pending, "The app client closed before it answered."),
      );
    }
  }

  close(): void {
    for (const pending of [...this.#pending.values()]) {
      this.#finish(pending, {
        code: "internal",
        message: "The server is shutting down.",
      });
    }
  }

  #giveUp(pending: Pending, reason: string): void {
    if (!this.#finish(pending, unanswered(pending, reason))) return;
    const lane = this.#lanes.get(pending.clientId);
    const next = this.#waiting(pending.clientId);
    if (lane && next) next.dispatched = lane.target.send(next.frame);
  }

  #handOver(clientId: string): string | undefined {
    const next = this.#waiting(clientId);
    if (!next) return undefined;
    next.dispatched = true;
    return next.frame;
  }

  #waiting(clientId: string): Pending | undefined {
    const head = this.#lanes.get(clientId)?.queue[0];
    return head && !head.dispatched && head.deadline > this.#now() ? head : undefined;
  }

  #finish(pending: Pending, outcome: UiReply | UiError): boolean {
    if (!this.#pending.delete(pending.id)) return false;
    const lane = this.#lanes.get(pending.clientId);
    if (lane) {
      lane.queue.splice(lane.queue.indexOf(pending), 1);
      if (lane.queue.length === 0) this.#lanes.delete(pending.clientId);
    }
    pending.settle(outcome);
    return true;
  }
}
