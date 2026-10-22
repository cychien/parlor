// Follows the HTTP/1.1 exchanges on one proxied connection without touching its bytes: the request
// line when it arrives, the status of the response that answers it. It only reads the two byte
// streams; a stream it cannot parse (an upgrade, garbage) stops being followed and nothing else changes.

const MAX_HEAD_BYTES = 64 * 1024;
const NO_BODY_STATUS = new Set([204, 304]);

class Stream {
  constructor(kind, onHead) {
    this.kind = kind;
    this.onHead = onHead;
    this.mode = "head";
    this.head = Buffer.alloc(0);
    this.headAt = 0;
    this.line = Buffer.alloc(0);
    this.remaining = 0;
  }

  get following() {
    return this.mode !== "off" && this.mode !== "tunnel";
  }

  stop(mode = "off") {
    this.mode = mode;
    this.head = Buffer.alloc(0);
    this.line = Buffer.alloc(0);
  }

  push(chunk, at) {
    let offset = 0;
    while (offset < chunk.length && this.following) {
      offset = this.step(chunk, offset, at);
    }
  }

  step(chunk, offset, at) {
    switch (this.mode) {
      case "head":
        return this.readHead(chunk, offset, at);
      case "body":
        return this.skip(chunk, offset, "head");
      case "chunk-size":
        return this.readLine(chunk, offset, (line) => {
          const size = Number.parseInt(line.toString("latin1").split(";")[0].trim(), 16);
          if (!(size >= 0)) return this.stop();
          this.remaining = size;
          this.mode = size === 0 ? "trailers" : "chunk-data";
        });
      case "chunk-data":
        return this.skip(chunk, offset, "chunk-end");
      case "chunk-end":
        return this.readLine(chunk, offset, (line) => {
          if (line.length > 0) return this.stop();
          this.mode = "chunk-size";
        });
      case "trailers":
        return this.readLine(chunk, offset, (line) => {
          if (line.length === 0) this.mode = "head";
        });
      case "until-close":
        return chunk.length;
      default:
        return chunk.length;
    }
  }

  skip(chunk, offset, next) {
    const taken = Math.min(this.remaining, chunk.length - offset);
    this.remaining -= taken;
    if (this.remaining === 0) this.mode = next;
    return offset + taken;
  }

  readLine(chunk, offset, done) {
    const end = chunk.indexOf("\n", offset);
    const stop = end === -1 ? chunk.length : end + 1;
    this.line = Buffer.concat([this.line, chunk.subarray(offset, stop)]);
    if (this.line.length > MAX_HEAD_BYTES) {
      this.stop();
      return chunk.length;
    }
    if (end !== -1) {
      const line = this.line.subarray(
        0,
        this.line.length - (this.line.at(-2) === 13 ? 2 : 1),
      );
      this.line = Buffer.alloc(0);
      done(line);
    }
    return stop;
  }

  readHead(chunk, offset, at) {
    if (this.head.length === 0) this.headAt = at;
    const before = this.head.length;
    this.head = Buffer.concat([this.head, chunk.subarray(offset)]);
    const end = this.head.indexOf("\r\n\r\n", Math.max(0, before - 3));
    if (end === -1) {
      if (this.head.length > MAX_HEAD_BYTES) this.stop();
      return chunk.length;
    }
    const text = this.head.subarray(0, end).toString("latin1");
    const consumed = end + 4 - before;
    const headAt = this.headAt;
    this.head = Buffer.alloc(0);
    const lines = text.split("\r\n");
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0)
        headers.set(
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim(),
        );
    }
    this.onHead(lines[0], headers, headAt, at);
    return offset + consumed;
  }

  frame(headers, { chunked = true, bodyless = false } = {}) {
    if (bodyless) {
      this.mode = "head";
    } else if (chunked && /chunked/i.test(headers.get("transfer-encoding") ?? "")) {
      this.mode = "chunk-size";
    } else if (headers.has("content-length")) {
      this.remaining = Number(headers.get("content-length"));
      this.mode = this.remaining > 0 ? "body" : "head";
    } else {
      this.mode = this.kind === "response" ? "until-close" : "head";
    }
    if (!Number.isFinite(this.remaining)) this.stop();
  }
}

/**
 * `request(chunk, at)` takes the bytes the client sent, `response(chunk, at)` the bytes the server
 * sent, `close(at)` the end of the connection. `onExchange({ method, path, status, at, respondedAt })`
 * fires when a response head arrives (`at` is when its request line arrived), or at close with
 * `status: null` for a request nothing answered.
 */
