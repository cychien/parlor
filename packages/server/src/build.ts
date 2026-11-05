let build: string | undefined;

/**
 * Which build of the app answers: the one `parlor build` stamps into `PARLOR_BUILD_ID`, else
 * one per process, as a dev server restarts with new code. Read on first use, since a Worker
 * may not draw random numbers while its modules load.
 */
export function serverBuild(): string {
  build ??= process.env.PARLOR_BUILD_ID || crypto.randomUUID();
  return build;
}
