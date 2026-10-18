import type {
  AgentOrigin,
  ConfirmationAnswer,
  ConfirmationPrompt,
  ConfirmationsFrame,
} from "../protocol.js";
import type { ClientDirectory, DirectoryListener } from "./directory.js";

/** The 60 s the user gets, less 1 s so a client on MCP's default 60 s timeout hears our code. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 59_000;

export const ORPHAN_GRACE_MS = 5_000;

export const MAX_PENDING_PER_SCOPE = 8;

export interface ConfirmationRequest {
  readonly scope: string;
  readonly clientId?: string | undefined;
  readonly action: string;
  readonly description: string;
  readonly input: unknown;
  readonly origin: AgentOrigin;
  readonly signal?: AbortSignal | undefined;
}

/**
 * How a confirmation ended. `unavailable`: nobody can show the card (now, or for the grace
 * period mid-wait). `cancelled`: the agent gave up, or the server is shutting down.
 */
export type ConfirmationOutcome =
  | "approved"
  | "declined"
  | "timeout"
  | "unavailable"
  | "cancelled";

export interface ConfirmationBoardOptions {
  readonly directory: ClientDirectory;
  readonly timeoutMs: number;
  readonly orphanGraceMs?: number | undefined;
  readonly maxPendingPerScope?: number | undefined;
  readonly newId?: (() => string) | undefined;
}

type Timer = ReturnType<typeof setTimeout>;

class Pending {
  readonly audience = new Set<string>();
  orphanTimer: Timer | undefined;
  #deadlineTimer: Timer | undefined;
  #settled = false;

  constructor(
    readonly id: string,
    readonly request: ConfirmationRequest,
    readonly deadline: number,
    private readonly finish: (outcome: ConfirmationOutcome) => void,
    private readonly cleanup: () => void,
  ) {}

  armDeadline(timeoutMs: number): void {
    this.#deadlineTimer = setTimeout(() => this.settle("timeout"), timeoutMs);
  }

  settle(outcome: ConfirmationOutcome): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#deadlineTimer);
    clearTimeout(this.orphanTimer);
    this.cleanup();
    this.finish(outcome);
  }
}

const EMPTY_LIST = "[]";

function jsonOf(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return item;
  });
}

export class ConfirmationBoard {
  readonly #directory: ClientDirectory;
  readonly #timeoutMs: number;
  readonly #graceMs: number;
  readonly #maxPerScope: number;
  readonly #newId: () => string;
  readonly #pending = new Map<string, Pending>();
  readonly #byScope = new Map<string, Set<Pending>>();
  readonly #sent = new Map<string, { readonly scope: string; signature: string }>();
  readonly #forgetting = new Map<string, Timer>();

