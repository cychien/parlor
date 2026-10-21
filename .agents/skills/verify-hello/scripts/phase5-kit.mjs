// Shared code of the phase 5 check scripts (device trust and presence), on top of phase4-kit:
// WebAuthn presence per browser profile, store writes, the host's osascript dialogs and the
// thread over HTTP.
import { join } from "node:path";

import {
  Browser,
  commandOf,
  helloCli,
  postJson,
  processesWithHome,
  runAsync,
  runSync,
  sleep,
  token,
} from "./phase4-kit.mjs";

export * from "./phase4-kit.mjs";

export async function waitFor(probe, ms, every = 250) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(every);
  }
  return (await probe()) || undefined;
}

function profileEnv(profile) {
  const env = { ...process.env };
  delete env.HELLO_BROWSER_PROFILE;
  if (profile) env.HELLO_BROWSER_PROFILE = profile;
  return env;
}

/** `$H browser {id} presence on|off` for the default browser or a profile's. */
export async function presence(check, info, mode, { profile, label = "presence" } = {}) {
  const result = await helloCli(["browser", info.id, "presence", mode], {
    env: profileEnv(profile),
    timeout: 60_000,
  });
  const name = `${label}.${profile ?? "default"}.${mode}`;
  check.save(`${name}.json`, result.stdout || result.stderr);
  if (result.status !== 0)
    throw new Error(
      `presence ${mode} for ${profile ?? "default"} failed: ${result.stderr}`,
    );
  check.log(`presence ${mode} on ${profile ?? "default"}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

/** The `beforeSignin` hook that turns presence on before any page of the browser can enroll. */
export const presenceFirst = (check) => (_browser, info) => presence(check, info, "on");

/** A second Chrome with its own profile, presence on before it signs in as `user`. */
export async function profileBrowser(check, info, profile, user) {
  const browser = new Browser(check, info, { profile });
  await browser.open("/sign-in");
  await presence(check, info, "on", { profile });
  await browser.signin(user);
  return browser;
}

/** `$H sql {id} --write "{statement}"`: one read-write transaction; `{affectedRows, rows}`. */
export async function sqlWrite(check, info, statement) {
  const result = await helloCli(["sql", info.id, "--write", statement], {
    timeout: 240_000,
  });
  if (result.status !== 0)
    throw new Error(`sql --write failed: ${result.stderr.slice(-800)}`);
  return JSON.parse(result.stdout);
}

/** The newest page of a thread (or the newest thread) as the user's devices read it. */
export async function openThread(info, { threadId, user = "alice" } = {}) {
  const session = await token(info, "session", user);
  const response = await postJson(
    `${info.urls.server}/_parlor/chat/actions/open`,
    threadId ? { threadId } : {},
    { authorization: `Bearer ${session}` },
  );
  return { status: response.status, data: response.json?.data, raw: response.json };
}

export function threadItems(open) {
  return open?.data?.page?.items ?? [];
}

export function hostEvents(host, name, since = 0) {
  return host.logEvents().filter((e) => e.event === name && (e.at ?? 0) >= since);
}

/** This home's fake agent processes (`fake-agent.mjs`, the fixture's entry). */
export function fakeAgentPids(host) {
  return processesWithHome(host.home)
    .filter((p) => /fake-agent\.mjs/.test(commandOf(p.line)))
    .map((p) => p.pid)
    .sort((a, b) => a - b);
}

export function pgrepFakeAgent() {
  return runSync("pgrep", ["-fl", "fake-agent.mjs"]).stdout;
}

/** Every `osascript` process the host of `home` started (its environment or its ancestry). */
export function dialogProcesses(home) {
  const table = runSync("ps", ["-axo", "pid=,ppid=,command="])
    .stdout.split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const parents = new Map(table.map((p) => [p.pid, p.ppid]));
  const mine = new Set(processesWithHome(home).map((p) => p.pid));
  const descends = (pid) => {
    for (let at = pid, hops = 0; at > 1 && hops < 32; at = parents.get(at), hops++) {
      if (mine.has(at)) return true;
    }
    return false;
  };
  return table.filter(
    (p) =>
      /(^|\/)osascript(\s|$)/.test(p.command) && p.pid !== process.pid && descends(p.pid),
  );
}

// A whose-specifier is kept as is: indexing it resolves the process by name, and every
// dialog's process is named osascript.
const READ_DIALOG = `function run(argv) {
  const proc = Application("System Events").processes.whose({ unixId: Number(argv[0]) });
  const safe = (f) => { try { return f()[0]; } catch (e) { return undefined; } };
  const count = safe(() => proc.windows().map((w) => w.length));
  if (!count) return JSON.stringify(null);
  const w = proc.windows[0];
  return JSON.stringify({
    windows: count,
    title: safe(() => w.name()),
    texts: safe(() => w.staticTexts.value()) ?? [],
    buttons: safe(() => w.buttons.name()) ?? [],
  });
}`;

const CLICK_DIALOG = `function run(argv) {
  const proc = Application("System Events").processes.whose({ unixId: Number(argv[0]) });
  proc.windows[0].buttons.byName(argv[1]).click();
  return "clicked";
}`;

const WINDOW_OF = `ObjC.import("CoreGraphics");
function run(argv) {
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
  const match = all.filter((w) => w.kCGWindowOwnerPID === Number(argv[0]) && w.kCGWindowIsOnscreen)[0];
  return match ? String(match.kCGWindowNumber) : "";
}`;

/** The dialog an `osascript` process shows: title, message texts and button labels. */
export async function readDialog(pid) {
  const result = await runAsync(
    "osascript",
    ["-l", "JavaScript", "-e", READ_DIALOG, String(pid)],
    {
      timeout: 15_000,
    },
  );
  try {
    const dialog = JSON.parse(result.stdout.trim());
    if (!dialog || !dialog.windows) return undefined;
    const message = (dialog.texts ?? []).filter((t) => t && t !== dialog.title);
    return { pid, ...dialog, message: message.join("\n") };
  } catch {
    return undefined;
  }
}

export async function clickDialog(pid, label) {
  const result = await runAsync(
    "osascript",
    ["-l", "JavaScript", "-e", CLICK_DIALOG, String(pid), label],
    {
      timeout: 15_000,
    },
  );
  if (result.status !== 0)
    throw new Error(`clicking "${label}" in dialog ${pid} failed: ${result.stderr}`);
  return Date.now();
}

export async function screenshotDialog(check, pid, name) {
  const id = (
    await runAsync("osascript", ["-l", "JavaScript", "-e", WINDOW_OF, String(pid)], {
      timeout: 15_000,
    })
  ).stdout.trim();
  if (!id) return undefined;
  const file = join(check.dir, name);
  await runAsync("screencapture", ["-x", "-o", `-l${id}`, file], { timeout: 15_000 });
  return file;
}

/** Waits for a `Parlor Host` dialog of this host that satisfies `accept(dialog)`. */
export async function waitDialog(host, accept, ms) {
  return waitFor(
    async () => {
      for (const p of dialogProcesses(host.home)) {
        const dialog = await readDialog(p.pid);
        if (dialog && dialog.title === "Parlor Host" && accept(dialog)) return dialog;
      }
      return undefined;
    },
    ms,
    300,
  );
}

/** Records every dialog this host shows until `stop()`; each with when it was first seen. */
export function watchDialogs(host) {
  const seen = new Map();
  const stopped = new AbortController();
  const loop = (async () => {
    while (!stopped.signal.aborted) {
      for (const p of dialogProcesses(host.home)) {
        if (seen.has(p.pid)) continue;
        const dialog = await readDialog(p.pid);
        if (dialog) seen.set(p.pid, { at: Date.now(), ...dialog });
      }
      await sleep(300);
    }
  })();
  return {
    seen: () => [...seen.values()],
    async stop() {
      stopped.abort();
      await loop;
      return [...seen.values()];
    },
  };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `{deviceName} ({platform}) wants to use agents on {hostName} for {appName} as {email}.` */
export function deviceApproval(dialog, hostName, email) {
  const pattern = new RegExp(
    `^(.+) \\((.+)\\) wants to use agents on ${escapeRegExp(hostName)} for (.+) as ${escapeRegExp(email)}\\.$`,
  );
  for (const text of dialog?.texts ?? []) {
    const match = text.trim().match(pattern);
    if (match)
      return { deviceName: match[1], platform: match[2], appName: match[3], text };
  }
  return undefined;
}

/**
 * Waits for this host's device approval dialog naming `email`, saves its text and a screenshot
 * as `{label}.dialog.*`, and presses `answer` (`Allow` or `Don't allow`).
 */
export async function answerDeviceDialog(
  check,
  host,
  { hostName, email = "alice@example.com", answer = "Allow", label, ms = 60_000 },
) {
  const dialog = await waitDialog(
    host,
    (d) => Boolean(deviceApproval(d, hostName, email)),
    ms,
  );
  if (!dialog) return undefined;
  const approval = deviceApproval(dialog, hostName, email);
  await screenshotDialog(check, dialog.pid, `${label}.dialog.png`);
  check.save(`${label}.dialog.json`, { ...dialog, approval });
  const answeredAt = await clickDialog(dialog.pid, answer);
  return { ...dialog, approval, answeredAt };
}

/**
 * Sends `text` from the browser and waits for the turn to settle, allowing this device in the
 * host's approval dialog when one appears (a device's first prompt). Returns the dialog seen.
 */
export async function sendApproving(
  check,
  session,
  text,
  { prompts, ms = 90_000, label, email = "alice@example.com", browser = session.browser },
) {
  const sentAt = await browser.send(text);
  let dialog;
  let pending = false;
  const settled = await browser.waitSettled({
    prompts,
    ms,
    label,
    onPoll: async () => {
      if (dialog || pending) return;
      const found = (
        await Promise.all(
          dialogProcesses(session.host.home).map((p) => readDialog(p.pid)),
        )
      ).find((d) => d && deviceApproval(d, session.hostName, email));
      if (!found) return;
      pending = true;
      await screenshotDialog(check, found.pid, `${label}.dialog.png`);
      const approval = deviceApproval(found, session.hostName, email);
      check.save(`${label}.dialog.json`, { ...found, approval });
      dialog = { ...found, approval, answeredAt: await clickDialog(found.pid, "Allow") };
    },
  });
  return { sentAt, settled, dialog };
}
