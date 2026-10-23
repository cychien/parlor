/** `signaled` is false when the CLI stops on its own error, so no signal reached its children. */
type Cleanup = (signaled: boolean) => void | Promise<void>;

const cleanups: Cleanup[] = [];
let installed = false;

async function runCleanups(signaled: boolean): Promise<void> {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup(signaled)));
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  await runCleanups(true);
  process.kill(process.pid, signal);
}

export function shutdownAfterError(): Promise<void> {
  return runCleanups(false);
}

export function onShutdown(cleanup: Cleanup): void {
  cleanups.push(cleanup);
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}
