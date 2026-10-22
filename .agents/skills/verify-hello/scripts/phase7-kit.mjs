// Shared code of the phase 7 check scripts (degradation and reconnect), on top of phase5-kit:
// instances on the serverless build or the poll transport, the server's request log, network
// cuts per side, stopping the host the way the plan says, an in-page recorder of the sidebar's
// states, and the 60-item fake-agent fixture.
import { join } from "node:path";

import {
  addFakeAgent,
  agentOption,
  Browser,
  connectHost,
  HELLO,
  helloCli,
  Inconclusive,
  load,
  MacHost,
  makeHome,
  openAliceSidebar,
  postJson,
  processesWithHome,
  runAsync,
  runSync,
  scutilName,
  sleep,
  token,
  waitForAgents,
} from "./phase5-kit.mjs";

export * from "./phase5-kit.mjs";

/**
 * `$H up --seed {seed}` with `--serverless` (the vercel-preset build served with srvx) or a
 * dev instance; `env` reaches `parlor dev` (`PARLOR_SYNC_TRANSPORT=poll`). The variable is
 * removed from the inherited environment unless `env` sets it, so an SSE instance is SSE.
 */
export async function upInstance7(
  check,
  { name, seed = "baseline", serverless = false, env = {} },
) {
  const args = [HELLO, "up", "--seed", seed];
  if (serverless) args.push("--serverless");
  const childEnv = { ...process.env };
  delete childEnv.PARLOR_SYNC_TRANSPORT;
  Object.assign(childEnv, env);
  const { load1, cores } = load();
  check.log(
    `load ${load1} on ${cores} cores before starting ${name}${serverless ? " (serverless)" : ""}`,
  );
  const result = await runAsync(process.execPath, args, {
    timeout: 600_000,
    env: childEnv,
  });
  check.save(`${name}.up.log`, result.stderr);
  if (result.status !== 0) {
    if (/refusing to start/.test(result.stderr)) {
      throw new Inconclusive(
        `hello up refused to start: ${result.stderr.split("\n").find((l) => l.includes("refusing")) ?? result.stderr.slice(-500)}`,
      );
    }
    throw new Error(`hello up failed (${result.status})\n${result.stderr.slice(-2000)}`);
  }
  const info = JSON.parse(result.stdout);
  check.origins.add(info.urls.web);
  check.origins.add(`${info.urls.web}/`);
  check.onCleanup(async () => {
    const down = await runAsync(
      process.execPath,
      [HELLO, "down", info.id, "--save-log", join(check.dir, `${name}.dev.log`)],
      { timeout: 120_000 },
    );
    if (down.status !== 0)
      check.log(`down ${info.id} failed: ${down.stderr.slice(-500)}`);
  });
  return info;
}

/**
 * An instance with Alice signed in, her sidebar open and the Mac connected the way a user
 * connects it, with the fake agent as its only agent. Prints `verify: ready` unless
 * `announce` is false.
 */
export async function connectedSession7(
  check,
  { tag, script, seed, serverless, env, announce = true, beforeSignin },
) {
  const { home } = makeHome(check, tag);
  const info = await upInstance7(check, { name: tag, seed, serverless, env });
  const browser = new Browser(check, info);
  if (beforeSignin) {
    await browser.open("/sign-in");
    await beforeSignin(browser, info);
  }
  await browser.signin("alice");
  const open = await openAliceSidebar(check, browser);
  check.expect(`${tag}: Alice's sidebar opens`, open === true, open);
  const appTab = (await browser.pages()).find((page) => page.selected)?.id;
  const host = new MacHost(check, { home, info });
  const session = { home, info, browser, host, appTab };
  const fake = addFakeAgent(check, session, { script, log: true, tag });
  const connection = await connectHost(check, { ...session, label: `${tag}-connect` });
  const hostName = scutilName();
  const option = agentOption(fake, hostName);
  const listed = await waitForAgents(browser, [option]);
  check.expect(`${tag}: the picker lists ${option}`, listed.ok, listed.listed);
  if (!listed.ok)
    throw new Error(
      `${tag}: the picker never listed the fake agent; terminal:\n${connection.terminal.text.slice(-1200)}`,
    );
  const chosen = await browser.selectAgent(option);
  check.expect(`${tag}: the fake agent is picked`, chosen.includes(option), chosen);
  if (announce) check.ready();
  return { ...session, connection, hostName, fake, option };
}

/** The negotiated sync transport of an instance, as Alice's session sees it. */
export async function negotiatedTransport(info) {
  const session = await token(info);
  const response = await postJson(
    `${info.urls.web}/_parlor/sync/token`,
    {},
    {
      authorization: `Bearer ${session}`,
    },
  );
  return { status: response.status, body: response.json ?? response.text };
}

/** `$H requests {id} [--since {ms}]`: the server's request log, `{at, side, method, path, status}` each. */
export async function requests(info, { since } = {}) {
  const args = ["requests", info.id];
  if (since !== undefined) args.push("--since", String(Math.floor(since)));
  const result = await helloCli(args, { timeout: 60_000 });
  if (result.status !== 0)
    throw new Error(
      `requests ${info.id} failed (${result.status}): ${result.stderr.slice(-800)}`,
    );
  const text = result.stdout.trim();
  if (text.startsWith("[")) return JSON.parse(text);
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.at - b.at);
}

