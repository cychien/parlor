import { mkdir } from "node:fs/promises";

import {
  answerStatement,
  checkPairingProof,
  type PinnedDevice,
  signedPrompt,
  statementBytes,
  verifyStatement,
  type VerifyOutcome,
} from "@parlor/auth";
import {
  canonicalBytes,
  deviceCode,
  encodeBase64url,
} from "@parlor/capabilities/encoding";
import type {
  ChatEvent,
  ChatItemBody,
  ClaimedTurn,
  HostItemDraft,
  LoggedItem,
  TurnFailure,
  TurnOutcome,
  TurnSignals,
} from "@parlor/chat";
import { ActionError, asId, type ItemId } from "@parlor/core";
import type { DeviceKeys } from "@parlor/server";

import {
  type AgentAsk,
  type AgentAskAnswer,
  type AgentConnection,
  type AgentExit,
  type AgentLauncher,
  type AgentSession,
  SessionRefused,
  type StopReason,
} from "./acp.js";
import type { AgentProfile } from "./agents.js";
import { finishFold, foldUpdate, startFold, type TurnFold } from "./fold.js";
import type { AppLink } from "./link.js";
import { logEvent } from "./log.js";
import type { McpProxy, ProxySession } from "./mcp-proxy.js";
import { appServerOf, computerName } from "./naming.js";
import { approvalFor, isAppTool, type RemotePolicy } from "./policy.js";
import type { LiveSession, SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { agentEnvironment } from "./shell-path.js";
import type { TrustedDevice, TrustStore } from "./trust.js";

export interface TurnDeps {
  readonly link: AppLink;
  readonly profiles: readonly AgentProfile[];
  readonly launcher: AgentLauncher;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly trust: TrustStore;
  readonly policy: RemotePolicy;
  readonly prompter: LocalPrompter;
  readonly now: () => number;
  /** The secret the browser that approved this grant's `connect` proves, until it is used. */
  readonly pairing?: {
    secret(): Promise<string | undefined>;
    forget(): Promise<void>;
  };
}

export const PROMPT_MAX_AGE_MS = 10 * 60_000;

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const SIGNAL_POLL_MS = 500;
const MAX_APPEND_ITEMS = 64;
const APPEND_RETRY_BASE_MS = 250;
const APPEND_RETRY_MAX_MS = 4_000;
const MIN_LEASE_MS = 1_000;
const CANCEL_SETTLE_MS = 5_000;
const QUESTION_CHOICES = [
  { id: "accept", label: "Submit", effect: "allow_once" },
  { id: "decline", label: "Decline", effect: "reject_once" },
] as const;

class AgentExited extends Error {
  override readonly name = "AgentExited";
  constructor(readonly exit: AgentExit) {
    super("The agent exited.");
  }
}

interface Pending {
  readonly ask: AgentAsk;
  readonly approval: ChatItemBody<"ask">["approval"];
  readonly dialog: AbortController;
  readonly resolve: (answer: AgentAskAnswer) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class LeaseLapsed extends Error {
  override readonly name = "LeaseLapsed";
}

function lapseAfter(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LeaseLapsed("The turn's lease lapsed.")), ms);
  });
  lapsed.catch(() => undefined);
  return { lapsed, cancel: () => clearTimeout(timer) };
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

function promptMaxAgeMs(): number {
  const lowered = Number(process.env.PARLOR_HOST_PROMPT_MAX_AGE_MS);
  return lowered > 0 ? Math.min(lowered, PROMPT_MAX_AGE_MS) : PROMPT_MAX_AGE_MS;
}

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const fingerprint = (device: Pick<PinnedDevice, "signingKey" | "presenceKey">) =>
  encodeBase64url(
    canonicalBytes({ signing: device.signingKey, presence: device.presenceKey ?? null }),
  );

interface SharedApproval {
  readonly settled: Promise<boolean>;
  readonly dialog: AbortController;
  waiters: number;
}

const approvals = new Map<string, SharedApproval>();

function joinApproval(
  key: string,
  start: (signal: AbortSignal) => Promise<boolean>,
): { readonly settled: Promise<boolean>; leave(): void } {
  let shared = approvals.get(key);
  if (!shared) {
    const dialog = new AbortController();
    shared = {
      settled: start(dialog.signal).finally(() => approvals.delete(key)),
      dialog,
      waiters: 0,
    };
    approvals.set(key, shared);
  }
  const joined = shared;
  joined.waiters += 1;
  return {
    settled: joined.settled,
    leave: () => {
      joined.waiters -= 1;
      if (joined.waiters === 0) joined.dialog.abort();
    },
  };
}

