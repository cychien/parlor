import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { subtle } = webcrypto;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };
const HOST_AUDIENCE = "parlor:host";
const HOST_ASSERTION_TYP = "parlor-host+jwt";
const ASSERTION_TTL_SECONDS = 60;
const MATCHING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MATCHING_CODE = /^[A-Z2-9]{3}-[A-Z2-9]{3}$/;
const DEFAULT_AGENTS = [
  { id: "fake", name: "Fake agent", version: "0.0.0", ready: true },
];
const DEFAULT_POLL_MS = 100;
const DEFAULT_HEARTBEAT_MS = 10_000;
const MCP_CALL_TIMEOUT_MS = 180_000;
const MCP_CALL_MAX_TOTAL_MS = 300_000;
const STEP_OPS = [
  "reply",
  "tool",
  "ask",
  "waitAnswer",
  "waitCancel",
  "mcp",
  "pause",
  "frames",
  "append",
  "finish",
];
const SEED_SCRIPT = {
  steps: [
    { op: "reply", chars: 200, deltas: 50, intervalMs: 0 },
    {
      op: "tool",
      title: "Created task",
      name: "createTask",
      kind: "app",
      status: "done",
    },
    { op: "finish" },
  ],
};

const base64url = (value) => Buffer.from(value).toString("base64url");
const sleepFor = (ms) => new Promise((done) => setTimeout(done, ms));

export function thumbprintOf({ crv, kty, x, y }) {
  return createHash("sha256")
    .update(JSON.stringify({ crv, kty, x, y }))
    .digest("base64url");
}

export async function generateHostKey() {
  const pair = await subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
  const { kty, crv, x, y, d } = await subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = { kty, crv, x, y };
  return {
    privateJwk: { ...publicJwk, d },
    publicJwk,
    thumbprint: thumbprintOf(publicJwk),
  };
}

export async function signBytes(privateJwk, bytes) {
  const key = await subtle.importKey("jwk", privateJwk, KEY_ALGORITHM, false, ["sign"]);
  return base64url(new Uint8Array(await subtle.sign(SIGN_ALGORITHM, key, bytes)));
}

export async function compactJws(privateJwk, header, payload) {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${signingInput}.${await signBytes(privateJwk, new TextEncoder().encode(signingInput))}`;
}

export function hostAssertionClaims(
  host,
  { method, url, iatOffset = 0, jti, now = Date.now() },
) {
  const iat = Math.floor(now / 1000) + iatOffset;
  return {
    aud: HOST_AUDIENCE,
    gid: host.grantId,
    htm: method,
    htu: url,
    iat,
    exp: iat + ASSERTION_TTL_SECONDS,
    jti: jti ?? randomUUID(),
  };
}

export async function hostAssertion(host, request) {
  const header = { alg: "ES256", typ: HOST_ASSERTION_TYP, kid: host.thumbprint };
  return compactJws(host.privateJwk, header, hostAssertionClaims(host, request));
}

export function pkcePair() {
  const codeVerifier = base64url(randomBytes(32));
  return { codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}

export function pkceChallenge(codeVerifier) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function matchingCode() {
  const pick = () =>
    Array.from(
      randomBytes(3),
      (byte) => MATCHING_ALPHABET[byte % MATCHING_ALPHABET.length],
    ).join("");
  return `${pick()}-${pick()}`;
}

async function verifyJws(publicJwk, jws) {
  const [header, payload, signature] = jws.split(".");
  const key = await subtle.importKey("jwk", publicJwk, KEY_ALGORITHM, false, ["verify"]);
  const valid = await subtle.verify(
    SIGN_ALGORITHM,
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    signatureBytes: Buffer.from(signature, "base64url").length,
  };
}

async function selfcheck() {
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });
  const key = await generateHostKey();
  check("public jwk has no d", !("d" in key.publicJwk));
  check("private jwk has d", typeof key.privateJwk.d === "string");
  check(
    "thumbprint is base64url sha-256",
    /^[A-Za-z0-9_-]{43}$/.test(key.thumbprint) &&
      key.thumbprint ===
        createHash("sha256")
          .update(
            `{"crv":"P-256","kty":"EC","x":"${key.publicJwk.x}","y":"${key.publicJwk.y}"}`,
          )
          .digest("base64url"),
  );
  const host = { ...key, grantId: "grant-selfcheck" };
  const url = "http://localhost:3300/_parlor/chat/actions/hostHello";
  const jws = await hostAssertion(host, {
    method: "POST",
    url,
    jti: "jti-1",
    iatOffset: -5,
  });
  const parsed = await verifyJws(key.publicJwk, jws);
  check("assertion verifies with the public key", parsed.valid);
  check("signature is raw r||s of 64 bytes", parsed.signatureBytes === 64);
  check(
    "header",
    parsed.header.alg === "ES256" &&
      parsed.header.typ === HOST_ASSERTION_TYP &&
      parsed.header.kid === key.thumbprint,
    JSON.stringify(parsed.header),
  );
  const { payload } = parsed;
  check(
    "claims",
    payload.aud === HOST_AUDIENCE &&
      payload.gid === "grant-selfcheck" &&
      payload.htm === "POST" &&
      payload.htu === url &&
      payload.jti === "jti-1" &&
      payload.exp === payload.iat + 60 &&
      Math.abs(payload.iat - (Date.now() / 1000 - 5)) < 3,
    JSON.stringify(payload),
  );
  const other = await generateHostKey();
  check("another key does not verify it", !(await verifyJws(other.publicJwk, jws)).valid);
  const proof = await signBytes(key.privateJwk, new TextEncoder().encode("a-code"));
  const proofKey = await subtle.importKey("jwk", key.publicJwk, KEY_ALGORITHM, false, [
    "verify",
  ]);
  check(
    "exchange proof verifies over the code",
    await subtle.verify(
      SIGN_ALGORITHM,
      proofKey,
      Buffer.from(proof, "base64url"),
      new TextEncoder().encode("a-code"),
    ),
  );
  check(
    "pkce S256 matches the RFC 7636 vector",
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ===
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  check("matching code shape", MATCHING_CODE.test(matchingCode()));
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? "ok  " : "FAIL"} ${result.name}${result.detail ? `: ${result.detail}` : ""}\n`,
    );
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