export function createExchangeTracker({ onExchange }) {
  const pending = [];
  const requests = new Stream("request", (line, headers, headAt) => {
    const [method, target, version] = line.split(" ");
    if (!method || !target || !/^HTTP\/1\./.test(version ?? "")) return requests.stop();
    pending.push({ method, path: target, at: headAt });
    requests.frame(headers);
  });
  const responses = new Stream("response", (line, headers, headAt, at) => {
    const [version, code] = line.split(" ");
    const status = Number(code);
    if (!/^HTTP\/1\./.test(version ?? "") || !(status >= 100)) return responses.stop();
    if (status >= 100 && status < 200 && status !== 101) return;
    const request = pending.shift();
    if (!request) return responses.stop();
    onExchange({ ...request, status, respondedAt: at });
    if (status === 101 || request.method === "CONNECT") {
      requests.stop("tunnel");
      return responses.stop("tunnel");
    }
    responses.frame(headers, {
      bodyless: request.method === "HEAD" || NO_BODY_STATUS.has(status),
    });
  });

  return {
    request: (chunk, at) => requests.push(chunk, at),
    response: (chunk, at) => responses.push(chunk, at),
    close() {
      for (const request of pending.splice(0)) {
        onExchange({ ...request, status: null, respondedAt: null });
      }
    },
  };
}

export function selfCheck() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const get = (path) => `GET ${path} HTTP/1.1\r\nhost: x\r\n\r\n`;
  const post = (path, body) =>
    `POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
  const reply = (status, body) =>
    `HTTP/1.1 ${status} X\r\ncontent-length: ${body.length}\r\n\r\n${body}`;
  const chunked = (status, ...parts) =>
    `HTTP/1.1 ${status} X\r\ntransfer-encoding: chunked\r\n\r\n${parts
      .map((p) => `${p.length.toString(16)}\r\n${p}\r\n`)
      .join("")}0\r\n\r\n`;
  const cases = [
    {
      name: "keep-alive requests with bodies, each answered in order",
      sent: [get("/a?x=1"), post("/b", "hello"), get("/c")].join(""),
      received: [reply(200, "ok"), reply(401, "no"), chunked(200, "ab", "cdef")].join(""),
      expect: [
        ["GET", "/a?x=1", 200],
        ["POST", "/b", 401],
        ["GET", "/c", 200],
      ],
    },
    {
      name: "a chunked request body, an interim 100 and a bodyless 204 and 304",
      sent: [
        `POST /u HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n3;e=1\r\nabc\r\n0\r\nx: y\r\n\r\n`,
        get("/n"),
        get("/m"),
      ].join(""),
      received: [
        `HTTP/1.1 100 Continue\r\n\r\n${reply(201, "")}`,
        `HTTP/1.1 204 No Content\r\n\r\n`,
        `HTTP/1.1 304 Not Modified\r\netag: x\r\n\r\n`,
      ].join(""),
      expect: [
        ["POST", "/u", 201],
        ["GET", "/n", 204],
        ["GET", "/m", 304],
      ],
    },
    {
      name: "a HEAD response with a content-length has no body",
      sent: `HEAD /h HTTP/1.1\r\n\r\n${get("/after")}`,
      received: `HTTP/1.1 200 X\r\ncontent-length: 500\r\n\r\n${reply(200, "z")}`,
      expect: [
        ["HEAD", "/h", 200],
        ["GET", "/after", 200],
      ],
    },
    {
      name: "a streaming response is logged at its head and a request nobody answered at close",
      sent: `${get("/stream")}${get("/never")}`,
      received: `HTTP/1.1 200 X\r\ntransfer-encoding: chunked\r\n\r\n5\r\nevent\r\n`,
      expect: [
        ["GET", "/stream", 200],
        ["GET", "/never", null],
      ],
    },
    {
      name: "an upgrade stops the parsing",
      sent: `GET /ws HTTP/1.1\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\nraw`,
      received: `HTTP/1.1 101 Switching\r\n\r\nraw bytes`,
      expect: [["GET", "/ws", 101]],
    },
  ];
  for (const { name, sent, received, expect } of cases) {
    for (const split of ["whole", "bytes"]) {
      const seen = [];
      const tracker = createExchangeTracker({ onExchange: (e) => seen.push(e) });
      const feed = (push, text) => {
        const buffer = Buffer.from(text, "latin1");
        if (split === "whole") return push(buffer, 1);
        for (let i = 0; i < buffer.length; i += 1) push(buffer.subarray(i, i + 1), 1);
      };
      feed(tracker.request, sent);
      feed(tracker.response, received);
      tracker.close();
      const got = seen.map((e) => [e.method, e.path, e.status]);
      const ok = JSON.stringify(got) === JSON.stringify(expect);
      check(
        `${name} (${split})`,
        ok,
        ok ? `${got.length} exchanges` : JSON.stringify(got),
      );
    }
  }
  return results;
}