function exitDetail(exit: AgentExit): string {
  if (exit.kind === "killed") return "stopped by this computer";
  const last = exit.stderrTail.trim().split("\n").at(-1)?.slice(0, 300);
  return [`exit code ${exit.code ?? "none"}`, last].filter(Boolean).join(": ");
}

function askBody(ask: AgentAsk, approval: ChatItemBody<"ask">["approval"]) {
  const body: ChatItemBody<"ask"> =
    ask.kind === "permission"
      ? {
          question: ask.title,
          choices: ask.options.map((option) => ({ ...option })),
        }
      : {
          question: ask.message,
          choices: QUESTION_CHOICES.map((choice) => ({ ...choice })),
          form: { ...ask.schema },
        };
  return approval ? { ...body, approval } : body;
}

function answerOf(
  pending: Pending,
  body: Extract<TurnSignals["items"][number], { kind: "answer" }>["body"],
): AgentAskAnswer | undefined {
  if (pending.ask.kind === "question") {
    if (body.choice === "accept") return { kind: "values", values: { ...body.values } };
    return { kind: "declined" };
  }
  if (body.choice === "declined") return { kind: "declined" };
  return pending.ask.options.some((option) => option.id === body.choice)
    ? { kind: "selected", optionId: body.choice }
    : undefined;
}

/**
 * Runs one claimed turn to its outcome and reports it with `hostFinish`: where the
 * claimed prompt, the agent's updates, the user's answers and stop, and the local policy meet.
 */
