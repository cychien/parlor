import type { ActionInput, ActionOutput } from "@parlor/core";

import type { HostItemDraft } from "../items.js";
import type { ClaimedTurn, TurnOutcome } from "../model.js";
import type { HostFrame } from "../protocol.js";
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

export function createFakeHost(options: FakeHostOptions): FakeHost {
  // TODO: POST `${origin}/_parlor/chat/actions/<name>` and `/_parlor/chat/stream|heartbeat`
  //   with `authorization: await authorize({ method, url })`; claim maps not_found to
  //   undefined; run plays steps, polling hostSignals for wait_for_*.
  void options;
  throw new Error("not implemented");
}
