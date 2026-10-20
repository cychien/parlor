import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  type AcpStdio,
  type AgentAsk,
  type AgentAskAnswer,
  type AgentModes,
  type AgentUpdate,
  type PromptBlock,
  serveAcpAgent,
  type StdioMcpServer,
  type StopReason,
  type ToolKind,
} from "../acp.js";
import type { AgentProfile } from "../agents.js";

/**
 * A scripted agent on the real ACP transport (through `serveAcpAgent`), so the adapter,
 * fold, permission, cancel and MCP proxy paths are tested as Claude Code and Codex drive
 * them. A prompt's text names the step list to play: the whole text, or its last line when
 * the host put its context block first. Every reply chunk goes out prefixed with
 * `[t:<epoch ms>]`, the time it was written.
 */
export interface FakeAgentScript {
  readonly advertise?:
    | {
        readonly resume?: boolean | undefined;
        readonly close?: boolean | undefined;
        readonly mcpHttp?: boolean | undefined;
        readonly modes?: AgentModes | undefined;
      }
    | undefined;
  readonly steps: Readonly<Record<string, readonly FakeStep[]>>;
  /** For a prompt no step names: reply with it. */
  readonly fallback?: "echo" | undefined;
}

export type FakeStep =
  | {
      readonly kind: "reply";
      readonly chunks: readonly string[];
      readonly perSecond?: number;
    }
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly title: string;
      readonly toolKind: ToolKind;
      readonly mcp?: { readonly server: string; readonly tool: string } | undefined;
      readonly askPermission: boolean;
      /** The permission request's own title, when it differs from the call's. */
      readonly askTitle?: string | undefined;
    }
  /** Calls an app tool through the MCP server the host passed in `session/new`. */
  | { readonly kind: "call_app"; readonly tool: string; readonly input: unknown }
  | { readonly kind: "plan"; readonly entries: readonly string[] }
  | { readonly kind: "wait_for_cancel" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "stop"; readonly reason: Exclude<StopReason, "cancelled"> };

interface Peer {
  update(update: AgentUpdate): Promise<void>;
  ask(ask: AgentAsk): Promise<AgentAskAnswer>;
  readonly cancelled: AbortSignal;
}

const ALLOW = "allow";
const REJECT = "reject";

const PERMISSION_OPTIONS = [
  { id: ALLOW, label: "Allow", effect: "allow_once" },
  { id: REJECT, label: "Reject", effect: "reject_once" },
] as const;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function stepsFor(script: FakeAgentScript, text: string): readonly FakeStep[] {
  const trimmed = text.trim();
  const lastLine = trimmed.split("\n").at(-1)?.trim() ?? "";
  const named = script.steps[trimmed] ?? script.steps[lastLine];
  if (named) return named;
  return [
    {
      kind: "reply",
      chunks: [
        script.fallback === "echo" ? text : `No step list is named "${lastLine}".`,
      ],
    },
  ];
}

class McpStdioClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, (message: Record<string, unknown>) => void>();
  readonly #ready: Promise<void>;
  #nextId = 1;

  constructor(server: StdioMcpServer) {
    this.#child = spawn(server.command, [...server.args], {
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.id === "number") this.#pending.get(message.id)?.(message);
    });
    this.#ready = this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-agent", version: "0.0.0" },
    }).then(() => this.#send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  }

  #send(message: unknown) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, (message) => {
        this.#pending.delete(id);
        resolve(message);
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async callTool(name: string, input: unknown): Promise<Record<string, unknown>> {
    await this.#ready;
    return this.request("tools/call", { name, arguments: input });
  }

  close() {
    this.#child.kill();
  }
}

function resultText(message: Record<string, unknown>): { text: string; failed: boolean } {
  const error = message.error as { message?: string } | undefined;
  if (error) return { text: error.message ?? "error", failed: true };
  const result = message.result as
    | { content?: { type: string; text?: string }[]; isError?: boolean }
    | undefined;
  const text = (result?.content ?? [])
    .flatMap((content) => (content.type === "text" && content.text ? [content.text] : []))
    .join("\n");
  return { text, failed: result?.isError === true };
}