/** `$H netcut {id} browser|host --seconds {s}`: resolves at the restore with `{side, cutAt, restoredAt}`. */
export async function netcut(info, side, seconds) {
  const result = await helloCli(["netcut", info.id, side, "--seconds", String(seconds)], {
    timeout: (seconds + 60) * 1000,
  });
  if (result.status !== 0)
    throw new Error(
      `netcut ${side} failed (${result.status}): ${result.stderr.slice(-800)}`,
    );
  const line = result.stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop();
  return JSON.parse(line);
}

/** Polls `/sync?since=` only: not the token negotiation, not the SSE stream. */
export const isSyncPoll = (r) =>
  r.method === "GET" && /^\/_parlor\/sync\?/.test(r.path ?? "");

/**
 * Stops the host as the plan says: `kill -TERM` of the pid `lsof -t control.sock` reports, then
 * waits until that pid is gone. Returns `{pids, signalledAt, goneAt}`.
 */
export async function stopHost(host, { ms = 15_000 } = {}) {
  const out = runSync("lsof", ["-t", host.controlSocket]);
  const pids = out.stdout.split("\n").filter(Boolean).map(Number);
  if (pids.length === 0) throw new Error(`no process holds ${host.controlSocket}`);
  const signalledAt = Date.now();
  for (const pid of pids) runSync("kill", ["-TERM", String(pid)]);
  const deadline = signalledAt + ms;
  const alive = () =>
    pids.filter((pid) => runSync("kill", ["-0", String(pid)]).status === 0);
  while (alive().length && Date.now() < deadline) await sleep(100);
  const left = alive();
  return { pids, signalledAt, goneAt: left.length ? undefined : Date.now(), left };
}

export { processesWithHome };

/**
 * Installs (or resets) an in-page recorder on the sidebar: every change of `data-status` on
 * `ol[role=log]`, the first time each `li[data-item-id]` is in the DOM, every moment a
 * `li[data-streaming="true"]` exists, the composer status line `p.composer-status[role=status]`
 * with the status it shows next to, spinner-like elements without text, changes of the item
 * count, and the time of every mutation of the thread's content (meta lines left out). The
 * observer callback only takes the time and coalesces one sample per task, so a long thread
 * does not slow the page. Timestamps are `Date.now()` of the mutation.
 */
export const RECORDER = `() => {
  if (window.__p7obs) window.__p7obs.disconnect();
  const rec = { installedAt: Date.now(), status: [], items: {}, order: [], streaming: [], composer: [], spinners: [], counts: [], logMutations: [] };
  window.__p7 = rec;
  const sample = (at) => {
    const log = document.querySelector('ol[role=log]');
    const status = log ? (log.dataset.status ?? null) : null;
    const last = rec.status[rec.status.length - 1];
    if (!last || last.status !== status) rec.status.push({ at, status });
    const lis = log ? log.querySelectorAll(':scope > li') : [];
    for (const li of lis) {
      const id = li.dataset.itemId;
      if (id && !(id in rec.items)) { rec.items[id] = { at, kind: li.dataset.kind ?? null }; rec.order.push(id); }
    }
    const lastCount = rec.counts[rec.counts.length - 1];
    if (!lastCount || lastCount.n !== lis.length) rec.counts.push({ at, n: lis.length });
    const streaming = document.querySelectorAll('li[data-streaming="true"]').length;
    if (streaming && rec.streaming.length < 5000) rec.streaming.push({ at, n: streaming, status });
    const line = document.querySelector('p.composer-status[role=status]');
    const text = line ? line.textContent.trim() : null;
    const lastLine = rec.composer[rec.composer.length - 1];
    if (!lastLine || lastLine.text !== text || lastLine.status !== status) rec.composer.push({ at, status, text });
    const sidebar = document.querySelector('section.agent-sidebar');
    const spinners = [...(sidebar?.querySelectorAll('[aria-busy="true"], [role=progressbar], .spinner, [class*="spinner"]') ?? [])].filter((el) => !el.textContent.trim() && !el.getAttribute('aria-label'));
    if (spinners.length && rec.spinners.length < 500) rec.spinners.push({ at, status, html: spinners.map((el) => el.outerHTML.slice(0, 200)) });
  };
  const kindOf = (r) => {
    const node = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const log = node && node.closest('ol[role=log]');
    if (!log || node.closest('p.item-meta, time')) return null;
    if (r.type === 'characterData') return 'text';
    if (r.type === 'childList') return r.addedNodes.length ? 'add' : 'remove';
    return node === log ? null : 'attr';
  };
  let pending = 0;
  const observer = new MutationObserver((records) => {
    const at = Date.now();
    if (rec.logMutations.length < 100000) {
      const kinds = [...new Set(records.map(kindOf).filter(Boolean))];
      if (kinds.length) rec.logMutations.push([at, kinds.join('+')]);
    }
    if (pending) return;
    pending = at;
    setTimeout(() => { const first = pending; pending = 0; sample(first); }, 0);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__p7obs = observer;
  sample(rec.installedAt);
  return rec.installedAt;
}`;

