import type { AgentConfirmation } from "@parlor/agent-ui/client";
import type { ChatItem } from "@parlor/chat";
import { asId } from "@parlor/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as Chat from "../agent-ui/chat.js";
import { ChatScope } from "./context.js";
import type { ChatRuntime, ChatState } from "./runtime.js";
import { useChat } from "./use-chat.js";

const turnId = asId("turn", "turn_1");
const agentRef = { hostId: asId("host", "host_mac"), agentId: "claude" };

const baseState: ChatState = {
  status: "idle",
  thread: undefined,
  threads: [],
  items: [],
  hosts: [],
  agents: [
    {
      key: "host_mac/claude",
      name: "Claude Code",
      hostName: "Alice's Mac",
      online: true,
      ready: true,
      problem: undefined,
    },
  ],
  agent: {
    key: "host_mac/claude",
    name: "Claude Code",
    hostName: "Alice's Mac",
    online: true,
    ready: true,
    problem: undefined,
  },
  connect: {
    kind: "command",
    command: "npx @parlor/agent-host connect https://app.test",
  },
  draft: "",
  error: undefined,
  setup: undefined,
};

function fakeRuntime(initial: Partial<ChatState> = {}) {
  let state: ChatState = { ...baseState, ...initial };
  const listeners = new Set<() => void>();
  const runtime = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    start: () => () => {},
    setDraft: vi.fn((text: string) => set({ draft: text })),
    send: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    choose: vi.fn(),
    openThread: vi.fn(),
  } satisfies ChatRuntime;
  function set(next: Partial<ChatState>) {
    state = { ...state, ...next };
    act(() => {
      for (const listener of listeners) listener();
    });
  }
  return { runtime, set };
}

function mount(runtime: ChatRuntime, ui: React.ReactNode) {
  return render(<ChatScope value={runtime}>{ui}</ChatScope>);
}

const reply = (
  id: string,
  text: string,
  streaming = false,
  interrupted = false,
): ChatItem<AgentConfirmation> => ({
  kind: "reply",
  id: asId("item", id),
  turnId,
  text,
  streaming,
  interrupted,
});

describe("Chat.Thread", () => {
  it("renders one li per item with the contract's data attributes", () => {
    const { runtime } = fakeRuntime({
      status: "running",
      items: [
        {
          kind: "prompt",
          id: asId("item", "item_p"),
          turnId,
          text: "go",
          agent: agentRef,
          state: "running",
          mine: true,
        },
        reply("turn_1.1", "Hel", true),
        reply("turn_1.2", "Done.", false, true),
      ],
    });
    mount(
      runtime,
      <Chat.Thread>
        {(item) => <span>{"text" in item ? item.text : ""}</span>}
      </Chat.Thread>,
    );

    const rows = screen.getAllByRole("listitem");
    expect(
      rows.map((row) => [
        row.dataset.itemId,
        row.dataset.kind,
        row.dataset.streaming,
        row.dataset.interrupted,
        row.textContent,
      ]),
    ).toEqual([
      ["item_p", "prompt", undefined, undefined, "go"],
      ["turn_1.1", "reply", "true", "false", "Hel"],
      ["turn_1.2", "reply", "false", "true", "Done."],
    ]);
    expect(screen.getByRole("log").dataset.status).toBe("running");
  });

  it("keeps a row mounted when its open reply becomes the persisted twin", () => {
    const { runtime, set } = fakeRuntime({ items: [reply("turn_1.1", "Hel", true)] });
    mount(
      runtime,
      <Chat.Thread>
        {(item) => <span>{"text" in item ? item.text : ""}</span>}
      </Chat.Thread>,
    );
    const row = screen.getByRole("listitem");
    set({ items: [reply("turn_1.1", "Hello", false)] });
    expect(screen.getByRole("listitem")).toBe(row);
    expect(row.dataset.streaming).toBe("false");
  });

  it("shows the empty state beside an empty log", () => {
    const { runtime } = fakeRuntime();
    mount(
      runtime,
      <Chat.Thread empty={<p>Ask your agent.</p>}>{() => null}</Chat.Thread>,
    );
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(screen.getByText("Ask your agent.")).toBeTruthy();
  });
});