/** The fixture's entry point: serves `script` on `io` (the process's stdio). */
export function serveFakeAgent(script: FakeAgentScript, io: AcpStdio): Promise<void> {
  const sessions = new Map<string, readonly StdioMcpServer[]>();
  const clients = new Map<string, McpStdioClient>();
  let tools = 0;

  const permit = async (
    peer: Peer,
    toolCallId: string,
    title: string,
    step: {
      readonly toolKind: ToolKind;
      readonly mcp?: { readonly server: string; readonly tool: string } | undefined;
    },
  ) => {
    const answer = await peer.ask({
      kind: "permission",
      toolCallId,
      title,
      toolKind: step.toolKind,
      mcp: step.mcp,
      options: PERMISSION_OPTIONS,
    });
    return answer.kind === "selected" && answer.optionId === ALLOW;
  };

  const play = async (
    sessionId: string,
    step: FakeStep,
    peer: Peer,
  ): Promise<StopReason | undefined> => {
    switch (step.kind) {
      case "reply":
        for (const chunk of step.chunks) {
          if (peer.cancelled.aborted) return "cancelled";
          await peer.update({ kind: "text", text: `[t:${Date.now()}]${chunk}` });
          if (step.perSecond) await sleep(1000 / step.perSecond, peer.cancelled);
        }
        return undefined;
      case "thought":
        await peer.update({ kind: "thought", text: step.text });
        return undefined;
      case "tool": {
        const toolCallId = `tool-${++tools}`;
        await peer.update({
          kind: "tool_start",
          toolCallId,
          title: step.title,
          toolKind: step.toolKind,
          mcp: step.mcp,
        });
        const allowed =
          !step.askPermission ||
          (await permit(peer, toolCallId, step.askTitle ?? step.title, step));
        await peer.update({
          kind: "tool_update",
          toolCallId,
          status: allowed ? "completed" : "failed",
          ...(allowed ? {} : { detail: "denied" }),
        });
        return undefined;
      }
      case "call_app": {
        const server = sessions.get(sessionId)?.[0];
        if (!server) throw new Error("The host gave this session no MCP server.");
        const toolCallId = `tool-${++tools}`;
        const mcp = { server: server.name, tool: step.tool };
        await peer.update({
          kind: "tool_start",
          toolCallId,
          title: step.tool,
          toolKind: "other",
          mcp,
        });
        if (!(await permit(peer, toolCallId, step.tool, { toolKind: "other", mcp }))) {
          await peer.update({
            kind: "tool_update",
            toolCallId,
            status: "failed",
            detail: "denied",
          });
          return undefined;
        }
        let client = clients.get(sessionId);
        if (!client) {
          client = new McpStdioClient(server);
          clients.set(sessionId, client);
        }
        const { text, failed } = resultText(await client.callTool(step.tool, step.input));
        await peer.update({
          kind: "tool_update",
          toolCallId,
          status: failed ? "failed" : "completed",
          detail: text,
        });
        return undefined;
      }
      case "plan":
        await peer.update({
          kind: "plan",
          entries: step.entries.map((content) => ({ content, status: "pending" })),
        });
        return undefined;
      case "wait_for_cancel":
        await new Promise<void>((resolve) => {
          if (peer.cancelled.aborted) return resolve();
          peer.cancelled.addEventListener("abort", () => resolve(), { once: true });
        });
        return "cancelled";
      case "exit":
        return process.exit(step.code);
      case "stop":
        return step.reason;
    }
  };

  const served = serveAcpAgent(
    {
      capabilities: {
        resume: script.advertise?.resume === true,
        close: script.advertise?.close === true,
        mcpHttp: script.advertise?.mcpHttp === true,
      },
      newSession: async (input) => {
        const id = `fake-session-${sessions.size + 1}`;
        sessions.set(id, input.mcpServers);
        return { id, modes: script.advertise?.modes };
      },
      prompt: async (sessionId, blocks: readonly PromptBlock[], peer) => {
        const text = blocks.map((block) => block.text).join("\n");
        for (const step of stepsFor(script, text)) {
          if (peer.cancelled.aborted) return "cancelled";
          const stop = await play(sessionId, step, peer);
          if (stop) return stop;
        }
        return peer.cancelled.aborted ? "cancelled" : "end_turn";
      },
    },
    io,
  );
  return served.finally(() => {
    for (const client of clients.values()) client.close();
  });
}

/** A profile that launches the fixture at `entry` with `scriptFile`. */
export function fakeAgentProfile(entry: string, scriptFile: string): AgentProfile {
  return {
    id: "fake",
    name: "Fake agent",
    launch: { kind: "native", command: "node", args: [entry, scriptFile] },
    binary: "node",
  };
}