  constructor(options: ConfirmationBoardOptions) {
    this.#directory = options.directory;
    this.#timeoutMs = options.timeoutMs;
    this.#graceMs = options.orphanGraceMs ?? ORPHAN_GRACE_MS;
    this.#maxPerScope = options.maxPendingPerScope ?? MAX_PENDING_PER_SCOPE;
    let ids = 0;
    this.#newId = options.newId ?? (() => `${Date.now().toString(36)}-${++ids}`);
    options.directory.subscribe(this.#changed);
  }

  ask(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    const { scope, signal } = request;
    if (signal?.aborted) return Promise.resolve("cancelled");
    if ((this.#byScope.get(scope)?.size ?? 0) >= this.#maxPerScope) {
      return Promise.resolve("unavailable");
    }
    const audience = this.#selected(request);
    if (audience.length === 0) return Promise.resolve("unavailable");

    return new Promise((resolve) => {
      const onAbort = () => pending.settle("cancelled");
      const pending = new Pending(
        this.#newId(),
        request,
        Date.now() + this.#timeoutMs,
        resolve,
        () => {
          signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(pending.id);
          const peers = this.#byScope.get(scope);
          peers?.delete(pending);
          if (peers?.size === 0) this.#byScope.delete(scope);
          this.#refresh(scope);
        },
      );
      for (const id of audience) pending.audience.add(id);
      this.#pending.set(pending.id, pending);
      let peers = this.#byScope.get(scope);
      if (!peers) this.#byScope.set(scope, (peers = new Set()));
      peers.add(pending);
      pending.armDeadline(this.#timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#refresh(scope);
    });
  }

  answer(clientId: string, scope: string, answer: ConfirmationAnswer): boolean {
    const pending = this.#pending.get(answer.id);
    if (!pending || pending.request.scope !== scope || !pending.audience.has(clientId)) {
      return false;
    }
    pending.settle(answer.approve ? "approved" : "declined");
    return true;
  }

  close(): void {
    for (const pending of [...this.#pending.values()]) pending.settle("cancelled");
    for (const timer of this.#forgetting.values()) clearTimeout(timer);
    this.#forgetting.clear();
  }

  readonly #changed: DirectoryListener = (scope, clientId, change) => {
    const peers = this.#byScope.get(scope);
    if (change === "left") {
      for (const pending of peers ?? []) pending.audience.delete(clientId);
      this.#forgetLater(clientId);
    }
    if (change === "joined") {
      this.#stopForgetting(clientId);
      if (this.#sent.has(clientId)) {
        this.#sent.set(clientId, { scope, signature: "stale" });
      }
    }
    this.#refresh(scope);
  };

  #forgetLater(clientId: string): void {
    this.#stopForgetting(clientId);
    if (!this.#sent.has(clientId)) return;
    const timer = setTimeout(() => {
      this.#forgetting.delete(clientId);
      this.#sent.delete(clientId);
    }, this.#timeoutMs);
    timer.unref();
    this.#forgetting.set(clientId, timer);
  }

  #stopForgetting(clientId: string): void {
    clearTimeout(this.#forgetting.get(clientId));
    this.#forgetting.delete(clientId);
  }

  #selected(request: ConfirmationRequest): string[] {
    const selection = this.#directory.select(request.scope, request.clientId);
    if (!selection) return [];
    return [selection.target.client, ...selection.tied]
      .filter((client) => client.canConfirm)
      .map((client) => client.id);
  }

  #canShow(clientId: string): boolean {
    return this.#directory.target(clientId)?.client.canConfirm ?? false;
  }

  #refresh(scope: string): void {
    const peers = this.#byScope.get(scope);
    if (!peers && ![...this.#sent.values()].some((sent) => sent.scope === scope)) return;
    for (const pending of peers ?? []) {
      for (const id of this.#selected(pending.request)) pending.audience.add(id);
    }
    for (const target of this.#directory.targets(scope)) {
      this.#deliver(target, [...(peers ?? [])]);
    }
    for (const pending of peers ?? []) this.#watchOrphan(pending);
  }

  #deliver(
    target: ReturnType<ClientDirectory["targets"]>[number],
    peers: readonly Pending[],
  ): void {
    const { id, scope, canConfirm } = target.client;
    const mine = canConfirm ? peers.filter((pending) => pending.audience.has(id)) : [];
    const now = Date.now();
    const prompts = mine.map((pending) => this.#prompt(pending, now));
    const signature =
      prompts.length === 0
        ? EMPTY_LIST
        : jsonOf(prompts.map(({ expiresInMs: _expires, ...rest }) => rest));
    const previous = this.#sent.get(id)?.signature;
    if (previous === signature || (previous === undefined && prompts.length === 0))
      return;
    const frame: ConfirmationsFrame = { type: "confirmations", items: prompts };
    if (!target.send(jsonOf(frame))) return;
    if (prompts.length === 0) this.#sent.delete(id);
    else this.#sent.set(id, { scope, signature });
  }

  #prompt(pending: Pending, now: number): ConfirmationPrompt {
    const { id, request, deadline } = pending;
    return {
      id,
      action: request.action,
      description: request.description,
      input: request.input ?? null,
      origin: request.origin,
      expiresInMs: Math.max(0, deadline - now),
    };
  }

  #watchOrphan(pending: Pending): void {
    const shown = [...pending.audience].some((id) => this.#canShow(id));
    if (shown) {
      clearTimeout(pending.orphanTimer);
      pending.orphanTimer = undefined;
    } else if (pending.orphanTimer === undefined) {
      pending.orphanTimer = setTimeout(
        () => pending.settle("unavailable"),
        this.#graceMs,
      );
    }
  }
}
