import { H3 } from "h3";
import { describe, expect, it } from "vitest";

import { createAgentUi } from "./agent-ui.js";
import { registerAgentUiRoutes } from "./routes.js";

function app() {
  const agentUi = createAgentUi({ audience: () => "default" });
  const cards: string[] = [];
  const server = new H3();
  registerAgentUiRoutes(server, {
    basePath: "/_parlor",
    agentUi,
    audience: () => "default",
    clientId: (request) => request.headers.get("x-parlor-client") ?? undefined,
  });
  agentUi.channel.connect({
    clientId: "tab-1",
    scope: "default",
    send: (data) => cards.push(data),
  });
  const post = (body: unknown) =>
    server.fetch(
      new Request("http://app.test/_parlor/ui", {
        method: "POST",
        headers: { "x-parlor-client": "tab-1", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const presence = { type: "presence", focused: true, visible: true, platform: "web" };
  return { agentUi, post, presence, cards };
}

describe("presence watching over HTTP", () => {
  it("answers 204 for nine watched threads and keeps the first eight", async () => {
    const { agentUi, post, presence, cards } = app();
    const threads = Array.from({ length: 9 }, (_, n) => `thr_${n + 1}`);
    const response = await post({ ...presence, canConfirm: true, watching: threads });
    expect(response.status).toBe(204);

    const ask = (threadId: string) =>
      agentUi.confirm({
        scope: "default",
        thread: { threadId, turnId: "turn_1" },
        action: "deleteTask",
        description: "Delete a task by id.",
        input: { id: "t1" },
        origin: { via: "agent" },
        signal: AbortSignal.timeout(50),
      });
    void ask("thr_8");
    expect(cards.map((card) => JSON.parse(card).items[0].threadId)).toEqual(["thr_8"]);
    await expect(ask("thr_9")).resolves.toBe("unavailable");
  });

  it("answers 204 and drops only the watching list when it is malformed", async () => {
    const { post, presence } = app();
    expect((await post({ ...presence, watching: "thr_1" })).status).toBe(204);
    expect((await post({ ...presence, watching: ["thr_1", "", 3] })).status).toBe(204);
  });
});
