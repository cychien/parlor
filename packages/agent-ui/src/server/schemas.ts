import { z } from "zod";

import type { ClientMessage } from "../protocol.js";

export const uiOpInputs = {
  screen: z.object({}),
};

export function parseClientMessage(body: unknown): ClientMessage | undefined {
  void body;
  throw new Error("not implemented");
}