/** The recorder's state, with the content mutations summed up instead of listed. */
export const READ_RECORDER = `() => {
  const rec = window.__p7;
  if (!rec) return null;
  const m = rec.logMutations;
  return { ...rec, logMutations: { count: m.length, first: m[0] ?? null, last: m[m.length - 1] ?? null } };
}`;

export const recordStates = (browser) => browser.eval(RECORDER);
export const readStates = (browser) => browser.eval(READ_RECORDER);

/**
 * The first content mutation of the thread at or after `since` that adds content (`add`: a node,
 * `text`: text changed), `{at, kinds}` or null, with every content mutation of the next `windowMs`
 * as evidence; undefined when no recorder runs (the page reloaded).
 */
export const firstLogMutation = (browser, since, windowMs = 3000) =>
  browser.eval(`() => {
    const rec = window.__p7;
    if (!rec) return undefined;
    const from = ${Math.floor(since)};
    const near = rec.logMutations.filter(([at]) => at >= from && at <= from + ${windowMs}).map(([at, kinds]) => ({ at, kinds }));
    const first = rec.logMutations.find(([at, kinds]) => at >= from && /add|text/.test(kinds));
    return { first: first ? { at: first[0], kinds: first[1] } : null, near };
  }`);

/** The first recorded `status` at or after `since`, `{at, status}`. */
export function firstStatus(rec, status, since = 0) {
  return rec?.status.find((s) => s.status === status && s.at >= since);
}

/**
 * Spans of at least `minMs` in which the sidebar showed an active state (`sending`, `running`,
 * `waiting`) with an empty composer status line, or any spinner-like element without text:
 * the "spinner without text" the plan rules out.
 */
export function silentSpans(rec, { until = Date.now(), minMs = 200 } = {}) {
  const active = new Set(["sending", "running", "waiting"]);
  const spans = [];
  const lines = rec?.composer ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const end = lines[i + 1]?.at ?? until;
    if (active.has(line.status) && !line.text && end - line.at >= minMs)
      spans.push({
        status: line.status,
        text: line.text,
        from: line.at,
        ms: end - line.at,
      });
  }
  return { spans, spinners: rec?.spinners ?? [] };
}

/** The newest thread as Alice's devices read it (`open`, up to 500 items). */
export async function openNewest(info, { threadId, limit = 500 } = {}) {
  const session = await token(info);
  const response = await postJson(
    `${info.urls.web}/_parlor/chat/actions/open`,
    threadId ? { threadId, limit } : { limit },
    { authorization: `Bearer ${session}` },
  );
  return { status: response.status, data: response.json?.data, raw: response.json };
}

/** `listTasks` over HTTP as Alice: the second view of a task the agent created. */
export async function listTasks(info) {
  const session = await token(info);
  const response = await postJson(
    `${info.urls.web}/_parlor/actions/listTasks`,
    {},
    {
      authorization: `Bearer ${session}`,
    },
  );
  return { status: response.status, tasks: response.json?.data ?? response.json };
}

/**
 * Fills the composer and clicks Send; `clickAt` is taken just before the click, so a state the
 * click causes is never older than it. Returns `{clickAt, sentAt}` (`sentAt`: the click returned).
 */
export async function sendTimed(browser, text) {
  await browser.fill("textbox", "Message", text);
  const clickAt = Date.now();
  await browser.click("button", "Send");
  return { clickAt, sentAt: Date.now() };
}

/** `sendTimed`, recording a send that the page refuses (a disabled button) instead of throwing. */
export async function trySend(browser, text) {
  const startedAt = Date.now();
  try {
    return await sendTimed(browser, text);
  } catch (error) {
    return {
      error: String(error?.message ?? error).slice(0, 1500),
      startedAt,
      at: Date.now(),
    };
  }
}

export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The P7 fixture: `count` items alternating a thought (a reasoning item) and a paced reply,
 * so no two merge, each carrying its own token (`P7T07`, `P7R08`) for the item-by-item
 * comparison. Returns the steps and the expected items in order.
 */
export function alternatingItems(count, { chunks = 3, perSecond = 1 } = {}) {
  const steps = [];
  const expected = [];
  for (let n = 1; n <= count; n++) {
    const nn = String(n).padStart(2, "0");
    if (n % 2 === 1) {
      const mark = `P7T${nn}`;
      steps.push({ kind: "thought", text: `${mark} weighing step ${nn}` });
      expected.push({ n, token: mark, kind: "reasoning" });
    } else {
      const mark = `P7R${nn}`;
      const parts = Array.from({ length: chunks }, (_, i) =>
        i === 0 ? `${mark} part ${i + 1}` : ` part ${i + 1}`,
      );
      steps.push({ kind: "reply", chunks: parts, perSecond });
      expected.push({ n, token: mark, kind: "reply" });
    }
  }
  steps.push({ kind: "stop", reason: "end_turn" });
  return { steps, expected };
}
