import { setTimeout as sleep } from "node:timers/promises";

import { DEV_AUTH_PLUGIN, DEV_HOST_PATH } from "@parlor/server";

const RETRY_MS = 250;
const RETRY_MAX_MS = 2_000;

export class NoDevAuth extends Error {
  override readonly name = "NoDevAuth";
}

export async function requestDevHostToken(
  serverOrigin: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${serverOrigin}/_parlor/${DEV_AUTH_PLUGIN}${DEV_HOST_PATH}`;
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(url, { method: "POST", ...(signal ? { signal } : {}) });
    } catch {
      response = undefined;
    }
    if (response?.ok) return ((await response.json()) as { token: string }).token;
    if (response?.status === 404)
      throw new NoDevAuth(`${serverOrigin} uses its own sign-in.`);
    if (response && response.status !== 502 && response.status !== 503) {
      throw new Error(`${url} answered HTTP ${response.status}.`);
    }
    await sleep(Math.min(RETRY_MS * 2 ** attempt, RETRY_MAX_MS), undefined, { signal });
  }
}
