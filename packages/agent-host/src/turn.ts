import type { ClaimedTurn, TurnOutcome } from "@parlor/chat";

import type { AgentLauncher } from "./acp.js";
import type { AgentProfile } from "./agents.js";
import type { AppLink } from "./link.js";
import type { McpProxy } from "./mcp-proxy.js";
import type { RemotePolicy } from "./policy.js";
import type { SessionPool } from "./pool.js";
import type { LocalPrompter } from "./prompter.js";

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

/**
 * Runs one claimed turn to its outcome and reports it with `hostFinish`: where the
 * claimed prompt, the agent's updates, the user's answers and stop, and the local policy meet.
 */
export async function runTurn(
  claimed: ClaimedTurn,
  deps: TurnDeps,
): Promise<TurnOutcome> {
  // TODO, in order:
  //   1. Session: pool.session(thread, agent), or launch and openSession({ cwd:
  //      grant.workspace, mcpServers: [proxy.open(appServer, origin).server], resume,
  //      pinAskMode: true }); a fresh session gets claimed.context before the prompt.
  //   2. proxySession.begin(claimed.token); prompter.turnStarted(...).
  //   3. session.prompt(blocks, { update -> foldUpdate -> link.api.stream and batched
  //      hostAppend (renew the token from its reply); ask -> isAppTool ? allow_once : an
  //      `ask` item with approvalFor(policy, ask); "computer" -> prompter.answerHere is
  //      the only source; "presence" -> await its answer signal and verifyStatement with
  //      requirePresence, a bad one -> `answer_rejected` and keep waiting }).
  //   4. A cancel signal -> session.cancel(); pending asks answer "cancelled".
  //   5. finishFold -> hostAppend; proxySession.end(); hostFinish(outcome).
  //   The agent exiting at any point -> `agent_exited`, pool.drop, failed agent_exited.
  void claimed;
  void deps;
  throw new Error("not implemented");
}
