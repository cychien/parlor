import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import { type GrantKey, type GrantKeys, verifyHostAssertion } from "./hosts.js";
import { Computer } from "./testing/computer.js";

const URL_OF_HELLO = "http://app.test/_parlor/chat/actions/hostHello";
const NOW = 1_800_000_000_000;

async function connected() {
  const computer = new Computer();
  computer.grant = {
    grant: { id: asId("grant", "host:g1"), hostId: asId("host", "h1") },
    account: { userId: asId("user", "u1"), name: "Alice" },
  };
  const grant: GrantKey = {
    grantId: asId("grant", "host:g1"),
    userId: asId("user", "u1"),
    hostId: asId("host", "h1"),
    publicKey: await computer.publicKey(),
    kid: await computer.thumbprint(),
  };
  const keys: GrantKeys = { get: () => Promise.resolve(grant) };
  const verifyAt = async (assertion: string, at: number) =>
    verifyHostAssertion(
      assertion as Parameters<typeof verifyHostAssertion>[0],
      { method: "POST", url: URL_OF_HELLO },
      keys,
      at,
    ).then(
      () => "admitted",
      (error: { reason: string; message: string }) => `${error.reason}: ${error.message}`,
    );
  return { computer, verifyAt };
}

describe("a host assertion's one-shot guarantee", () => {
  it("lasts as long as an assertion issued 5 s ahead of the server clock can still be accepted", async () => {
    const { computer, verifyAt } = await connected();
    const assertion = await computer.assertion({
      url: URL_OF_HELLO,
      iat: NOW / 1000 + 5,
    });
    expect(await verifyAt(assertion, NOW)).toBe("admitted");
    expect(await verifyAt(assertion, NOW + 61_000)).toBe(
      "invalid: The host assertion was already used.",
    );
    expect(await verifyAt(assertion, NOW + 64_999)).toBe(
      "invalid: The host assertion was already used.",
    );
    expect(await verifyAt(assertion, NOW + 65_000)).toBe(
      "expired: The host assertion expired.",
    );
  });

  it("still refuses a replay of an assertion issued on time inside its minute", async () => {
    const { computer, verifyAt } = await connected();
    const assertion = await computer.assertion({ url: URL_OF_HELLO, iat: NOW / 1000 });
    expect(await verifyAt(assertion, NOW)).toBe("admitted");
    expect(await verifyAt(assertion, NOW + 59_999)).toBe(
      "invalid: The host assertion was already used.",
    );
  });
});