export async function runTurn(
  claimed: ClaimedTurn,
  deps: TurnDeps,
): Promise<TurnOutcome> {
  const { link, pool } = deps;
  const { calls } = link.api;
  const grant = link.grant;
  const origin = grant.appOrigin;
  const appServer = appServerOf(grant.appName);
  const agentId = claimed.agent.agentId;
  const threadId = claimed.id;
  const turnId = claimed.turnId;

  let fold: TurnFold = startFold(turnId);
  let proxy: ProxySession | undefined;
  let lost = false;
  const lostOver = new AbortController();
  const markLost = () => {
    lost = true;
    lostOver.abort();
  };
  const lostPromise = new Promise<"lost">((resolve) =>
    lostOver.signal.addEventListener("abort", () => resolve("lost"), { once: true }),
  );
  const leaseMs = Math.max(MIN_LEASE_MS, claimed.leaseUntil - deps.now());
  let cancelled = false;
  let lastWrite = deps.now();
  let appending: Promise<void> = Promise.resolve();
  const pending = new Map<ItemId, Pending>();

  const settle = (id: ItemId, answer: AgentAskAnswer) => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    waiting.dialog.abort();
    waiting.resolve(answer);
  };
  const settleAll = () => {
    for (const id of [...pending.keys()]) settle(id, { kind: "cancelled" });
  };

  const nextId = (): ItemId => {
    const id = asId("item", `${turnId}.${fold.nextId}`);
    fold = { ...fold, nextId: fold.nextId + 1 };
    return id;
  };

  const untilLeaseLapses = async <T>(call: () => Promise<T>): Promise<T> => {
    const lease = lapseAfter(leaseMs);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await Promise.race([call(), lease.lapsed]);
        } catch (error) {
          if (error instanceof ActionError || error instanceof LeaseLapsed) throw error;
          await Promise.race([
            sleep(Math.min(APPEND_RETRY_BASE_MS * 2 ** attempt, APPEND_RETRY_MAX_MS)),
            lease.lapsed,
          ]);
        }
      }
    } finally {
      lease.cancel();
    }
  };

  const send = async (items: HostItemDraft[]) => {
    const renewed = await untilLeaseLapses(() =>
      calls.call("hostAppend", { turnId, items }),
    );
    lastWrite = deps.now();
    proxy?.renew(renewed.token);
    logEvent("host_append", { turnId, itemIds: items.map((item) => item.id) });
  };

  const write = (items: readonly HostItemDraft[]) => {
    const batch = [...items];
    appending = appending.then(async () => {
      if (lost) return;
      try {
        if (batch.length === 0) {
          await send([]);
          return;
        }
        for (let at = 0; at < batch.length; at += MAX_APPEND_ITEMS) {
          await send(batch.slice(at, at + MAX_APPEND_ITEMS));
        }
      } catch {
        markLost();
      }
    });
    return appending;
  };

  const event = (name: ChatEvent, detail?: string, itemId?: ItemId) =>
    write([
      {
        id: nextId(),
        kind: "event",
        body: {
          event: name,
          ...(detail ? { detail: detail.slice(0, 500) } : {}),
          ...(itemId ? { itemId } : {}),
        },
      },
    ]);

  const finish = async (outcome: TurnOutcome): Promise<TurnOutcome> => {
    await appending;
    proxy?.end();
    if (lost) return { state: "failed", reason: "host_lost" };
    try {
      await untilLeaseLapses(() => calls.call("hostFinish", { turnId, outcome }));
    } catch (error) {
      if (error instanceof LeaseLapsed) return { state: "failed", reason: "host_lost" };
      if (!(error instanceof ActionError && error.code === "forbidden")) throw error;
    }
    return outcome;
  };

  const fail = async (reason: TurnFailure, name: ChatEvent, detail?: string) => {
    await event(name, detail);
    return finish({ state: "failed", reason });
  };

  const verifyPrompt = async (
    signed: NonNullable<Awaited<ReturnType<typeof signedPrompt>>>,
    pinned: PinnedDevice,
  ): Promise<VerifyOutcome> => {
    const outcome = await verifyStatement(signed, pinned, {
      requirePresence: false,
      now: deps.now(),
      maxAgeMs: promptMaxAgeMs(),
    });
    logEvent("statement_verified", {
      kind: "prompt",
      deviceId: pinned.deviceId,
      outcome,
      sha256: await hex(statementBytes(signed.statement)),
    });
    return outcome;
  };

  const cancelRequested = async (done: AbortSignal): Promise<"cancelled" | "stopped"> => {
    while (!done.aborted) {
      await sleep(SIGNAL_POLL_MS);
      if (done.aborted) break;
      try {
        const batches = await calls.call("hostSignals", {
          turns: [{ turnId, afterSeq: claimed.prompt.seq }],
        });
        if (batches.some((batch) => batch.items.some((item) => item.kind === "cancel"))) {
          return "cancelled";
        }
      } catch {}
    }
    return "stopped";
  };

  const approve = async (
    device: NonNullable<ClaimedTurn["device"]>,
    interrupted: Promise<"cancelled" | "stopped">,
  ) => {
    const approval = joinApproval(`${origin}\n${device.id}`, async (signal) => {
      const timeout = AbortSignal.timeout(APPROVAL_TIMEOUT_MS);
      const allowed = await deps.prompter.approveDevice({
        appName: grant.appName,
        account: grant.account,
        device: { name: device.name, platform: device.platform },
        code: await deviceCode(device.signingKey),
        signal: AbortSignal.any([signal, timeout]),
      });
      logEvent("device_prompt", {
        deviceId: device.id,
        answer: allowed
          ? "allow"
          : timeout.aborted
            ? "timeout"
            : signal.aborted
              ? "cancelled"
              : "deny",
      });
      if (!allowed) return false;
      await deps.trust.pin(origin, {
        deviceId: device.id,
        signingKey: device.signingKey,
        presenceKey: device.presenceKey,
        name: device.name,
        platform: device.platform,
        approvedAt: deps.now(),
        via: "local",
      });
      return true;
    });
    try {
      return await Promise.race([
        approval.settled.then((allowed): "allowed" | "denied" =>
          allowed ? "allowed" : "denied",
        ),
        interrupted,
      ]);
    } finally {
      approval.leave();
    }
  };

  type Admission = { readonly device: TrustedDevice } | { readonly outcome: TurnOutcome };

  const refuse = async (
    reason: TurnFailure,
    name: ChatEvent,
    detail?: string,
  ): Promise<Admission> => ({ outcome: await fail(reason, name, detail) });

  const admit = async (): Promise<Admission> => {
    const signed = await signedPrompt(origin, claimed.prompt);
    if (!signed) {
      return refuse(
        "device_rejected",
        "turn_failed",
        `Update ${grant.appName} to send messages to ${computerName()}: this version does not sign them.`,
      );
    }
    const known = await deps.trust.get(origin, signed.deviceId);
    const keys = claimed.device;
    if (known && !keys) {
      await deps.trust.forget(origin, known.deviceId);
      return refuse(
        "device_rejected",
        "device_rejected",
        "This device is no longer registered.",
      );
    }
    if (!keys || keys.id !== signed.deviceId) {
      return refuse(
        "signature_invalid",
        "turn_failed",
        "The account has no such device.",
      );
    }
    if (known && fingerprint(known) !== fingerprint(keys)) {
      return refuse("signature_invalid", "turn_failed", "This device's keys changed.");
    }
    const pinned: PinnedDevice = known ?? {
      deviceId: keys.id,
      signingKey: keys.signingKey,
      presenceKey: keys.presenceKey,
    };
    const outcome = await verifyPrompt(signed, pinned);
    if (outcome === "stale") {
      return { outcome: await finish({ state: "failed", reason: "prompt_expired" }) };
    }
    if (outcome !== "valid") {
      return refuse(
        "signature_invalid",
        "turn_failed",
        "This prompt's signature did not check out.",
      );
    }
    if (known) return { device: known };
    const proof = claimed.prompt.body.signed?.pairing;
    const secret = proof ? await deps.pairing?.secret() : undefined;
    if (
      proof &&
      secret &&
      (await checkPairingProof(secret, proof, keys.id, keys.signingKey))
    ) {
      const device: TrustedDevice = {
        ...pinned,
        name: keys.name,
        platform: keys.platform,
        approvedAt: deps.now(),
        via: "pairing",
      };
      await deps.trust.pin(origin, device);
      await deps.pairing?.forget();
      logEvent("device_trusted", { deviceId: keys.id, via: "pairing" });
      return { device };
    }
    await event("device_pending");
    const watching = new AbortController();
    const decision = await approve(
      keys,
      Promise.race([
        cancelRequested(watching.signal),
        lostPromise.then((): "stopped" => "stopped"),
      ]),
    ).finally(() => watching.abort());
    if (lost) return { outcome: { state: "failed", reason: "host_lost" } };
    if (decision === "cancelled")
      return { outcome: await finish({ state: "cancelled" }) };
    if (decision !== "allowed") return refuse("device_rejected", "device_rejected");
    return {
      device: {
        ...pinned,
        name: keys.name,
        platform: keys.platform,
        approvedAt: deps.now(),
        via: "local",
      },
    };
  };

  const proceed = async (device: TrustedDevice | undefined): Promise<TurnOutcome> => {
    const profile = deps.profiles.find((candidate) => candidate.id === agentId);
    if (!profile) {
      return fail(
        "agent_unavailable",
        "turn_failed",
        `This computer has no agent "${agentId}".`,
      );
    }

    let live: LiveSession | undefined = pool.session(grant, threadId, agentId);
    let connection: AgentConnection | undefined = pool.process(origin, agentId);
    const fresh = live === undefined;
    if (live) {
      proxy = live.proxy;
      proxy.begin(claimed.token);
    } else {
      const switched = deps.profiles.some(
        (other) =>
          other.id !== agentId && pool.session(grant, threadId, other.id) !== undefined,
      );
      if (switched) await event("agent_switched", profile.name);
      try {
        connection = await pool.launch(origin, agentId, async (signal) => {
          await mkdir(grant.workspace, { recursive: true, mode: 0o700 });
          return deps.launcher.launch(profile, {
            cwd: grant.workspace,
            env: await agentEnvironment(),
            signal,
          });
        });
        proxy = deps.proxy.open(appServer, origin);
        proxy.begin(claimed.token);
        const session: AgentSession = await connection.openSession({
          cwd: grant.workspace,
          mcpServers: [proxy.server],
          resume: await pool.resumable(grant, threadId, agentId),
          pinAskMode: true,
          strictAsk: deps.policy.answers !== "off",
        });
        live = { session, proxy };
        pool.remember(grant, threadId, agentId, live);
      } catch (error) {
        proxy?.dispose();
        proxy = undefined;
        if (error instanceof SessionRefused && error.leftOpen) {
          await pool.drop(origin, agentId);
        }
        const message = error instanceof Error ? error.message : String(error);
        return fail("agent_unavailable", "turn_failed", message);
      }
    }

    const { session } = live;
    const exited = connection!.exited.then((exit) => {
      throw new AgentExited(exit);
    });
    exited.catch(() => undefined);

    const text = claimed.prompt.body.text;
    const blocks = [
      {
        kind: "text" as const,
        text: fresh && !session.resumed ? `${claimed.context}\n\n${text}` : text,
      },
    ];
    deps.prompter.turnStarted({
      appName: grant.appName,
      device: device?.name ?? claimed.device?.name ?? "the app",
      agent: profile.name,
      preview: text.slice(0, 80),
    });

    const turnOver = new AbortController();
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void session.cancel();
      settleAll();
      turnOver.abort();
    };

    const ask = async (question: AgentAsk): Promise<AgentAskAnswer> => {
      if (cancelled) return { kind: "cancelled" };
      if (question.kind === "permission" && isAppTool(question, appServer)) {
        const allow = question.options.find((option) => option.effect === "allow_once");
        if (allow) return { kind: "selected", optionId: allow.id };
      }
      const wanted = approvalFor(deps.policy, question);
      const approval =
        wanted === "presence" && device && !device.presenceKey ? "computer" : wanted;
      const id = nextId();
      const dialog = new AbortController();
      const answered = new Promise<AgentAskAnswer>((resolve) =>
        pending.set(id, { ask: question, approval, dialog, resolve }),
      );
      await write([{ id, kind: "ask", body: askBody(question, approval) }]);
      if (approval === "computer") {
        const choices =
          question.kind === "permission" ? question.options : QUESTION_CHOICES;
        void deps.prompter
          .answerHere({
            appName: grant.appName,
            agent: profile.name,
            question: question.kind === "permission" ? question.title : question.message,
            choices,
            signal: dialog.signal,
          })
          .then((choice) => {
            const waiting = pending.get(id);
            if (!waiting) return;
            const answer =
              choice === undefined ? undefined : answerOf(waiting, { askId: id, choice });
            if (choice !== undefined && answer) {
              void write([
                {
                  id: nextId(),
                  kind: "event",
                  body: { event: "answered_on_computer", itemId: id, choice },
                },
              ]);
            }
            settle(id, answer ?? { kind: "cancelled" });
          });
      }
      return answered;
    };

    type Decided =
      | { readonly kind: "accepted" }
      | { readonly kind: "rejected"; readonly reason: string };
    type AnswerVerdict =
      | Decided
      | { readonly kind: "unpinned"; readonly device: DeviceKeys };

    const rejected = (reason: string): Decided => ({ kind: "rejected", reason });

    const verdictOf = async (
      waiting: Pending,
      item: LoggedItem<"answer">,
      devices: readonly DeviceKeys[],
    ): Promise<AnswerVerdict> => {
      if (waiting.approval === "computer") {
        return rejected("This question is answered on the computer.");
      }
      if (deps.policy.deviceApproval !== "local" && waiting.approval !== "presence") {
        return { kind: "accepted" };
      }
      const { signed, askId, choice, values } = item.body;
      const pinned = signed ? await deps.trust.get(origin, signed.deviceId) : undefined;
      const listed = signed
        ? devices.find((keys) => keys.id === signed.deviceId)
        : undefined;
      const known: PinnedDevice | undefined =
        pinned ??
        (listed && {
          deviceId: listed.id,
          signingKey: listed.signingKey,
          presenceKey: listed.presenceKey,
        });
      if (!signed || !known) {
        logEvent("statement_verified", {
          kind: "answer",
          deviceId: signed?.deviceId,
          outcome: "invalid",
        });
        return rejected("This device cannot answer here.");
      }
      const statement = await answerStatement(
        origin,
        { threadId: item.threadId, askId, choice, ...(values ? { values } : {}) },
        signed.at,
      );
      const outcome = await verifyStatement(
        { statement, deviceId: signed.deviceId, signature: signed.signature },
        known,
        {
          requirePresence: waiting.approval === "presence",
          now: deps.now(),
          maxAgeMs: PROMPT_MAX_AGE_MS,
        },
      );
      logEvent("statement_verified", {
        kind: "answer",
        deviceId: signed.deviceId,
        outcome,
        sha256: await hex(statementBytes(statement)),
      });
      if (outcome === "presence_required") {
        return rejected("This answer needs a presence check.");
      }
      if (outcome !== "valid")
        return rejected("This answer's signature did not check out.");
      return pinned || !listed
        ? { kind: "accepted" }
        : { kind: "unpinned", device: listed };
    };

    const interrupted = new Promise<"cancelled" | "stopped">((resolve) =>
      turnOver.signal.addEventListener(
        "abort",
        () => resolve(cancelled ? "cancelled" : "stopped"),
        { once: true },
      ),
    );

    const deliver = (waiting: Pending, item: LoggedItem<"answer">, verdict: Decided) => {
      const answer =
        verdict.kind === "accepted" ? answerOf(waiting, item.body) : undefined;
      if (!answer) {
        void event(
          "answer_rejected",
          verdict.kind === "rejected"
            ? verdict.reason
            : "That is not one of the choices.",
          item.id,
        );
        return;
      }
      settle(item.body.askId, answer);
    };

    const admitAnswer = async (
      waiting: Pending,
      item: LoggedItem<"answer">,
      devices: readonly DeviceKeys[],
    ) => {
      const verdict = await verdictOf(waiting, item, devices);
      if (verdict.kind !== "unpinned") {
        deliver(waiting, item, verdict);
        return;
      }
      void approve(verdict.device, interrupted).then((decision) => {
        if (decision === "cancelled" || decision === "stopped") return;
        deliver(
          waiting,
          item,
          decision === "allowed"
            ? { kind: "accepted" }
            : rejected("This device was not approved on the computer."),
        );
      });
    };

    let afterSeq = claimed.prompt.seq;
    const signalsOver = new AbortController();
    const signalsEnded = new Promise<"ended">((resolve) =>
      signalsOver.signal.addEventListener("abort", () => resolve("ended"), {
        once: true,
      }),
    );
    const signals = async () => {
      for (;;) {
        if ((await Promise.race([sleep(SIGNAL_POLL_MS), signalsEnded])) === "ended")
          return;
        let batches: TurnSignals[];
        try {
          const fetched = await Promise.race([
            calls.call("hostSignals", { turns: [{ turnId, afterSeq }] }),
            signalsEnded,
          ]);
          if (fetched === "ended") return;
          batches = fetched;
        } catch {
          continue;
        }
        for (const batch of batches) {
          for (const item of batch.items) {
            if (signalsOver.signal.aborted) return;
            afterSeq = Math.max(afterSeq, item.seq);
            if (item.kind === "cancel") {
              cancel();
              continue;
            }
            const waiting = pending.get(item.body.askId);
            if (waiting) await admitAnswer(waiting, item, batch.devices ?? []);
          }
        }
      }
    };

    let stop: StopReason | "lost" | undefined;
    let failure: AgentExited | Error | undefined;
    const prompted = session.prompt(blocks, {
      update: (update) => {
        const step = foldUpdate(fold, update, appServer);
        fold = step.fold;
        if (step.frames.length > 0) link.api.stream({ turnId, frames: step.frames });
        if (step.closed.length > 0) void write(step.closed);
      },
      ask,
    });
    prompted.catch(() => undefined);
    const signalsRan = signals().catch(() => undefined);
    try {
      stop = await Promise.race([prompted, exited, lostPromise]);
      if (stop === "lost") {
        signalsOver.abort();
        proxy?.end();
        const settled = await settlesWithin(
          Promise.allSettled([session.cancel(), prompted]),
          CANCEL_SETTLE_MS,
        );
        if (!settled) await pool.drop(origin, agentId);
      }
    } catch (error) {
      failure =
        error instanceof AgentExited
          ? error
          : await Promise.race([
              exited.catch((exit: unknown) => exit as AgentExited),
              sleep(1_000).then(() =>
                error instanceof Error ? error : new Error(String(error)),
              ),
            ]);
    } finally {
      signalsOver.abort();
      settleAll();
      turnOver.abort();
    }
    await signalsRan;

    const stopped = failure !== undefined || cancelled || stop === "cancelled";
    const final = finishFold(fold, stopped);
    fold = final.fold;
    void write(final.closed);

    if (failure) {
      await pool.drop(origin, agentId);
      const detail =
        failure instanceof AgentExited ? exitDetail(failure.exit) : failure.message;
      return fail("agent_exited", "agent_exited", detail);
    }
    if (lost) {
      proxy?.end();
      return { state: "failed", reason: "host_lost" };
    }
    return finish(
      stopped
        ? { state: "cancelled" }
        : { state: "done", stopReason: stop as StopReason },
    );
  };

  const renewEveryMs = Math.max(1_000, (claimed.leaseUntil - deps.now()) / 2);
  const renewal = setInterval(() => {
    if (deps.now() - lastWrite >= renewEveryMs) void write([]);
  }, renewEveryMs / 4);
  try {
    if (deps.policy.deviceApproval === "local") {
      const admission = await admit();
      if ("outcome" in admission) return admission.outcome;
      return await proceed(admission.device);
    }
    return await proceed(undefined);
  } finally {
    clearInterval(renewal);
  }
}
