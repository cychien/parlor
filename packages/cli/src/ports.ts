import { createServer } from "node:net";

import { CliError } from "./errors.js";

// The server binds every interface and Vite binds `localhost`, so a holder on any of these takes the port.
const HOSTS = ["0.0.0.0", "::", "127.0.0.1", "::1"] as const;
const NO_SUCH_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);
const ATTEMPTS = 100;

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(NO_SUCH_ADDRESS.has(error.code ?? "")),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  for (const host of HOSTS) {
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

export async function firstFreePort(
  from: number,
  taken: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = from; port < from + ATTEMPTS && port <= 65_535; port += 1) {
    if (!taken.has(port) && (await isPortFree(port))) return port;
  }
  throw new CliError(`No free port from ${from} to ${from + ATTEMPTS - 1}.`);
}

export interface DevPorts {
  readonly server: number;
  readonly web: number;
}

/** Moves each busy port to the next free one, saying so, as Vite and Next.js do. */
export async function resolveDevPorts(
  wanted: DevPorts,
  log: (line: string) => void = console.log,
): Promise<DevPorts> {
  const server = await firstFreePort(wanted.server);
  const web = await firstFreePort(wanted.web, new Set([server]));
  if (server !== wanted.server) {
    log(`Port ${wanted.server} is in use, so the server uses ${server}.`);
  }
  if (web !== wanted.web) log(`Port ${wanted.web} is in use, so the page uses ${web}.`);
  return { server, web };
}
