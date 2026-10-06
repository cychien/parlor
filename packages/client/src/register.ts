import type { ActionMap } from "@parlor/core";

export interface Register {}

export type RegisteredActions = Register extends { actions: infer A extends ActionMap }
  ? A
  : ActionMap;
