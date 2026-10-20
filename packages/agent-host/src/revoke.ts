import type { AssertionRequest } from "./assertion.js";

export const REVOKE_PATH = "/_parlor/auth/hosts/revoke";

const alreadyRevoked = (response: Response) => response.status === 401;

export interface RevokeInput {
  readonly appOrigin: string;
  readonly appName: string;
  readonly assert: (request: AssertionRequest) => Promise<string>;
  readonly fetch?: typeof fetch | undefined;
}

export async function revokeGrant(input: RevokeInput): Promise<void> {
  const url = `${input.appOrigin}${REVOKE_PATH}`;
  const authorization = `ParlorHost ${await input.assert({ method: "POST", url })}`;
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    throw new Error(
      `${input.appName} could not be reached to disconnect this computer.`,
      {
        cause: error,
      },
    );
  }
  if (!response.ok && !alreadyRevoked(response)) {
    throw new Error(
      `${input.appName} did not disconnect this computer: it answered HTTP ${response.status}.`,
    );
  }
}