async function httpRequest(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 15_000 } = {},
) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text,
      json,
      startedAt,
      endedAt: Date.now(),
    };
  } catch (error) {
    return {
      status: 0,
      headers: {},
      text: String(error?.cause?.code ?? error),
      json: undefined,
      startedAt,
      endedAt: Date.now(),
    };
  }
}

const tracing = new AsyncLocalStorage();

function recordingFetch() {
  return async (input, init) => {
    const response = await fetch(input, init);
    const trace = tracing.getStore();
    if (trace) {
      trace.status = response.status;
      const text = await response.clone().text();
      try {
        trace.body = JSON.parse(text);
      } catch {
        trace.body = text;
      }
    }
    return response;
  };
}

async function traced(task) {
  const trace = {};
  try {
    return { value: await tracing.run(trace, task), ...trace };
  } catch (error) {
    return { error: String(error?.message ?? error), ...trace };
  }
}

function describeFrame(frame) {
  return {
    type: frame.type,
    itemId: frame.itemId ?? frame.item?.id,
    kind: frame.kind ?? frame.item?.kind,
    ...(frame.offset === undefined ? {} : { offset: frame.offset }),
    ...(frame.text === undefined ? {} : { chars: frame.text.length }),
    ...(frame.item?.status ? { status: frame.item.status } : {}),
  };
}

function generateText(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");
}

