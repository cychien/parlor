import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "../action-client.js";
import { type AccountDevice, type FrameworkAuth, LinkOnComputer } from "../session.js";
import { FrameworkProvider } from "./provider.js";
import { newlyLinked, useDevices } from "./use-devices.js";

const device = (id: string, fields: Partial<AccountDevice> = {}): AccountDevice => ({
  id,
  name: `Device ${id}`,
  platform: "web",
  current: false,
  createdAt: "2026-10-24T00:00:00.000Z",
  vouched: false,
  linking: false,
  ...fields,
});

describe("newlyLinked", () => {
  it("is the devices another device vouched for since the last read", () => {
    const self = device("laptop", { current: true });
    const before = [
      self,
      device("phone", { linking: true }),
      device("tablet", { vouched: true }),
    ];
    const after = [
      self,
      device("phone", { vouched: true, linkedBy: "desktop" }),
      device("tablet", { vouched: true, linkedBy: "desktop" }),
      device("watch", { vouched: true, linkedBy: "desktop" }),
      device("tv", { vouched: true, linkedBy: "laptop" }),
      device("kiosk"),
    ];
    expect(newlyLinked(before, after).map(({ id }) => id)).toEqual(["phone", "watch"]);
  });
});

const client = {
  clientId: "tab",
  basePath: "/_parlor",
  invoke: async () => ({ data: undefined, tags: [] }),
  request: async () => new Response(null, { status: 401 }),
} as unknown as ActionClient<Record<string, never>>;

const SIGNED_IN = {
  status: "signed-in",
  user: { id: "u", name: "A", email: "a@x.test" },
} as const;

function auth(remove: (id: string) => Promise<void>) {
  let listed = [device("laptop", { current: true }), device("phone", { vouched: true })];
  const fake: FrameworkAuth = {
    current: () => SIGNED_IN,
    subscribe: () => () => undefined,
    listDevices: async () => listed,
    removeDevice: vi.fn(async (id: string) => {
      await remove(id);
      listed = listed.filter((entry) => entry.id !== id);
    }),
  };
  return fake;
}

function Devices() {
  const { devices, removal, remove } = useDevices();
  return (
    <div>
      <p data-testid="devices">{devices?.map(({ id }) => id).join(",") ?? "loading"}</p>
      <p data-testid="removal">
        {removal.step === "on-computer"
          ? removal.command
          : removal.step === "error"
            ? removal.message
            : removal.step}
      </p>
      <button type="button" onClick={() => void remove("phone")}>
        remove
      </button>
    </div>
  );
}

function renderWith(fake: FrameworkAuth) {
  render(
    <FrameworkProvider client={client} sync={false} auth={fake}>
      <Devices />
    </FrameworkProvider>,
  );
}

describe("useDevices", () => {
  it("lists the account's devices and reads them again after removing one", async () => {
    renderWith(auth(async () => undefined));
    await waitFor(() =>
      expect(screen.getByTestId("devices").textContent).toBe("laptop,phone"),
    );
    act(() => screen.getByText("remove").click());
    await waitFor(() => expect(screen.getByTestId("devices").textContent).toBe("laptop"));
    expect(screen.getByTestId("removal").textContent).toBe("idle");
  });

  it("gives the computer's command when this device cannot confirm, and says a cancel removed nothing", async () => {
    renderWith(
      auth(async () => {
        throw new LinkOnComputer("This device cannot confirm it is you.");
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("devices").textContent).toBe("laptop,phone"),
    );
    act(() => screen.getByText("remove").click());
    await waitFor(() =>
      expect(screen.getByTestId("removal").textContent).toBe(
        `npx @parlor/agent-host devices ${location.origin} --remove phone`,
      ),
    );

    const cancelled = new Error("cancelled");
    cancelled.name = "NotAllowedError";
    renderWith(
      auth(async () => {
        throw cancelled;
      }),
    );
    const removeButtons = await screen.findAllByText("remove");
    act(() => removeButtons[1]!.click());
    await waitFor(() =>
      expect(screen.getAllByTestId("removal")[1]!.textContent).toBe(
        "Face ID or Touch ID was cancelled, so nothing was removed.",
      ),
    );
  });
});
