// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActionClient } from "../action-client.js";
import type { SessionSource } from "../session.js";
import { FrameworkProvider, useSession } from "./provider.js";

function Status() {
  return <p>{useSession().status}</p>;
}

describe("FrameworkProvider on the server", () => {
  it("renders the session as loading, as hydration first renders it, without asking the auth client", () => {
    const auth: SessionSource = {
      current: () => {
        throw new Error("the auth client is not usable on the server");
      },
      subscribe: () => () => {},
    };
    const client = { clientId: "server", basePath: "/_parlor" } as ActionClient<
      Record<string, never>
    >;
    expect(
      renderToString(
        <FrameworkProvider client={client} auth={auth} sync={false}>
          <Status />
        </FrameworkProvider>,
      ),
    ).toBe("<p>loading</p>");
  });
});
