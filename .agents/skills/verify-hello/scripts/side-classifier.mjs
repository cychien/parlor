// Tells which side of an instance a loopback connection comes from by the process that owns its
// client end. The lookups spawn netstat and ps, so they run in a worker thread: spawning blocks
// the thread that does it, and the forwarder's own thread must stay on the data path.
//   browser: the process or one of its ancestors runs with `--remote-debugging-port=` (the
//            session's Chrome, whose network service holds the sockets)
//   host:    the process's environment has an isolated `HOME=<hostHomes>/...`, as a real
//            `parlor-host` run by the harness has
//   other:   anything else, such as the harness's own probes
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const run = promisify(execFile);
const PROCESS_CACHE_MS = 5000;
const MAX_ANCESTORS = 8;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pid that owns the client end of the loopback connection `srcPort -> publicPort`. */
async function clientPid(srcPort, publicPort) {
  const { stdout } = await run("netstat", ["-anv", "-p", "tcp"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const row of stdout.split("\n")) {
    if (!row.includes(`.${srcPort} `)) continue;
    const columns = row.trim().split(/\s+/);
    if (!columns[3]?.endsWith(`.${srcPort}`) || !columns[4]?.endsWith(`.${publicPort}`))
      continue;
    const owner = row.match(/\s(.+?):(\d+)\s+[0-9a-f]{5}\s+[0-9a-f]{8}\s+[0-9a-f]{16}\s/);
    if (owner) return Number(owner[2]);
  }
  return undefined;
}

async function describePid(pid) {
  const { stdout } = await run(
    "ps",
    ["-E", "-ww", "-o", "ppid=,command=", "-p", String(pid)],
    { env: { ...process.env, COLUMNS: "100000" }, maxBuffer: 16 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  const match = stdout.trim().match(/^(\d+)\s+(.*)$/s);
  return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
}

function createLookup(hostHomes) {
  const hostHome = new RegExp(`(^|\\s)HOME=(${hostHomes.map(escapeRegExp).join("|")})/`);
  const cache = new Map();

  async function classify(pid) {
    let at = pid;
    for (let hops = 0; at > 1 && hops < MAX_ANCESTORS; hops += 1) {
      const info = await describePid(at);
      if (!info) return "other";
      if (/--remote-debugging-port=/.test(info.command)) return "browser";
      if (hops === 0 && hostHome.test(info.command)) return "host";
      at = info.ppid;
    }
    return "other";
  }

  return async function sideOf(srcPort, publicPort) {
    const pid = await clientPid(srcPort, publicPort).catch(() => undefined);
    if (pid === undefined) return "other";
    const cached = cache.get(pid);
    if (cached && Date.now() - cached.at < PROCESS_CACHE_MS) return cached.side;
    const side = await classify(pid);
    cache.set(pid, { side, at: Date.now() });
    return side;
  };
}

if (!isMainThread) {
  const sideOf = createLookup(workerData.hostHomes);
  parentPort.on("message", async ({ id, srcPort, publicPort }) => {
    parentPort.postMessage({
      id,
      side: await sideOf(srcPort, publicPort).catch(() => "other"),
    });
  });
}

export function createSideClassifier({ hostHomes }) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { hostHomes } });
  const waiting = new Map();
  let sequence = 0;
  worker.on("message", ({ id, side }) => {
    waiting.get(id)?.(side);
    waiting.delete(id);
  });
  worker.on("error", () => {
    for (const settle of waiting.values()) settle("other");
    waiting.clear();
  });
  worker.unref();
  return {
    sideOf(srcPort, publicPort) {
      return new Promise((settle) => {
        sequence += 1;
        waiting.set(sequence, settle);
        worker.postMessage({ id: sequence, srcPort, publicPort });
      });
    },
    close: () => worker.terminate(),
  };
}