describe("Chat.Composer", () => {
  function composer(initial: Partial<ChatState> = {}) {
    const fake = fakeRuntime(initial);
    mount(
      fake.runtime,
      <Chat.Composer>
        <Chat.Input />
        <Chat.Send />
        <Chat.Stop />
      </Chat.Composer>,
    );
    return fake;
  }

  it("types into the draft, and Enter sends it", () => {
    const fake = composer();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "hello" } });
    expect(fake.runtime.setDraft).toHaveBeenCalledWith("hello");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.runtime.send).toHaveBeenCalledOnce();
  });

  it("breaks the line on Shift+Enter and never sends mid-composition", () => {
    const fake = composer({ draft: "hello" });
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(fake.runtime.send).not.toHaveBeenCalled();
  });

  it("sends with the Send button once there is text, and not before", () => {
    const fake = composer();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fake.set({ draft: "hello" });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(fake.runtime.send).toHaveBeenCalledOnce();
  });

  it("cannot send a draft over the 32,000-character limit, by button or Enter", () => {
    const fake = composer({ draft: "x".repeat(32_001) });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(fake.runtime.send).not.toHaveBeenCalled();
    fake.set({ draft: "x".repeat(32_000) });
    expect(send.disabled).toBe(false);
  });

  it("cannot send while the device setup waits for the user", () => {
    const fake = composer({ draft: "hello", setup: { step: "explain" } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fake.set({ setup: undefined });
    expect(send.disabled).toBe(false);
  });

  it("can send to an agent whose computer is offline, to queue the prompt", () => {
    composer({
      draft: "hello",
      agent: { ...baseState.agent!, online: false },
    });
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("cannot send to an agent that is not ready", () => {
    composer({
      draft: "hello",
      agent: { ...baseState.agent!, ready: false },
    });
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables the box while no agent can be chosen", () => {
    composer({ agent: undefined, agents: [] });
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  it("shows Stop only while a turn runs, and stops it", () => {
    const fake = composer();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fake.set({ status: "running" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(fake.runtime.stop).toHaveBeenCalledOnce();
  });

  it("keeps Stop and Send available while the computer decides about this device", () => {
    const fake = composer({ draft: "go" });
    fake.set({ status: "waiting" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("Chat.Ask", () => {
  const ask = (
    overrides: Partial<Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>> = {},
  ) =>
    ({
      kind: "ask",
      id: asId("item", "turn_1.3"),
      turnId,
      question: "Allow Claude to run npm test?",
      choices: [
        { id: "allow", label: "Allow once", effect: "allow_once" },
        { id: "reject", label: "Reject", effect: "reject_once" },
      ],
      form: undefined,
      approval: "presence",
      answer: { state: "open" },
      ...overrides,
    }) as const;

  function renderAsk(item: ReturnType<typeof ask>) {
    const fake = fakeRuntime({ items: [item] });
    mount(
      fake.runtime,
      <Chat.Ask item={item}>
        {item.choices.map((choice) => (
          <Chat.AskChoice key={choice.id} choice={choice}>
            {choice.label}
          </Chat.AskChoice>
        ))}
      </Chat.Ask>,
    );
    return fake;
  }

  it("is a group named by its question, whose choice answers it", () => {
    const fake = renderAsk(ask());
    const group = screen.getByRole("group", { name: "Allow Claude to run npm test?" });
    expect([group.dataset.approval, group.dataset.state]).toEqual(["presence", "open"]);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(fake.runtime.answer).toHaveBeenCalledWith("turn_1.3", "allow");
  });

  it("declines on Escape", () => {
    const fake = renderAsk(ask());
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(fake.runtime.answer).toHaveBeenCalledWith("turn_1.3", "reject");
  });

  it("is answered on the computer when its approval is computer: choices disabled, Escape inert", () => {
    const fake = renderAsk(ask({ approval: "computer" }));
    expect(
      (screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(fake.runtime.answer).not.toHaveBeenCalled();
  });

  it("shows the choice the computer took while the buttons stay disabled", () => {
    renderAsk(
      ask({ approval: "computer", answer: { state: "answered", choice: "allow" } }),
    );
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(
      buttons.map((button) => [button.disabled, button.getAttribute("aria-pressed")]),
    ).toEqual([
      [true, "true"],
      [true, "false"],
    ]);
    expect(screen.getByRole("group").dataset.state).toBe("answered");
  });

  it("disables its choices once answered, marking the one taken", () => {
    renderAsk(ask({ answer: { state: "answered", choice: "allow" } }));
    const allow = screen.getByRole("button", { name: "Allow once" }) as HTMLButtonElement;
    expect([allow.disabled, allow.getAttribute("aria-pressed")]).toEqual([true, "true"]);
  });
});

describe("Chat.AskForm", () => {
  const form = {
    type: "object",
    properties: {
      name: { type: "string", title: "Your name" },
      age: { type: "integer" },
      ratio: { type: "number" },
      subscribe: { type: "boolean" },
    },
    required: ["name"],
  };

  const ask = (
    overrides: Partial<Extract<ChatItem<AgentConfirmation>, { kind: "ask" }>> = {},
  ) =>
    ({
      kind: "ask",
      id: asId("item", "turn_1.4"),
      turnId,
      question: "Tell me about you",
      choices: [
        { id: "accept", label: "Submit", effect: "allow_once" },
        { id: "decline", label: "Decline", effect: "reject_once" },
      ],
      form,
      approval: undefined,
      answer: { state: "open" },
      ...overrides,
    }) as const;

  function renderForm(item: ReturnType<typeof ask>) {
    const fake = fakeRuntime({ items: [item] });
    mount(
      fake.runtime,
      <Chat.Ask item={item}>
        <Chat.AskForm>
          <button type="submit">Submit</button>
        </Chat.AskForm>
      </Chat.Ask>,
    );
    return fake;
  }

  const input = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

  it("has one input per schema property, typed by the property", () => {
    renderForm(ask());
    expect(
      ["name", "age", "ratio", "subscribe"].map((name) => [name, input(name).type]),
    ).toEqual([
      ["name", "text"],
      ["age", "number"],
      ["ratio", "number"],
      ["subscribe", "checkbox"],
    ]);
    expect(screen.getByLabelText("Your name")).toBe(input("name"));
    expect(input("name").required).toBe(true);
    expect(input("age").step).toBe("1");
  });

  it("answers with the allow choice and the values typed per the schema", () => {
    const fake = renderForm(ask());
    fireEvent.change(input("name"), { target: { value: "Ada" } });
    fireEvent.change(input("age"), { target: { value: "36" } });
    fireEvent.change(input("ratio"), { target: { value: "1.5" } });
    fireEvent.click(input("subscribe"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(fake.runtime.answer).toHaveBeenCalledWith("turn_1.4", "accept", {
      name: "Ada",
      age: 36,
      ratio: 1.5,
      subscribe: true,
    });
  });

  it("leaves blank fields out and reports an unchecked box as false", () => {
    const fake = renderForm(ask());
    fireEvent.change(input("name"), { target: { value: "Ada" } });
    fireEvent.submit(screen.getByRole("button", { name: "Submit" }).closest("form")!);
    expect(fake.runtime.answer).toHaveBeenCalledWith("turn_1.4", "accept", {
      name: "Ada",
      subscribe: false,
    });
  });

  it("is disabled once answered and while the ask is answered on the computer", () => {
    renderForm(ask({ answer: { state: "answered", choice: "accept" } }));
    expect(input("name").closest("fieldset")!.disabled).toBe(true);
    cleanup();
    renderForm(ask({ approval: "computer" }));
    expect(input("name").closest("fieldset")!.disabled).toBe(true);
  });

  it("renders nothing for an ask without a form", () => {
    renderForm(ask({ form: undefined }));
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("Chat.Status", () => {
  const mac = { reason: "offline", hostId: "host_mac", hostName: "Alice's Mac" } as const;

  function status(initial: Partial<ChatState>) {
    mount(
      fakeRuntime(initial).runtime,
      <>
        <Chat.Thread>{() => null}</Chat.Thread>
        <Chat.Status className="line" />
      </>,
    );
    return screen.getByRole("status");
  }

  it("T7-01a (a) names the computer a queued prompt waits to come online", () => {
    const line = status({ status: "waiting", wait: mac });
    expect(line.textContent).toBe("Waiting for Alice's Mac to come online");
    expect(line.dataset.status).toBe("waiting");
    expect(line.dataset.wait).toBe("offline");
    expect(line.className).toBe("line");
  });

  it("says it waits for the passkey while the browser asks for one", () => {
    expect(status({ setup: { step: "passkey" } }).textContent).toBe(
      "Waiting for the passkey",
    );
  });

  it("gives the code the computer's dialog shows while it approves this device", () => {
    const line = status({
      status: "waiting",
      wait: { ...mac, reason: "approval", code: "4821" },
    });
    expect(line.textContent).toBe(
      "Waiting for Alice's Mac to approve this device. Check that it shows 4821.",
    );
  });

  it("T7-01a (b) names the computer that must approve this device", () => {
    const line = status({ status: "waiting", wait: { ...mac, reason: "approval" } });
    expect(line.textContent).toBe("Waiting for Alice's Mac to approve this device");
    expect(line.dataset.wait).toBe("approval");
  });

  it("T7-01a (c) says Working... without a streaming row when the deployment cannot stream", () => {
    const line = status({
      status: "running",
      items: [
        {
          kind: "prompt",
          id: asId("item", "item_p"),
          turnId,
          text: "go",
          agent: agentRef,
          state: "running",
          mine: true,
        },
        reply("turn_1.1", "Done.", false),
      ],
    });
    expect(line.textContent).toBe("Working...");
    expect(document.querySelector('[data-streaming="true"]')).toBeNull();
    expect(screen.getByRole("log").dataset.status).toBe("running");
  });

  it.each([
    ["sending", undefined, "Sending..."],
    ["running", undefined, "Working..."],
    ["waiting", mac, "Waiting for Alice's Mac to come online"],
    [
      "waiting",
      { ...mac, reason: "approval" },
      "Waiting for Alice's Mac to approve this device",
    ],
  ] as const)(
    "T7-01a: %s %j never shows without text or as a bare spinner",
    (state, wait, text) => {
      const line = status({ status: state, wait });
      expect(line.textContent).toBe(text);
      expect(
        document.querySelector('[aria-busy="true"], [role="progressbar"]'),
      ).toBeNull();
    },
  );

  it.each(["loading", "idle", "unavailable"] as const)(
    "keeps an empty status line while %s",
    (state) => {
      expect(status({ status: state }).textContent).toBe("");
    },
  );

  it("lets the app replace the text", () => {
    mount(
      fakeRuntime({ status: "running" }).runtime,
      <Chat.Status>Thinking</Chat.Status>,
    );
    expect(screen.getByRole("status").textContent).toBe("Thinking");
  });
});

describe("useChat", () => {
  function Probe() {
    const chat = useChat();
    return (
      <button type="button" onClick={() => chat.choose("host_mac/claude")}>
        {chat.status}:{chat.agents.length}
      </button>
    );
  }

  it("gives the app the state and the commands", () => {
    const fake = fakeRuntime();
    mount(fake.runtime, <Probe />);
    fireEvent.click(screen.getByRole("button", { name: "idle:1" }));
    expect(fake.runtime.choose).toHaveBeenCalledWith("host_mac/claude");
  });

  it("refuses to render outside Chat.Root", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useChat must be rendered inside Chat.Root.");
  });
});
