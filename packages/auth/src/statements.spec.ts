import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
} from "node:crypto";

import { encodeBase64url } from "@parlor/capabilities/encoding";
import type { LoggedItem, PromptToSign } from "@parlor/chat";
import { asId } from "@parlor/core";
import { describe, expect, it } from "vitest";

import {
  answerStatement,
  type AnswerStatement,
  checkPairingProof,
  deviceCommitment,
  linkCode,
  normalizeLinkCode,
  pairingProof,
  type PinnedDevice,
  promptStatement,
  type PromptStatement,
  type Signed,
  signedPrompt,
  statementBytes,
  verifyStatement,
} from "./statements.js";
import { TestDeviceKey } from "./testing/device.js";

const APP = "https://hello.example";
const NOW = 1_000_000_000_000;
const MINUTE = 60_000;
const deviceId = asId("device", "device-1");
const prompt: PromptToSign = {
  threadId: asId("thread", "t1"),
  turnId: asId("turn", "u1"),
  agent: { hostId: asId("host", "mac"), agentId: "claude" },
  text: "add a task: 买牛奶",
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function enrolled(withPresence = true) {
  const key = new TestDeviceKey(withPresence);
  const keys = await key.publicKeys({
    rpId: "hello.example",
    userId: "u",
    userName: "u",
    challenge: new Uint8Array([1]),
  });
  const pinned: PinnedDevice = {
    deviceId,
    signingKey: keys.signing.publicKey,
    presenceKey:
      keys.presence?.format === "es256-raw"
        ? {
            format: "es256-raw",
            keyId: keys.presence.keyId,
            publicKey: keys.presence.publicKey,
          }
        : undefined,
  };
  return { key, pinned };
}

async function signedPromptOf(key: TestDeviceKey, statement: PromptStatement) {
  return {
    statement,
    deviceId,
    signature: await key.sign(statementBytes(statement), { presence: false }),
  } satisfies Signed<PromptStatement>;
}

const options = { requirePresence: false, now: NOW, maxAgeMs: 10 * MINUTE };

describe("device link codes", () => {
  const signing = { kty: "EC", crv: "P-256", x: "x1", y: "y1" };
  const presence = { kty: "EC", crv: "P-256", x: "x2", y: "y2" };

  it("hash the app, the device and both keys, and read as 10 Crockford characters", async () => {
    const commitment = await deviceCommitment(
      "https://hello.example/",
      "d1",
      signing,
      presence,
    );
    expect(commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(linkCode(commitment)).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(await deviceCommitment("https://hello.example", "d1", signing, presence)).toBe(
      commitment,
    );
    for (const changed of [
      await deviceCommitment("https://other.example", "d1", signing, presence),
      await deviceCommitment("https://hello.example", "d2", signing, presence),
      await deviceCommitment(
        "https://hello.example",
        "d1",
        { ...signing, x: "x3" },
        presence,
      ),
      await deviceCommitment("https://hello.example", "d1", signing, undefined),
    ]) {
      expect(changed).not.toBe(commitment);
    }
  });

  it("read typed codes the way people type them", () => {
    expect(normalizeLinkCode(" k7m4-pxoq-ilr ")).toBe("K7M4PX0Q11R");
  });
});

describe("pairingProof", () => {
  const secret = encodeBase64url(new Uint8Array(32).map((_, at) => at));
  const key = { kty: "EC", crv: "P-256", x: "x1", y: "y1" };

  it("is checked by the same secret for the same device and signing key only", async () => {
    const proof = await pairingProof(secret, "device-1", { ...key, d: "private" });
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await checkPairingProof(secret, proof, "device-1", key)).toBe(true);
    expect(await checkPairingProof(secret, proof, "device-2", key)).toBe(false);
    expect(await checkPairingProof(secret, proof, "device-1", { ...key, x: "x2" })).toBe(
      false,
    );
    const other = encodeBase64url(new Uint8Array(32).fill(7));
    expect(await checkPairingProof(other, proof, "device-1", key)).toBe(false);
    expect(await checkPairingProof(secret, "not base64url!", "device-1", key)).toBe(
      false,
    );
  });
});

describe("T5-05 statementBytes", () => {
  it("is sorted-key JSON whatever order the fields were written in", async () => {
    const statement = await promptStatement(APP, prompt, NOW);
    const shuffled = Object.fromEntries(Object.entries(statement).reverse());
    expect(text(statementBytes(statement))).toBe(
      `{"agent":"mac/claude","app":"${APP}","at":${NOW},"digest":"${statement.digest}","kind":"prompt","threadId":"t1","turnId":"u1","v":1}`,
    );
    expect(statementBytes(shuffled as unknown as PromptStatement)).toEqual(
      statementBytes(statement),
    );
  });

  it("is UTF-8 that is never escaped or re-encoded", async () => {
    const statement = await promptStatement(
      "https://例え.example",
      { ...prompt, agent: { ...prompt.agent, agentId: "クロード😀" } },
      NOW,
    );
    const bytes = statementBytes(statement);
    expect(text(bytes)).toContain('"agent":"mac/クロード😀"');
    expect(text(bytes)).not.toContain("\\u");
    expect(bytes).toEqual(new TextEncoder().encode(text(bytes)));
  });

  it("digests the prompt text's UTF-8 bytes, so the stored text decides the signature", async () => {
    const statement = await promptStatement(APP, prompt, NOW);
    expect(statement.digest).toBe(
      createHash("sha256").update(prompt.text, "utf8").digest("base64url"),
    );
    expect(
      (await promptStatement(APP, { ...prompt, text: `${prompt.text} ` }, NOW)).digest,
    ).not.toBe(statement.digest);
  });

  it("covers a form's values whatever order jsonb hands them back in", async () => {
    const answer = {
      threadId: prompt.threadId,
      askId: asId("item", "u1.1"),
      choice: "accept",
    };
    const written = await answerStatement(
      APP,
      { ...answer, values: { zeta: 1, a: 2 } },
      NOW,
    );
    const reordered = await answerStatement(
      APP,
      { ...answer, values: { a: 2, zeta: 1 } },
      NOW,
    );
    expect(statementBytes(written)).toEqual(statementBytes(reordered));
    expect(written.choice).toBe(
      createHash("sha256")
        .update('{"choice":"accept","values":{"a":2,"zeta":1}}')
        .digest("base64url"),
    );
    const changed = await answerStatement(
      APP,
      { ...answer, values: { a: 3, zeta: 1 } },
      NOW,
    );
    expect(changed.choice).not.toBe(written.choice);
    expect((await answerStatement(APP, { ...answer, choice: "yes" }, NOW)).choice).toBe(
      "yes",
    );
  });
});

describe("T5-05 verifyStatement", () => {
  it("accepts the statement the device signed: valid", async () => {
    const { key, pinned } = await enrolled();
    const signed = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    expect(await verifyStatement(signed, pinned, options)).toBe("valid");
  });

  it("refuses a prompt statement for another app origin: invalid", async () => {
    const { key, pinned } = await enrolled();
    const signed = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    const elsewhere = {
      ...signed,
      statement: { ...signed.statement, app: "https://evil.example" },
    };
    expect(await verifyStatement(elsewhere, pinned, options)).toBe("invalid");
  });

  it("refuses a prompt statement for another agent: invalid", async () => {
    const { key, pinned } = await enrolled();
    const signed = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    const other = { ...signed, statement: { ...signed.statement, agent: "mac/codex" } };
    expect(await verifyStatement(other, pinned, options)).toBe("invalid");
  });

  it("refuses a prompt statement for another turn: invalid", async () => {
    const { key, pinned } = await enrolled();
    const signed = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    const other = { ...signed, statement: { ...signed.statement, turnId: "u2" } };
    expect(await verifyStatement(other, pinned, options)).toBe("invalid");
  });

  it("calls a prompt older than 10 minutes stale, before it looks at the signature", async () => {
    const { key, pinned } = await enrolled();
    const old = await signedPromptOf(
      key,
      await promptStatement(APP, prompt, NOW - 11 * MINUTE),
    );
    expect(await verifyStatement(old, pinned, options)).toBe("stale");
    const forged = { ...old, signature: { ...old.signature, signature: "AAAA" } };
    expect(await verifyStatement(forged, pinned, options)).toBe("stale");
    const fresh = await signedPromptOf(
      key,
      await promptStatement(APP, prompt, NOW - 9 * MINUTE),
    );
    expect(await verifyStatement(fresh, pinned, options)).toBe("valid");
  });

  it("refuses a statement dated far in the future: invalid", async () => {
    const { key, pinned } = await enrolled();
    const future = await signedPromptOf(
      key,
      await promptStatement(APP, prompt, NOW + 11 * MINUTE),
    );
    expect(await verifyStatement(future, pinned, options)).toBe("invalid");
  });

  it("wants presence on an answer that was signed without it: presence_required", async () => {
    const { key, pinned } = await enrolled();
    const statement = await answerStatement(
      APP,
      { threadId: prompt.threadId, askId: asId("item", "u1.1"), choice: "yes" },
      NOW,
    );
    const plain: Signed<AnswerStatement> = {
      statement,
      deviceId,
      signature: await key.sign(statementBytes(statement), { presence: false }),
    };
    const wanted = { ...options, requirePresence: true };
    expect(await verifyStatement(plain, pinned, wanted)).toBe("presence_required");
    expect(await verifyStatement(plain, pinned, options)).toBe("valid");
    const withPresence: Signed<AnswerStatement> = {
      statement,
      deviceId,
      signature: await key.sign(statementBytes(statement), { presence: true }),
    };
    expect(await verifyStatement(withPresence, pinned, wanted)).toBe("valid");
  });

  it("verifies a presence signature only against the presence key, and a plain one only against the signing key", async () => {
    const { key, pinned } = await enrolled();
    const statement = await promptStatement(APP, prompt, NOW);
    const bytes = statementBytes(statement);
    const asPresence = {
      statement,
      deviceId,
      signature: {
        ...(await key.sign(bytes, { presence: false })),
        presence: "user" as const,
      },
    };
    expect(await verifyStatement(asPresence, pinned, options)).toBe("invalid");
    expect(
      await verifyStatement(asPresence, { ...pinned, presenceKey: undefined }, options),
    ).toBe("invalid");
  });

  it("refuses a statement signed by another device or presented for another device id", async () => {
    const { pinned } = await enrolled();
    const stranger = new TestDeviceKey();
    const signed = await signedPromptOf(
      stranger,
      await promptStatement(APP, prompt, NOW),
    );
    expect(await verifyStatement(signed, pinned, options)).toBe("invalid");
    const { key } = await enrolled();
    const mine = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    expect(
      await verifyStatement(
        { ...mine, deviceId: asId("device", "device-2") },
        pinned,
        options,
      ),
    ).toBe("invalid");
  });

  it("answers invalid, not an error, for a signature that is not even base64url", async () => {
    const { key, pinned } = await enrolled();
    const signed = await signedPromptOf(key, await promptStatement(APP, prompt, NOW));
    expect(
      await verifyStatement(
        { ...signed, signature: { ...signed.signature, signature: "***" } },
        pinned,
        options,
      ),
    ).toBe("invalid");
  });
});

describe("signedPrompt", () => {
  const item = (signed: unknown, body = prompt.text): LoggedItem<"prompt"> =>
    ({
      id: asId("item", "p1"),
      threadId: prompt.threadId,
      turnId: prompt.turnId,
      seq: 1,
      at: NOW,
      author: "user",
      kind: "prompt",
      body: { text: body, agent: prompt.agent, ...(signed ? { signed } : {}) },
    }) as LoggedItem<"prompt">;

  it("rebuilds what the device signed from the logged item, for the app it was connected to", async () => {
    const { key, pinned } = await enrolled();
    const statement = await promptStatement(APP, prompt, NOW);
    const signature = await key.sign(statementBytes(statement), { presence: false });
    const logged = item({ deviceId, at: NOW, signature });
    const rebuilt = await signedPrompt(APP, logged);
    expect(rebuilt && statementBytes(rebuilt.statement)).toEqual(
      statementBytes(statement),
    );
    expect(await verifyStatement(rebuilt!, pinned, options)).toBe("valid");
    const forAnotherApp = await signedPrompt("https://evil.example", logged);
    expect(await verifyStatement(forAnotherApp!, pinned, options)).toBe("invalid");
    const edited = await signedPrompt(
      APP,
      item({ deviceId, at: NOW, signature }, "rm -rf"),
    );
    expect(await verifyStatement(edited!, pinned, options)).toBe("invalid");
  });

  it("has nothing to rebuild from an unsigned prompt", async () => {
    expect(await signedPrompt(APP, item(undefined))).toBeUndefined();
  });
});

describe("verifyStatement with a WebAuthn assertion", () => {
  const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

  interface Authenticator {
    readonly publicKey: KeyObject;
    readonly privateKey: KeyObject;
  }

  function assertion(
    authenticator: Authenticator,
    statement: PromptStatement,
    tweak: {
      flags?: number;
      origin?: string;
      rpId?: string;
      type?: string;
      challenge?: string;
      keyId?: string;
      crossOrigin?: boolean;
    } = {},
  ) {
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: tweak.type ?? "webauthn.get",
        challenge:
          tweak.challenge ?? sha(statementBytes(statement)).toString("base64url"),
        origin: tweak.origin ?? APP,
        ...(tweak.crossOrigin ? { crossOrigin: true } : {}),
      }),
    );
    const authData = new Uint8Array(37);
    authData.set(sha(tweak.rpId ?? "hello.example"), 0);
    authData[32] = tweak.flags ?? 0x05;
    const signature = nodeSign("sha256", Buffer.concat([authData, sha(clientData)]), {
      key: authenticator.privateKey,
      dsaEncoding: "der",
    });
    return {
      statement,
      deviceId,
      signature: {
        keyId: tweak.keyId ?? "credential-1",
        presence: "user" as const,
        format: "webauthn" as const,
        signature: encodeBase64url(new Uint8Array(signature)),
        authenticatorData: encodeBase64url(authData),
        clientDataJSON: encodeBase64url(clientData),
      },
    };
  }

  async function pinnedWith(authenticator: Authenticator): Promise<PinnedDevice> {
    const { pinned } = await enrolled(false);
    const { kty, crv, x, y } = authenticator.publicKey.export({ format: "jwk" });
    return {
      ...pinned,
      presenceKey: {
        format: "webauthn",
        credentialId: "credential-1",
        rpId: "hello.example",
        publicKey: { kty, crv, x, y },
      },
    };
  }

  const wanted = { ...options, requirePresence: true };

  it("accepts an assertion over the statement's digest from the page's origin", async () => {
    const authenticator = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pinned = await pinnedWith(authenticator);
    const statement = await promptStatement(APP, prompt, NOW);
    expect(
      await verifyStatement(assertion(authenticator, statement), pinned, wanted),
    ).toBe("valid");
  });

  it("accepts signatures whose DER integers carry leading zeros or are short", async () => {
    const authenticator = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pinned = await pinnedWith(authenticator);
    const outcomes = new Set<string>();
    for (let at = 0; at < 40; at += 1) {
      const statement = await promptStatement(APP, prompt, NOW + at);
      outcomes.add(
        await verifyStatement(assertion(authenticator, statement), pinned, wanted),
      );
    }
    expect([...outcomes]).toEqual(["valid"]);
  });

  it.each([
    ["another origin", { origin: "https://evil.example" }],
    ["another relying party", { rpId: "evil.example" }],
    ["no user verification", { flags: 0x01 }],
    ["no user presence", { flags: 0x04 }],
    ["another ceremony type", { type: "webauthn.create" }],
    ["another challenge", { challenge: "AAAA" }],
    ["another credential", { keyId: "credential-2" }],
    ["a cross-origin frame", { crossOrigin: true }],
  ])("refuses an assertion with %s: invalid", async (_name, tweak) => {
    const authenticator = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pinned = await pinnedWith(authenticator);
    const statement = await promptStatement(APP, prompt, NOW);
    expect(
      await verifyStatement(assertion(authenticator, statement, tweak), pinned, wanted),
    ).toBe("invalid");
  });

  it("refuses an assertion for a statement it did not sign and one from another authenticator", async () => {
    const authenticator = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pinned = await pinnedWith(authenticator);
    const statement = await promptStatement(APP, prompt, NOW);
    const signed = assertion(authenticator, statement);
    const other = { ...signed, statement: { ...statement, turnId: asId("turn", "u2") } };
    expect(await verifyStatement(other, pinned, wanted)).toBe("invalid");
    const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await verifyStatement(assertion(stranger, statement), pinned, wanted)).toBe(
      "invalid",
    );
  });

  it("refuses a webauthn assertion when the app origin is not the relying party's host", async () => {
    const authenticator = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pinned = await pinnedWith(authenticator);
    const statement = await promptStatement("https://evil.example", prompt, NOW);
    expect(
      await verifyStatement(
        assertion(authenticator, statement, { origin: "https://evil.example" }),
        pinned,
        wanted,
      ),
    ).toBe("invalid");
  });
});
