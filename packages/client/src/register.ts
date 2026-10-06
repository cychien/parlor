import type { ActionMap } from "@fw/core";

export interface Register {}

export type RegisteredActions = Register extends { actions: infer A extends ActionMap }
  ? A
  : ActionMap;
