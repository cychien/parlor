import { mkdir } from "node:fs/promises";

import type {
  ChatEvent,
  ChatItemBody,
  ClaimedTurn,
  HostItemDraft,
  TurnFailure,
  TurnOutcome,
  TurnSignals,
} from "@parlor/chat";
import { ActionError, asId, type ItemId } from "@parlor/core";

import type {
  AgentAsk,
  AgentAskAnswer,
  AgentConnection,
  AgentExit,
  AgentLauncher,
  AgentSession,
  StopReason,
} from "./acp.js";
import type { AgentProfile } from "./agents.js";
import { finishFold, foldUpdate, startFold, type TurnFold } from "./fold.js";
import type { AppLink } from "./link.js";
import type { McpProxy, ProxySession } from "./mcp-proxy.js";
import { appServerOf } from "./naming.js";
import { approvalFor, isAppTool, type RemotePolicy } from "./policy.js";
import type { LiveSession, SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";
import { agentEnvironment } from "./shell-path.js";

export interface TurnDeps {
  readonly link: AppLink;
  readonly profiles: readonly AgentProfile[];
  readonly launcher: AgentLauncher;
  readonly pool: SessionPool;
  readonly proxy: McpProxy;
  readonly policy: RemotePolicy;
  readonly prompter: LocalPrompter;
  readonly now: () => number;
}

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
  readonly resolve: (answer: AgentAskAnswer) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const event = (name: ChatEvent, detail?: string) =>
    write([
      {
        id: nextId(),
        kind: "event",
        body: { event: name, ...(detail ? { detail: detail.slice(0, 500) } : {}) },
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

  const fail = async (reason: TurnFailure, name: ChatEvent, detail: string) => {
    await event(name, detail);
    return finish({ state: "failed", reason });
  };

  const profile = deps.profiles.find((candidate) => candidate.id === agentId);
  if (!profile) {
    return fail(
      "agent_unavailable",
      "turn_failed",
      `This computer has no agent "${agentId}".`,
    );
  }

  const origin = grant.appOrigin;
  let live: LiveSession | undefined = pool.session(origin, threadId, agentId);
  let connection: AgentConnection | undefined = pool.process(origin, agentId);
  const fresh = live === undefined;
  if (live) {
    proxy = live.proxy;
    proxy.begin(claimed.token);
  } else {
    const switched = deps.profiles.some(
      (other) =>
        other.id !== agentId && pool.session(origin, threadId, other.id) !== undefined,
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
        resume: pool.resumable(origin, threadId, agentId),
        pinAskMode: true,
      });
      live = { session, proxy };
      pool.remember(origin, threadId, agentId, live);
    } catch (error) {
      proxy?.dispose();
      proxy = undefined;
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
    device: claimed.device?.name ?? "the app",
    agent: profile.name,
    preview: text.slice(0, 80),
  });

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void session.cancel();
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.resolve({ kind: "cancelled" });
    }
  };

  const ask = async (question: AgentAsk): Promise<AgentAskAnswer> => {
    if (cancelled) return { kind: "cancelled" };
    if (question.kind === "permission" && isAppTool(question, appServer)) {
      const allow = question.options.find((option) => option.effect === "allow_once");
      if (allow) return { kind: "selected", optionId: allow.id };
    }
    const approval = approvalFor(deps.policy, question);
    const id = nextId();
    const answered = new Promise<AgentAskAnswer>((resolve) =>
      pending.set(id, { ask: question, approval, resolve }),
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
        })
        .then((choice) => {
          const waiting = pending.get(id);
          if (!waiting) return;
          pending.delete(id);
          waiting.resolve(
            choice === undefined
              ? { kind: "cancelled" }
              : (answerOf(waiting, { askId: id, choice }) ?? { kind: "cancelled" }),
          );
        });
    }
    return answered;
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
        const answer = waiting.approval ? undefined : answerOf(waiting, item.body);
        if (!answer) {
          void event("answer_rejected", "This answer cannot be taken from the chat.");
          continue;
        }
        pending.delete(item.body.askId);
        waiting.resolve(answer);
      }
    }
  };

  const renewEveryMs = Math.max(1_000, (claimed.leaseUntil - deps.now()) / 2);
  const renewal = setInterval(() => {
    if (deps.now() - lastWrite >= renewEveryMs) void write([]);
  }, renewEveryMs / 4);

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
    clearInterval(renewal);
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.resolve({ kind: "cancelled" });
    }
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
}
