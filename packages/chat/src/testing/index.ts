import { ActionError, type ActionInput, type ActionOutput } from "@parlor/core";

import type { HostItemDraft } from "../items.js";
import type { ClaimedTurn, TurnOutcome, TurnSignals } from "../model.js";
import { HOST_PROTOCOL, type HostFrame } from "../protocol.js";
import type { ChatHostActionMap } from "../server/actions.js";

export type HostActionName = keyof ChatHostActionMap;

export interface FakeHostOptions {
  /** The app server's origin, reached over real HTTP. */
  readonly origin: string;
  /** The `authorization` header for one request: a dev host token or a host assertion. */
  readonly authorize: (request: {
    readonly method: string;
    readonly url: string;
  }) => string | Promise<string>;
  readonly fetch?: typeof fetch | undefined;
  readonly name?: string | undefined;
  readonly agents?: ActionInput<ChatHostActionMap["hostHello"]>["agents"] | undefined;
}

/** One scripted step of a claimed turn, played in order by `FakeHost.run`. */
export type FakeHostStep =
  | { readonly kind: "stream"; readonly frames: readonly HostFrame[] }
  | { readonly kind: "append"; readonly items: readonly HostItemDraft[] }
  | { readonly kind: "wait_for_cancel" }
  | { readonly kind: "wait_for_answer"; readonly askId: string }
  | { readonly kind: "finish"; readonly outcome: TurnOutcome };

/**
 * A computer without an agent, for phase 3 tests: it speaks the host actions and the
 * `/stream` and `/heartbeat` routes over real HTTP, the way Parlor Host does.
 */
export interface FakeHost {
  call<K extends HostActionName>(
    name: K,
    input: ActionInput<ChatHostActionMap[K]>,
  ): Promise<ActionOutput<ChatHostActionMap[K]>>;
  hello(): Promise<ActionOutput<ChatHostActionMap["hostHello"]>>;
  /** `undefined` when no turn waits. */
  claim(): Promise<ClaimedTurn | undefined>;
  stream(turnId: ClaimedTurn["turnId"], frames: readonly HostFrame[]): Promise<Response>;
  heartbeat(): Promise<Response>;
  /** Claims the next turn and plays `script` against it. */
  run(script: readonly FakeHostStep[]): Promise<ClaimedTurn | undefined>;
}

const SIGNAL_POLL_MS = 50;
const SIGNAL_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeHost(options: FakeHostOptions): FakeHost {
  const fetchImpl = options.fetch ?? fetch;
  const base = `${options.origin.replace(/\/+$/, "")}/_parlor/chat`;

  const post = async (path: string, body: unknown): Promise<Response> => {
    const url = `${base}/${path}`;
    const authorization = await options.authorize({ method: "POST", url });
    return fetchImpl(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const call: FakeHost["call"] = async (name, input) => {
    const response = await post(`actions/${name}`, input);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (ActionError.isBody(body)) throw ActionError.fromBody(body);
      throw new Error(`${name} answered ${response.status}`);
    }
    return (body as { data: ActionOutput<ChatHostActionMap[typeof name]> }).data;
  };

  const host: FakeHost = {
    call,
    hello: () =>
      call("hostHello", {
        protocols: { min: 1, max: HOST_PROTOCOL },
        hostVersion: "fake-host",
        name: options.name ?? "Fake host",
        platform: "test",
        agents: options.agents ?? [{ id: "claude", name: "Claude", ready: true }],
      }),
    async claim() {
      try {
        return await call("hostClaim", {});
      } catch (error) {
        if (error instanceof ActionError && error.code === "not_found") return undefined;
        throw error;
      }
    },
    stream: (turnId, frames) => post("stream", { turnId, frames }),
    heartbeat: () => post("heartbeat", {}),
    async run(script) {
      const claimed = await host.claim();
      if (!claimed) return undefined;
      let afterSeq = claimed.prompt.seq;
      const signals = async (accept: (item: TurnSignals["items"][number]) => boolean) => {
        const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const batches = await call("hostSignals", {
            turns: [{ turnId: claimed.turnId, afterSeq }],
          });
          const items = batches.flatMap((batch) => batch.items);
          for (const item of items) afterSeq = Math.max(afterSeq, item.seq);
          if (items.some(accept)) return;
          await sleep(SIGNAL_POLL_MS);
        }
        throw new Error("The fake host waited for a signal that never came.");
      };
      for (const step of script) {
        switch (step.kind) {
          case "stream": {
            const response = await host.stream(claimed.turnId, step.frames);
            if (!response.ok) throw new Error(`stream answered ${response.status}`);
            break;
          }
          case "append":
            await call("hostAppend", { turnId: claimed.turnId, items: [...step.items] });
            break;
          case "wait_for_cancel":
            await signals((item) => item.kind === "cancel");
            break;
          case "wait_for_answer":
            await signals(
              (item) => item.kind === "answer" && item.body.askId === step.askId,
            );
            break;
          case "finish":
            await call("hostFinish", { turnId: claimed.turnId, outcome: step.outcome });
            break;
        }
      }
      return claimed;
    },
  };
  return host;
}
