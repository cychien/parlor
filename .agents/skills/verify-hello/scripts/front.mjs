#!/usr/bin/env node
// The root process of a web instance: runs the instance's server command (`parlor dev`, or srvx
// serving a serverless build) and puts the forwarder of netproxy.mjs on the public port in front of
// the port that command listens on. One process group, so `stop` takes both. Started by hello.mjs
// `start`; not meant to be run by hand.
//   front.mjs --port P --backend B [--backend-host H] --requests FILE --control SOCK --host-homes A,B -- CMD ARGS...
import { spawn } from "node:child_process";
import net from "node:net";
import { parseArgs } from "node:util";

import { startForwarder } from "./netproxy.mjs";

const split = process.argv.indexOf("--", 2);
const { values } = parseArgs({
  args: process.argv.slice(2, split === -1 ? undefined : split),
  options: {
    port: { type: "string" },
    backend: { type: "string" },
    "backend-host": { type: "string", default: "localhost" },
    requests: { type: "string" },
    control: { type: "string" },
    "host-homes": { type: "string" },
  },
});
const [command, ...commandArgs] = split === -1 ? [] : process.argv.slice(split + 1);
const port = Number(values.port);
const backendPort = Number(values.backend);
const BACKEND_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 8000;

const child = spawn(command, commandArgs, { stdio: "inherit", env: process.env });

let closeForwarder;
let stopping = false;

async function stop(code) {
  if (stopping) return;
  stopping = true;
  await closeForwarder?.();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(killer);
  }
  process.exit(code);
}

child.on("exit", (code, signal) => {
  if (stopping) return;
  console.error(`front: ${command} exited (${signal ?? code})`);
  void stop(1);
});
for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => void stop(0));

function listening() {
  return new Promise((resolve) => {
    const socket = net.connect({ port: backendPort, host: values["backend-host"] });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const deadline = Date.now() + BACKEND_TIMEOUT_MS;
while (!stopping && !(await listening())) {
  if (Date.now() > deadline) {
    console.error(`front: nothing listened on ${backendPort}`);
    await stop(1);
  }
  await new Promise((done) => setTimeout(done, 200));
}

if (!stopping) {
  closeForwarder = await startForwarder({
    port,
    backendPort,
    backendHost: values["backend-host"],
    requestLog: values.requests,
    controlPath: values.control,
    hostHomes: values["host-homes"].split(",").filter(Boolean),
    announce: (message) => console.log(`front: ${message}`),
  });
}