function splitEven(text, count) {
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push(
      text.slice(
        Math.floor((index * text.length) / count),
        Math.floor(((index + 1) * text.length) / count),
      ),
    );
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

export function createHostCommand(deps) {
  const {
    fail,
    log,
    readState,
    urls,
    instanceDir,
    userOf,
    asUser,
    writeJsonAtomic,
    axiAsync,
    browserRef,
    signInBrowser,
  } = deps;

  const hostsFile = (state) => join(instanceDir(state.id), "hosts.json");

  function readHosts(state) {
    return existsSync(hostsFile(state))
      ? JSON.parse(readFileSync(hostsFile(state), "utf8"))
      : {};
  }

  function saveHost(state, record) {
    writeJsonAtomic(hostsFile(state), { ...readHosts(state), [record.name]: record });
  }

  function requireHost(state, name, { paired = true } = {}) {
    if (!name) fail("--host NAME is required");
    const record = readHosts(state)[name];
    if (!record) {
      fail(
        `no host "${name}" on ${state.id}; paired: ${Object.keys(readHosts(state)).join(", ") || "none"}`,
      );
    }
    if (paired && !record.grantId) {
      fail(
        `host "${name}" has not completed pairing (no grant); run: host ${state.id} exchange --host "${name}"`,
      );
    }
    return record;
  }

  function publicSummary(record) {
    return {
      name: record.name,
      user: record.user,
      platform: record.platform,
      server: record.server,
      thumbprint: record.thumbprint,
      grantId: record.grantId ?? null,
      hostId: record.hostId ?? null,
      accountEmail: record.account?.email ?? null,
      pairedAt: record.pairedAt ?? null,
      pending: Boolean(record.pending),
      replayable: Boolean(record.lastExchange),
    };
  }

  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const printLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

  function secondsOption(value, fallback) {
    if (value === undefined) return fallback;
    const seconds = Number(value);
    if (!(seconds >= 0)) fail(`expected a number of seconds, got "${value}"`);
    return seconds;
  }

  async function loadCreateFakeHost(state) {
    const entry = join(
      instanceDir(state.id),
      "repo",
      "packages",
      "chat",
      "src",
      "testing",
      "index.ts",
    );
    if (!existsSync(entry)) {
      fail(
        `this snapshot has no @parlor/chat/testing (${entry} is missing), so there is no fake host to run. ` +
          "Phase 3 code has to be in the checkout; then run: hello.mjs sync " +
          `${state.id}, or up a new instance.`,
      );
    }
    const requireFromCli = createRequire(
      join(instanceDir(state.id), "repo", "packages", "cli", "package.json"),
    );
    const { tsImport } = await import(requireFromCli.resolve("tsx/esm/api"));
    const module = await tsImport(entry, import.meta.url);
    if (typeof module.createFakeHost !== "function") {
      fail(`${entry} does not export createFakeHost`);
    }
    return module.createFakeHost;
  }

  async function openFakeHost(state, host, agents) {
    const createFakeHost = await loadCreateFakeHost(state);
    try {
      return createFakeHost({
        origin: host.server,
        authorize: async ({ method, url }) =>
          `ParlorHost ${await hostAssertion(host, { method, url })}`,
        fetch: recordingFetch(),
        name: host.name,
        agents,
      });
    } catch (error) {
      if (/not implemented/i.test(String(error?.message))) {
        fail(
          `createFakeHost is not implemented in this snapshot (${error.message}): phase 3 code has only its type skeleton so far.`,
        );
      }
      throw error;
    }
  }

  function createTranscript({ host, file, extra = {}, live = true }) {
    const doc = {
      host: host.name,
      user: host.user,
      server: host.server,
      startedAt: Date.now(),
      endedAt: null,
      ...extra,
      events: [],
    };
    const flush = () => {
      if (file) writeJsonAtomic(file, doc);
    };
    return {
      doc,
      flush,
      emit(type, data = {}, { flushNow = true } = {}) {
        doc.events.push({ at: Date.now(), type, ...data });
        if (flushNow && live) flush();
      },
      end() {
        doc.endedAt = Date.now();
        flush();
      },
    };
  }

  function startHeartbeats(fake, emit, everyMs) {
    const timer = setInterval(async () => {
      const result = await traced(() => fake.heartbeat());
      emit("heartbeat", {
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
    }, everyMs);
    return () => clearInterval(timer);
  }

  async function sayHello(fake, emit) {
    const result = await traced(() => fake.hello());
    emit("hello", {
      status: result.status,
      welcome: result.value ?? result.body,
      ...(result.error ? { error: result.error } : {}),
    });
    if (result.error || !result.value) {
      fail(
        `hostHello failed: ${result.error ?? "no result"} (status ${result.status}) ${JSON.stringify(result.body)}`,
      );
    }
    return result.value;
  }

  function heartbeatInterval(welcome) {
    const reported = Number(welcome?.heartbeatMs);
    return reported >= 500 ? reported : DEFAULT_HEARTBEAT_MS;
  }

  async function claimNext(fake, emit, { timeoutMs, pollMs = 200 }) {
    const deadline = Date.now() + timeoutMs;
    emit("claim_wait", { timeoutMs });
    for (;;) {
      const result = await traced(() => fake.claim());
      if (result.error) {
        emit("claim_error", {
          status: result.status,
          body: result.body,
          error: result.error,
        });
        return { error: result.error };
      }
      if (result.value) {
        emit("claim", { status: result.status, turn: result.value });
        return { turn: result.value };
      }
      if (Date.now() >= deadline) {
        emit("claim_timeout", { timeoutMs });
        return {};
      }
      await sleepFor(pollMs);
    }
  }

  function validateScript(script, label) {
    if (!script || !Array.isArray(script.steps))
      fail(`${label}: expected {"steps": [...]}`);
    for (const [index, step] of script.steps.entries()) {
      if (!STEP_OPS.includes(step?.op)) {
        fail(
          `${label}: step ${index} has op ${JSON.stringify(step?.op)}; known ops: ${STEP_OPS.join(", ")}`,
        );
      }
    }
    return script;
  }

  function readScript(file) {
    const path = resolve(file);
    if (!existsSync(path)) fail(`no script ${path}`);
    return validateScript(JSON.parse(readFileSync(path, "utf8")), path);
  }

  function pollSignals({ fake, emit, turn, pollMs }) {
    const stopper = new AbortController();
    const loop = (async () => {
      while (!stopper.signal.aborted) {
        const result = await traced(() =>
          fake.call("hostSignals", {
            turns: [{ turnId: turn.id, afterSeq: turn.afterSeq }],
          }),
        );
        const items = (Array.isArray(result.value) ? result.value : [])
          .filter((signals) => signals.turnId === turn.id)
          .flatMap((signals) => signals.items);
        for (const item of items) {
          turn.afterSeq = Math.max(turn.afterSeq, item.seq);
          if (item.kind === "cancel") {
            turn.cancelSeenAt ??= Date.now();
            emit("cancel_seen", { itemId: item.id, seq: item.seq });
          } else if (item.kind === "answer") {
            turn.answers.set(item.body.askId, {
              choice: item.body.choice,
              at: Date.now(),
            });
            emit("answer_seen", {
              itemId: item.id,
              seq: item.seq,
              askId: item.body.askId,
              choice: item.body.choice,
            });
          }
        }
        emit(
          "signals",
          {
            status: result.status,
            seen: items.map((item) => ({ id: item.id, kind: item.kind, seq: item.seq })),
            ...(result.error ? { error: result.error } : {}),
          },
          { flushNow: items.length > 0 || Boolean(result.error) },
        );
        for (let waited = 0; waited < pollMs && !stopper.signal.aborted; waited += 10)
          await sleepFor(10);
      }
    })();
    return async () => {
      stopper.abort();
      await loop;
    };
  }

  async function mcpToolCall(state, { url, headers, token, tool, input }) {
    const requireFromServer = createRequire(
      join(instanceDir(state.id), "repo", "packages", "server", "package.json"),
    );
    const { Client, StreamableHTTPClientTransport } = requireFromServer(
      "@modelcontextprotocol/client",
    );
    const client = new Client({ name: "verify-hello-host", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        },
      }),
    );
    try {
      return await client.callTool(
        { name: tool, arguments: input },
        {
          timeout: MCP_CALL_TIMEOUT_MS,
          maxTotalTimeout: MCP_CALL_MAX_TOTAL_MS,
          resetTimeoutOnProgress: true,
          onprogress: () => {},
        },
      );
    } finally {
      await client.close();
    }
  }

  async function playTurn({
    state,
    host,
    fake,
    emit,
    claimed,
    script,
    turnNo,
    pollMs,
    quiet,
  }) {
    const turn = {
      id: claimed.turnId,
      token: claimed.token?.token,
      nextItem: 1,
      afterSeq: claimed.prompt?.seq ?? 0,
      cancelSeenAt: undefined,
      stopped: false,
      answers: new Map(),
      asks: new Map(),
      lastAsk: undefined,
      pending: [],
      finished: undefined,
      failures: 0,
    };
    const note = (type, data, options) =>
      emit(type, { turn: turnNo, turnId: turn.id, ...data }, options);
    const itemId = (step) => step.id ?? `${turn.id}.${turn.nextItem++}`;
    const stopSignals = pollSignals({ fake, emit: note, turn, pollMs });

    const sendFrames = async (frames) => {
      const result = await traced(() => fake.stream(turn.id, frames));
      const status = result.status ?? result.value?.status;
      if (result.error || status >= 400) turn.failures += 1;
      note(
        "stream",
        {
          status,
          frames: frames.map(describeFrame),
          ...(result.error ? { error: result.error } : {}),
        },
        { flushNow: !quiet },
      );
      return status;
    };

    const appendItems = async (items) => {
      const result = await traced(() =>
        fake.call("hostAppend", { turnId: turn.id, items }),
      );
      if (result.value?.token?.token) turn.token = result.value.token.token;
      if (result.error || result.status >= 400) turn.failures += 1;
      note(
        "append",
        {
          status: result.status,
          items: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            ...(item.body.status ? { toolStatus: item.body.status } : {}),
            ...(item.body.interrupted ? { interrupted: true } : {}),
            ...(typeof item.body.text === "string"
              ? { chars: item.body.text.length }
              : {}),
          })),
          leaseUntil: result.value?.leaseUntil,
          ...(result.error ? { error: result.error, body: result.body } : {}),
        },
        { flushNow: !quiet },
      );
    };

    const waitFor = async (what, ready, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!ready()) {
        if (Date.now() > deadline)
          throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
        await sleepFor(20);
      }
    };

    const steps = {
      async reply(step) {
        const kind = step.kind ?? "reply";
        const id = itemId(step);
        const text = step.text ?? generateText(step.chars ?? 200);
        const chunks = splitEven(text, Math.max(1, step.deltas ?? 10));
        const interval = step.intervalMs ?? 0;
        const startedAt = Date.now();
        let sent = "";
        let interrupted = false;
        for (const [index, chunk] of chunks.entries()) {
          if (step.stopOnCancel && turn.cancelSeenAt) {
            interrupted = true;
            turn.stopped = true;
            break;
          }
          await sendFrames([
            { type: "delta", itemId: id, kind, offset: sent.length, text: chunk },
          ]);
          sent += chunk;
          if (step.holdAfterDelta?.n === index + 1) {
            note("pause", { ms: step.holdAfterDelta.ms, afterDelta: index + 1 });
            await sleepFor(step.holdAfterDelta.ms);
          }
          if (interval > 0 && index < chunks.length - 1) {
            await sleepFor(Math.max(0, startedAt + (index + 1) * interval - Date.now()));
          }
        }
        if (step.persist !== false) {
          const body =
            kind === "reply" && interrupted
              ? { text: sent, interrupted: true }
              : { text: sent };
          await appendItems([{ id, kind, body }]);
        }
      },
      async tool(step) {
        const id = itemId(step);
        if (step.runningMs > 0) {
          await sendFrames([
            {
              type: "item",
              item: { id, kind: "tool", title: step.title, status: "running" },
            },
          ]);
          await sleepFor(step.runningMs);
        }
        await appendItems([
          {
            id,
            kind: "tool",
            body: {
              title: step.title,
              tool: { kind: step.kind ?? "app", name: step.name ?? "tool" },
              status: step.status ?? "done",
              ...(step.detail ? { detail: step.detail } : {}),
            },
          },
        ]);
      },
      async ask(step) {
        const id = itemId(step);
        turn.asks.set(step.as ?? id, id);
        turn.lastAsk = id;
        await appendItems([
          {
            id,
            kind: "ask",
            body: {
              question: step.question ?? "Allow this?",
              choices: step.choices ?? [
                { id: "allow", label: "Allow", effect: "allow_once" },
                { id: "reject", label: "Reject", effect: "reject_once" },
              ],
              approval: step.approval ?? "computer",
              ...(step.form ? { form: step.form } : {}),
            },
          },
        ]);
      },
      async waitAnswer(step) {
        const askId = step.ask ? (turn.asks.get(step.ask) ?? step.ask) : turn.lastAsk;
        if (!askId) throw new Error("waitAnswer has no ask to wait for");
        note("wait", { for: "answer", askId });
        await waitFor(
          `an answer to ${askId}`,
          () => turn.answers.has(askId),
          step.timeoutMs ?? 60_000,
        );
      },
      async waitCancel(step) {
        note("wait", { for: "cancel" });
        await waitFor(
          "a cancel",
          () => turn.cancelSeenAt !== undefined,
          step.timeoutMs ?? 60_000,
        );
      },
      async mcp(step) {
        const via = step.via === "web" ? urls(state).mcp : `${host.server}/_parlor/mcp`;
        const auth = step.auth ?? "turn";
        const call = {
          url: via,
          tool: step.tool,
          input: step.input ?? {},
          headers: step.headers ?? {},
          token: auth === "turn" ? turn.token : undefined,
        };
        const startedAt = Date.now();
        note("mcp_start", {
          label: step.as,
          tool: step.tool,
          input: call.input,
          headers: call.headers,
          auth,
          url: via,
        });
        const run = mcpToolCall(state, call).then(
          (result) =>
            note("mcp_result", {
              label: step.as,
              tool: step.tool,
              startedAt,
              ms: Date.now() - startedAt,
              isError: Boolean(result.isError),
              result,
            }),
          (error) => {
            turn.failures += 1;
            note("mcp_result", {
              label: step.as,
              tool: step.tool,
              startedAt,
              ms: Date.now() - startedAt,
              isError: true,
              result: { error: String(error?.message ?? error) },
            });
          },
        );
        if (step.wait === false) turn.pending.push(run);
        else await run;
      },
      async pause(step) {
        note("pause", { ms: step.ms });
        await sleepFor(step.ms ?? 0);
      },
      async frames(step) {
        for (let attempt = 0; attempt < (step.repeat ?? 1); attempt += 1)
          await sendFrames(step.frames);
      },
      async append(step) {
        for (let attempt = 0; attempt < (step.repeat ?? 1); attempt += 1)
          await appendItems(step.items);
      },
      async finish(step) {
        await Promise.allSettled(turn.pending);
        const outcome =
          step.outcome && step.outcome !== "auto"
            ? step.outcome
            : turn.cancelSeenAt
              ? { state: "cancelled" }
              : { state: "done", stopReason: "end_turn" };
        const result = await traced(() =>
          fake.call("hostFinish", { turnId: turn.id, outcome }),
        );
        if (result.error || result.status >= 400) turn.failures += 1;
        note("finish", {
          outcome,
          status: result.status,
          ...(result.error ? { error: result.error, body: result.body } : {}),
        });
        turn.finished = { outcome, status: result.status, at: Date.now() };
      },
    };

    try {
      for (const step of script.steps) {
        if (turn.finished) break;
        if (turn.stopped && step.op !== "finish") continue;
        await steps[step.op](step);
      }
      if (!turn.finished) await steps.finish({});
    } catch (error) {
      turn.failures += 1;
      note("error", { error: String(error?.message ?? error) });
      if (!turn.finished) {
        await steps
          .finish({ outcome: { state: "failed", reason: "agent_exited" } })
          .catch(() => {});
      }
    } finally {
      await stopSignals();
    }
    return {
      turnId: turn.id,
      finished: turn.finished,
      cancelSeenAt: turn.cancelSeenAt,
      failures: turn.failures,
    };
  }

  function onTerminate(handler) {
    let handled = false;
    const wrapped = () => {
      if (handled) return;
      handled = true;
      handler();
    };
    process.once("SIGTERM", wrapped);
    process.once("SIGINT", wrapped);
  }

  async function cmdPlay(state, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        host: { type: "string" },
        out: { type: "string" },
        "wait-claim": { type: "string" },
        turns: { type: "string" },
        "poll-ms": { type: "string" },
      },
    });
    if (!positionals[0])
      fail(
        "usage: host ID play --host NAME SCRIPT.json [--out FILE] [--wait-claim SECONDS] [--turns N]",
      );
    const host = requireHost(state, values.host);
    const script = readScript(positionals[0]);
    const turns = Number(values.turns ?? script.turns ?? 1);
    const waitMs = secondsOption(values["wait-claim"], 60) * 1000;
    const pollMs = Number(values["poll-ms"] ?? DEFAULT_POLL_MS);
    const fake = await openFakeHost(state, host, script.agents ?? DEFAULT_AGENTS);
    const transcript = createTranscript({
      host,
      file: values.out && resolve(values.out),
      extra: { script: resolve(positionals[0]) },
    });
    const { emit } = transcript;
    onTerminate(() => {
      emit("terminated");
      transcript.end();
      process.exit(143);
    });
    const welcome = await sayHello(fake, emit);
    const stopHeartbeats = startHeartbeats(fake, emit, heartbeatInterval(welcome));
    const results = [];
    try {
      for (let turnNo = 1; turnNo <= turns; turnNo += 1) {
        const claim = await claimNext(fake, emit, { timeoutMs: waitMs });
        if (!claim.turn) {
          results.push({ error: claim.error ?? "no turn claimed" });
          break;
        }
        results.push(
          await playTurn({
            state,
            host,
            fake,
            emit,
            claimed: claim.turn,
            script,
            turnNo,
            pollMs,
            quiet: false,
          }),
        );
      }
    } finally {
      stopHeartbeats();
      transcript.end();
    }
    const failed = results.some((result) => result.error || result.failures > 0);
    print({ transcript: values.out ? resolve(values.out) : null, turns: results });
    if (failed) process.exitCode = 1;
  }

  async function cmdHello(state, args) {
    const { values } = parseArgs({ args, options: { host: { type: "string" } } });
    const host = requireHost(state, values.host);
    const fake = await openFakeHost(state, host, DEFAULT_AGENTS);
    const events = [];
    const welcome = await sayHello(fake, (type, data) => events.push({ type, ...data }));
    print({ host: host.name, status: events[0].status, welcome });
  }

  async function cmdOnline(state, args) {
    const { values } = parseArgs({
      args,
      options: { host: { type: "string" }, seconds: { type: "string" } },
    });
    const host = requireHost(state, values.host);
    const fake = await openFakeHost(state, host, DEFAULT_AGENTS);
    const welcome = await sayHello(fake, () => {});
    printLine({ host: host.name, online: true, welcome });
    const stopHeartbeats = startHeartbeats(fake, () => {}, heartbeatInterval(welcome));
    const seconds = secondsOption(values.seconds, 0);
    await new Promise((done) => {
      if (seconds > 0) setTimeout(done, seconds * 1000);
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
    stopHeartbeats();
    const report = await traced(() =>
      fake.call("hostReport", { online: false, agents: [] }),
    );
    printLine({ host: host.name, online: false, status: report.status });
  }

  async function sendPrompt(state, host, options) {
    const ids = {
      threadId: options.threadId ?? `thr-${randomBytes(6).toString("hex")}`,
      turnId: options.turnId ?? `turn-${randomBytes(6).toString("hex")}`,
      itemId: options.itemId ?? `item-${randomBytes(6).toString("hex")}`,
    };
    const clientId = options.clientId ?? "verify-hello-host";
    const input = {
      ...ids,
      clientId,
      prompt: {
        text: options.text,
        agent: {
          hostId: options.hostId ?? host.hostId,
          agentId: options.agentId ?? DEFAULT_AGENTS[0].id,
        },
      },
    };
    const response = await asUser(state, options.user, (token) =>
      httpRequest(`${host.server}/_parlor/chat/actions/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-parlor-client": clientId,
        },
        body: JSON.stringify(input),
      }),
    );
    return { ids, input, response };
  }

  async function cmdSend(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        as: { type: "string" },
        text: { type: "string" },
        thread: { type: "string" },
        turn: { type: "string" },
        item: { type: "string" },
        "client-id": { type: "string" },
        "agent-id": { type: "string" },
        "host-id": { type: "string" },
        out: { type: "string" },
      },
    });
    const host = requireHost(state, values.host);
    const user = userOf(values.as ?? host.user).id;
    const { ids, response } = await sendPrompt(state, host, {
      user,
      text: values.text ?? "hello from verify-hello",
      threadId: values.thread,
      turnId: values.turn,
      itemId: values.item,
      clientId: values["client-id"],
      agentId: values["agent-id"],
      hostId: values["host-id"],
    });
    const record = {
      as: user,
      ...ids,
      startedAt: response.startedAt,
      endedAt: response.endedAt,
      status: response.status,
      body: response.json ?? response.text,
    };
    if (values.out) writeJsonAtomic(resolve(values.out), record);
    print(record);
  }

  async function cmdSeedThread(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        as: { type: "string" },
        turns: { type: "string" },
        thread: { type: "string" },
        script: { type: "string" },
        out: { type: "string" },
        "poll-ms": { type: "string" },
        "client-id": { type: "string" },
      },
    });
    const host = requireHost(state, values.host);
    const user = userOf(values.as ?? host.user).id;
    const count = Number(values.turns ?? 100);
    if (!(count >= 1)) fail("--turns must be at least 1");
    const script = values.script ? readScript(values.script) : SEED_SCRIPT;
    const pollMs = Number(values["poll-ms"] ?? 250);
    const threadId = values.thread ?? `thr-${randomBytes(6).toString("hex")}`;
    const fake = await openFakeHost(state, host, script.agents ?? DEFAULT_AGENTS);
    const transcript = createTranscript({
      host,
      file: values.out && resolve(values.out),
      live: false,
      extra: { threadId, user },
    });
    const { emit } = transcript;
    const welcome = await sayHello(fake, emit);
    const stopHeartbeats = startHeartbeats(fake, emit, heartbeatInterval(welcome));
    const startedAt = Date.now();
    const durations = [];
    let failures = 0;
    let error;
    try {
      for (let turnNo = 1; turnNo <= count; turnNo += 1) {
        const turnStartedAt = Date.now();
        const sent = await sendPrompt(state, host, {
          user,
          text: `seed prompt ${turnNo}`,
          threadId,
          clientId: values["client-id"],
          agentId: (script.agents ?? DEFAULT_AGENTS)[0].id,
        });
        emit(
          "send",
          { turn: turnNo, status: sent.response.status, turnId: sent.ids.turnId },
          { flushNow: false },
        );
        if (sent.response.status !== 200) {
          error = `send ${turnNo} answered ${sent.response.status}: ${sent.response.text.slice(0, 300)}`;
          break;
        }
        const claim = await claimNext(fake, () => {}, { timeoutMs: 30_000, pollMs: 50 });
        if (!claim.turn) {
          error = `turn ${turnNo} was not claimed: ${claim.error ?? "none waiting"}`;
          break;
        }
        const result = await playTurn({
          state,
          host,
          fake,
          emit,
          claimed: claim.turn,
          script,
          turnNo,
          pollMs,
          quiet: true,
        });
        failures += result.failures;
        durations.push(Date.now() - turnStartedAt);
      }
    } finally {
      stopHeartbeats();
      transcript.end();
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const summary = {
      threadId,
      user,
      requested: count,
      completed: durations.length,
      failures,
      durationMs: Date.now() - startedAt,
      turnMsP50: sorted[Math.floor(sorted.length / 2)] ?? null,
      turnMsMax: sorted.at(-1) ?? null,
      ...(error ? { error } : {}),
    };
    print(summary);
    if (error || failures > 0) process.exitCode = 1;
  }

  function credentialKind(auth, header) {
    if (auth === "none") return "none";
    if (auth === "host") return "host-assertion";
    if (/^ParlorHost /.test(header)) return "host-assertion (literal)";
    if (/^Bearer /.test(header)) return "bearer (literal)";
    return "literal";
  }

  async function cmdRequest(state, args, { action }) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        host: { type: "string" },
        method: { type: "string" },
        url: { type: "string" },
        body: { type: "string" },
        auth: { type: "string" },
        header: { type: "string", multiple: true },
        "assert-url": { type: "string" },
        "assert-method": { type: "string" },
        "iat-offset": { type: "string" },
        jti: { type: "string" },
        note: { type: "string" },
        out: { type: "string" },
      },
    });
    const host = requireHost(state, values.host, { paired: values.auth !== "none" });
    let method = values.method ?? "POST";
    let url = values.url;
    let body = values.body;
    if (action) {
      const [name, json] = positionals;
      if (!name) fail("usage: host ID call --host NAME ACTION [JSON] [options]");
      url ??= `${host.server}/_parlor/chat/actions/${name}`;
      method = "POST";
      body = json ?? "{}";
    }
    if (!url) fail("--url is required");
    const auth = values.auth ?? "host";
    let authorization;
    const assertedUrl = values["assert-url"] ?? url;
    if (auth === "host") {
      authorization = `ParlorHost ${await hostAssertion(host, {
        method: values["assert-method"] ?? method,
        url: assertedUrl,
        iatOffset: Number(values["iat-offset"] ?? 0),
        jti: values.jti,
      })}`;
    } else if (auth !== "none") {
      authorization = auth;
    }
    const headers = {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authorization ? { authorization } : {}),
      ...Object.fromEntries(
        (values.header ?? []).map((pair) => [
          pair.slice(0, pair.indexOf("=")),
          pair.slice(pair.indexOf("=") + 1),
        ]),
      ),
    };
    const response = await httpRequest(url, { method, headers, body });
    const record = {
      ...(values.note ? { note: values.note } : {}),
      request: {
        method,
        url,
        credential: credentialKind(auth, authorization ?? ""),
        ...(auth === "host"
          ? { assertedUrl, iatOffset: Number(values["iat-offset"] ?? 0) }
          : {}),
        ...(body === undefined ? {} : { body: JSON.parse(body) }),
      },
      startedAt: response.startedAt,
      endedAt: response.endedAt,
      status: response.status,
      headers: response.headers,
      body: response.json ?? response.text,
    };
    if (values.out) writeJsonAtomic(resolve(values.out), record);
    print(record);
    if (response.status === 0) process.exitCode = 1;
  }

  async function cmdAssert(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        method: { type: "string" },
        url: { type: "string" },
        "iat-offset": { type: "string" },
        jti: { type: "string" },
      },
    });
    const host = requireHost(state, values.host);
    if (!values.method || !values.url) {
      fail(
        "usage: host ID assert --host NAME --method GET|POST --url URL [--iat-offset SECONDS] [--jti J]",
      );
    }
    const assertion = await hostAssertion(host, {
      method: values.method,
      url: values.url,
      iatOffset: Number(values["iat-offset"] ?? 0),
      jti: values.jti,
    });
    process.stdout.write(`ParlorHost ${assertion}\n`);
  }

  async function cmdStream(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        out: { type: "string" },
        since: { type: "string" },
        seconds: { type: "string" },
      },
    });
    const host = requireHost(state, values.host);
    const url = `${host.server}/_parlor/sync/stream`;
    const file = values.out && resolve(values.out);
    const doc = {
      host: host.name,
      url,
      requestedAt: Date.now(),
      openedAt: null,
      status: null,
      endedAt: null,
      endReason: null,
      keepAlives: 0,
      events: [],
    };
    const flush = () => file && writeJsonAtomic(file, doc);
    const controller = new AbortController();
    let abortedBy;
    const abort = (reason) => {
      abortedBy ??= reason;
      controller.abort();
    };
    onTerminate(() => abort("terminated"));
    const seconds = secondsOption(values.seconds, 600);
    const timer = setTimeout(() => abort("timeout"), seconds * 1000);
    try {
      const response = await fetch(
        values.since ? `${url}?since=${encodeURIComponent(values.since)}` : url,
        {
          headers: {
            authorization: `ParlorHost ${await hostAssertion(host, { method: "GET", url })}`,
            accept: "text/event-stream",
          },
          signal: controller.signal,
        },
      );
      doc.openedAt = Date.now();
      doc.status = response.status;
      flush();
      if (!response.ok || !response.body) {
        doc.body = await response.text();
        doc.endReason = `status ${response.status}`;
      } else {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            const lines = block.split("\n");
            const event = lines
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            const data = lines
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!event && !data) {
              doc.keepAlives += 1;
              continue;
            }
            doc.events.push({
              at: Date.now(),
              event: event ?? "message",
              data: data.slice(0, 300),
            });
            flush();
          }
        }
        doc.endReason = "server_closed";
      }
    } catch (error) {
      doc.endReason =
        abortedBy ?? `error: ${error?.cause?.code ?? error?.message ?? error}`;
    } finally {
      clearTimeout(timer);
      doc.endedAt = Date.now();
      flush();
    }
    print(doc);
    if (doc.status !== 200) process.exitCode = 1;
  }

  function loopbackListener() {
    let deliver;
    const callback = new Promise((resolveCallback) => {
      deliver = resolveCallback;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><title>Connected</title><p>You can close this tab.</p>",
      );
      deliver({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
      });
    });
    return new Promise((ready) => {
      server.listen(0, "127.0.0.1", () => {
        ready({
          port: server.address().port,
          callback,
          close() {
            server.close();
            server.closeAllConnections();
          },
        });
      });
    });
  }

  async function exchangeCode(host, { code, codeVerifier, signingKey, publicKey }) {
    const proof = await signBytes(signingKey, new TextEncoder().encode(code));
    const request = { code, codeVerifier, publicKey, proof };
    const response = await httpRequest(`${host.server}/_parlor/auth/hosts/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return { request, response };
  }

  function adoptGrant(record, response) {
    const grant = response.json?.grant ?? response.json?.data?.grant;
    const account = response.json?.account ?? response.json?.data?.account;
    if (response.status !== 200 || !grant) return false;
    record.grantId = grant.id;
    record.hostId = grant.hostId;
    record.account = account;
    record.pairedAt = new Date().toISOString();
    return true;
  }

  async function driveConsent(state, { user, url, out, steps }) {
    const snapshotOf = async () => (await axiAsync(state, ["snapshot", "--full"])).stdout;
    await axiAsync(state, ["open", url]);
    let aria = await snapshotOf();
    if (!(aria.includes('button "Connect"') && aria.includes(userOf(user).email))) {
      steps("consent page did not show Connect for the user; signing in", { user });
      await signInBrowser(state, user);
      await axiAsync(state, ["open", url]);
      aria = await snapshotOf();
    }
    if (!aria.includes('button "Connect"')) {
      fail(
        `the consent page has no Connect button (a snapshot without @parlor/auth host pairing serves a 404 here):\n${aria}`,
      );
    }
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "consent.aria.txt"), aria);
      await axiAsync(state, ["screenshot", join(out, "consent.png")]);
      steps("saved consent page", { out });
    }
    await axiAsync(state, ["click", browserRef(state, "button", "Connect")]);
    steps("clicked Connect", {});
  }

  async function cmdPair(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        as: { type: "string" },
        name: { type: "string" },
        platform: { type: "string" },
        out: { type: "string" },
        timeout: { type: "string" },
        "no-approve": { type: "boolean" },
        "no-exchange": { type: "boolean" },
        stay: { type: "boolean" },
      },
    });
    if (!values.name)
      fail(
        'usage: host ID pair --as alice|bob --name "<host name>" [--out DIR] [--no-approve] [--no-exchange]',
      );
    const user = userOf(values.as ?? "alice").id;
    const out = values.out && resolve(values.out);
    const transcript = [];
    const step = (what, data = {}) => {
      transcript.push({ at: Date.now(), step: what, ...data });
      log(`pair: ${what}`);
    };
    const key = await generateHostKey();
    const { codeVerifier, codeChallenge } = pkcePair();
    const request = {
      codeChallenge,
      state: base64url(randomBytes(12)),
      hostName: values.name,
      platform: values.platform ?? "verify-hello",
      matchingCode: matchingCode(),
      keyThumbprint: key.thumbprint,
    };
    const record = {
      name: values.name,
      user,
      platform: request.platform,
      server: urls(state).server,
      ...key,
      pending: undefined,
      lastExchange: undefined,
    };
    const listener = await loopbackListener();
    try {
      const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
      const authorizeUrl = `${urls(state).web}/_parlor/auth/hosts/authorize?${new URLSearchParams({ redirectUri, ...request })}`;
      step("generated key", { thumbprint: key.thumbprint });
      step("authorize url", { authorizeUrl });
      printLine({
        authorizeUrl,
        matchingCode: request.matchingCode,
        redirectUri,
        state: request.state,
        thumbprint: key.thumbprint,
      });
      if (out)
        writeJsonAtomic(join(out, "authorize.json"), {
          authorizeUrl,
          redirectUri,
          ...request,
        });
      if (!values["no-approve"])
        await driveConsent(state, { user, url: authorizeUrl, out, steps: step });
      const waitMs = secondsOption(values.timeout, 120) * 1000;
      let timeout;
      const callback = await Promise.race([
        listener.callback,
        new Promise((expire) => {
          timeout = setTimeout(
            () => expire({ error: "timeout waiting for the callback" }),
            waitMs,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      step("callback", { ...callback });
      if (callback.error || !callback.code) {
        const failure = {
          error: callback.error ?? "no code in the callback",
          transcript,
        };
        print(failure);
        process.exitCode = 1;
        return;
      }
      if (callback.state !== request.state)
        fail(`callback state ${callback.state} does not match ${request.state}`);
      record.pending = { code: callback.code, codeVerifier };
      saveHost(state, record);
      if (!values["no-approve"] && !values.stay) {
        await axiAsync(state, ["open", `${urls(state).web}/`]).catch(() => {});
      }
      if (values["no-exchange"]) {
        step("exchange skipped");
        print({ host: publicSummary(record), transcript });
        return;
      }
      const result = await exchangeCode(record, {
        code: callback.code,
        codeVerifier,
        signingKey: key.privateJwk,
        publicKey: key.publicJwk,
      });
      record.pending = undefined;
      record.lastExchange = result.request;
      const granted = adoptGrant(record, result.response);
      saveHost(state, record);
      step("exchange", {
        status: result.response.status,
        body: result.response.json ?? result.response.text,
      });
      if (out) writeJsonAtomic(join(out, "pair-transcript.json"), transcript);
      print({
        host: publicSummary(record),
        status: result.response.status,
        response: result.response.json ?? result.response.text,
        transcript,
      });
      if (!granted) process.exitCode = 1;
    } finally {
      listener.close();
    }
  }

  async function cmdExchange(state, args) {
    const { values } = parseArgs({
      args,
      options: {
        host: { type: "string" },
        replay: { type: "boolean" },
        "wrong-key": { type: "boolean" },
        out: { type: "string" },
      },
    });
    const record = requireHost(state, values.host, { paired: false });
    const source = values.replay ? record.lastExchange : record.pending;
    if (!source) {
      fail(
        values.replay
          ? `host "${record.name}" has no earlier exchange to replay`
          : `host "${record.name}" has no pending code; run pair --no-exchange first`,
      );
    }
    const code = source.code;
    const codeVerifier = source.codeVerifier;
    const otherKey = values["wrong-key"] ? await generateHostKey() : undefined;
    const result = await exchangeCode(record, {
      code,
      codeVerifier,
      signingKey: (otherKey ?? record).privateJwk,
      publicKey: record.publicJwk,
    });
    if (!values.replay) {
      record.pending = undefined;
      record.lastExchange = result.request;
    }
    const granted =
      !values.replay && !values["wrong-key"] && adoptGrant(record, result.response);
    saveHost(state, record);
    const output = {
      host: publicSummary(record),
      mode: values.replay ? "replay" : values["wrong-key"] ? "wrong-key" : "pending",
      startedAt: result.response.startedAt,
      endedAt: result.response.endedAt,
      status: result.response.status,
      body: result.response.json ?? result.response.text,
    };
    if (values.out) writeJsonAtomic(resolve(values.out), output);
    print(output);
    if (values.replay || values["wrong-key"] ? result.response.status === 0 : !granted)
      process.exitCode = 1;
  }

  function cmdList(state) {
    print(Object.values(readHosts(state)).map(publicSummary));
  }

  const USAGE =
    "usage: host selfcheck | host ID pair|exchange|assert|call|request|play|hello|online|send|stream|seed-thread|list [options]";

  const attachNegativeNumbers = (args) =>
    args.reduce((joined, arg) => {
      if (/^-\d+(\.\d+)?$/.test(arg) && /^--[\w-]+$/.test(joined.at(-1) ?? "")) {
        joined[joined.length - 1] = `${joined.at(-1)}=${arg}`;
      } else {
        joined.push(arg);
      }
      return joined;
    }, []);

  return async function cmdHost(rawArgs) {
    const [first, action, ...rest] = attachNegativeNumbers(rawArgs);
    if (first === "selfcheck") return selfcheck();
    if (!first || !action) fail(USAGE);
    const state = readState(first);
    const commands = {
      pair: cmdPair,
      exchange: cmdExchange,
      assert: cmdAssert,
      call: (s, a) => cmdRequest(s, a, { action: true }),
      request: (s, a) => cmdRequest(s, a, { action: false }),
      play: cmdPlay,
      hello: cmdHello,
      online: cmdOnline,
      send: cmdSend,
      stream: cmdStream,
      "seed-thread": cmdSeedThread,
      list: cmdList,
    };
    const command = commands[action];
    if (!command) fail(`unknown host command "${action}"\n${USAGE}`);
    return command(state, rest);
  };
}
