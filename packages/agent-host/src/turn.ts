import { mkdir } from "node:fs/promises";

import {
  answerStatement,
  type PinnedDevice,
  signedPrompt,
  statementBytes,
  verifyStatement,
  type VerifyOutcome,
} from "@parlor/auth";
import { canonicalBytes, encodeBase64url } from "@parlor/capabilities/encoding";
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
import { appServerOf } from "./naming.js";
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
}

export const PROMPT_MAX_AGE_MS = 10 * 60_000;

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const SIGNAL_POLL_MS = 500;
const MAX_APPEND_ITEMS = 64;
const APPEND_ATTEMPTS = 5;
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

  const send = async (items: HostItemDraft[]) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const renewed = await calls.call("hostAppend", { turnId, items });
        lastWrite = deps.now();
        proxy?.renew(renewed.token);
        return;
      } catch (error) {
        if (error instanceof ActionError || attempt === APPEND_ATTEMPTS) throw error;
        await sleep(250 * attempt);
      }
    }
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
        lost = true;
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
    if (lost) return outcome;
    try {
      await calls.call("hostFinish", { turnId, outcome });
    } catch (error) {
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

  const approve = async (device: NonNullable<ClaimedTurn["device"]>) => {
    const approval = joinApproval(`${origin}\n${device.id}`, async (signal) => {
      const timeout = AbortSignal.timeout(APPROVAL_TIMEOUT_MS);
      const allowed = await deps.prompter.approveDevice({
        appName: grant.appName,
        account: grant.account,
        device: { name: device.name, platform: device.platform },
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
    const watching = new AbortController();
    try {
      return await Promise.race([
        approval.settled.then((allowed): "allowed" | "denied" =>
          allowed ? "allowed" : "denied",
        ),
        cancelRequested(watching.signal),
      ]);
    } finally {
      watching.abort();
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
    if (!signed)
      return refuse("signature_invalid", "turn_failed", "This prompt is not signed.");
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
    await event("device_pending");
    const decision = await approve(keys);
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
          resume: pool.resumable(grant, threadId, agentId),
          pinAskMode: true,
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

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      void session.cancel();
      settleAll();
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
            settle(id, answer ?? { kind: "cancelled" });
          });
      }
      return answered;
    };

    const rejectionOf = async (
      waiting: Pending,
      item: LoggedItem<"answer">,
    ): Promise<string | undefined> => {
      if (waiting.approval === "computer") {
        return "This question is answered on the computer.";
      }
      if (deps.policy.deviceApproval !== "local" && waiting.approval !== "presence") {
        return undefined;
      }
      const { signed, askId, choice, values } = item.body;
      const pinned = signed ? await deps.trust.get(origin, signed.deviceId) : undefined;
      if (!signed || !pinned) {
        logEvent("statement_verified", {
          kind: "answer",
          deviceId: signed?.deviceId,
          outcome: "invalid",
        });
        return "This device cannot answer here.";
      }
      const statement = await answerStatement(
        origin,
        { threadId: item.threadId, askId, choice, ...(values ? { values } : {}) },
        signed.at,
      );
      const outcome = await verifyStatement(
        { statement, deviceId: signed.deviceId, signature: signed.signature },
        pinned,
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
      if (outcome === "valid") return undefined;
      return outcome === "presence_required"
        ? "This answer needs a presence check."
        : "This answer's signature did not check out.";
    };

    let afterSeq = claimed.prompt.seq;
    let polling = true;
    const signals = async () => {
      for (;;) {
        await sleep(SIGNAL_POLL_MS);
        if (!polling) return;
        let batches: TurnSignals[];
        try {
          batches = await calls.call("hostSignals", { turns: [{ turnId, afterSeq }] });
        } catch {
          continue;
        }
        for (const item of batches.flatMap((batch) => batch.items)) {
          afterSeq = Math.max(afterSeq, item.seq);
          if (item.kind === "cancel") {
            cancel();
            continue;
          }
          const waiting = pending.get(item.body.askId);
          if (!waiting) continue;
          const rejection = await rejectionOf(waiting, item);
          const answer =
            rejection === undefined ? answerOf(waiting, item.body) : undefined;
          if (!answer) {
            void event(
              "answer_rejected",
              rejection ?? "That is not one of the choices.",
              item.id,
            );
            continue;
          }
          settle(item.body.askId, answer);
        }
      }
    };

    let stop: StopReason | undefined;
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
    void signals();
    try {
      stop = await Promise.race([prompted, exited]);
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
      polling = false;
      settleAll();
    }

    const interrupted = failure !== undefined || cancelled || stop === "cancelled";
    const final = finishFold(fold, interrupted);
    fold = final.fold;
    void write(final.closed);

    if (failure) {
      await pool.drop(origin, agentId);
      const detail =
        failure instanceof AgentExited ? exitDetail(failure.exit) : failure.message;
      return fail("agent_exited", "agent_exited", detail);
    }
    if (lost) return { state: "failed", reason: "host_lost" };
    return finish(
      interrupted ? { state: "cancelled" } : { state: "done", stopReason: stop! },
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
