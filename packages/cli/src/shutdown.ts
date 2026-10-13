type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];
let installed = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  process.kill(process.pid, signal);
}

export function onShutdown(cleanup: Cleanup): void {
  cleanups.push(cleanup);
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
