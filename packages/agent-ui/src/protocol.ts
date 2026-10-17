import type { ActionSource } from "@parlor/core";

import type { ViewRef } from "./view.js";

export const UI_CHANNEL = "ui";

export interface UiOpInputs {
  readonly screen: Readonly<Record<string, never>>;
  readonly navigate: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>> | undefined;
    readonly search?: Readonly<Record<string, unknown>> | undefined;
    readonly replace?: boolean | undefined;
  };
}

export type UiOp = keyof UiOpInputs;

export const uiOpReadOnly: { readonly [O in UiOp]: boolean } = {
  screen: true,
  navigate: false,
};
export type UiOpInput<O extends UiOp> = UiOpInputs[O];

export interface UiOpResults {
  readonly screen: ScreenSnapshot;
  readonly navigate: { readonly screen: ScreenSnapshot };
}

export interface AgentOrigin {
  readonly via: Extract<ActionSource, "mcp" | "agent">;
  readonly name?: string | undefined;
}

export type UiRequest = {
  readonly [O in UiOp]: {
    readonly id: string;
    readonly op: O;
    readonly input: UiOpInput<O>;
    readonly origin: AgentOrigin;
    readonly timeoutMs: number;
  };
}[UiOp];

export type UiErrorCode =
  | "unknown_route"
  | "unknown_client"
  | "ambiguous_client"
  | "busy"
  | "timeout"
  | "outcome_unknown"
  | "internal";

export interface UiError {
  readonly code: UiErrorCode;
  readonly message: string;
  readonly issues?:
    | readonly { readonly path: string; readonly message: string }[]
    | undefined;
}

export type UiReply =
  | {
      readonly type: "reply";
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: "reply";
      readonly id: string;
      readonly ok: false;
      readonly error: UiError;
    };

export interface PresenceUpdate {
  readonly type: "presence";
  readonly focused: boolean;
  readonly visible: boolean;
  readonly platform: string;
  readonly buildId?: string | undefined;
}

export interface LeaveNotice {
  readonly type: "leave";
}

export type ClientMessage = UiReply | PresenceUpdate | LeaveNotice;

export type JsonObject = { readonly [key: string]: unknown };

export interface TruncatedValue {
  readonly truncated: true;
  readonly bytes: number;
}

export interface MatchedRouteSnapshot {
  readonly notFound: false;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly search: JsonObject;
  readonly url: string;
}

export interface NotFoundRouteSnapshot {
  readonly notFound: true;
  readonly url: string;
}

export type RouteSnapshot = MatchedRouteSnapshot | NotFoundRouteSnapshot;

export type QueryStatus = "pending" | "error" | "success";

export interface QuerySnapshot {
  readonly action: string;
  readonly input: unknown;
  readonly status: QueryStatus;
}

export interface SingleViewSnapshot {
  readonly value: JsonObject | TruncatedValue;
  readonly shown?: number | undefined;
}

export interface ItemSnapshot {
  readonly key: string;
  readonly value: JsonObject | TruncatedValue;
  readonly shown: number;
}

export interface KeyedViewSnapshot {
  readonly items: readonly ItemSnapshot[];
  readonly offscreen: number;
}

export type ViewSnapshot = SingleViewSnapshot | KeyedViewSnapshot;

export interface RecentRef extends ViewRef {
  readonly agoMs: number;
}

export interface FocusSnapshot {
  readonly view?: string | undefined;
  readonly key?: string | undefined;
  readonly field?: string | undefined;
  readonly label?: string | undefined;
}

export interface SelectionSnapshot {
  readonly text: string;
  readonly within: ViewRef;
  readonly truncated: boolean;
}

export interface AttentionSnapshot {
  readonly focus: FocusSnapshot | null;
  readonly selection: SelectionSnapshot | null;
  readonly lastInteracted: RecentRef | null;
  readonly lastEntered: RecentRef | null;
  readonly focal: ViewRef | null;
}

export interface ScreenSnapshot {
  readonly route: RouteSnapshot | null;
  readonly queries: readonly QuerySnapshot[];
  readonly views: Readonly<Record<string, ViewSnapshot>>;
  readonly attention: AttentionSnapshot;
  readonly truncated: boolean;
}

export interface ClientSummary {
  readonly id: string;
  readonly platform: string;
  readonly buildId?: string | undefined;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly seenAgoMs: number;
}

export type ParsedUiRequest =
  | { readonly ok: true; readonly request: UiRequest }
  | { readonly ok: false; readonly id: string | undefined };

type Fields = { readonly [key: string]: unknown };

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const absentOr = <T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): value is T | undefined => value === undefined || guard(value);

function originOf(value: unknown): AgentOrigin | undefined {
  if (!isFields(value)) return undefined;
  const { via, name } = value;
  if (via !== "mcp" && via !== "agent") return undefined;
  if (!absentOr(name, isString)) return undefined;
  return name === undefined ? { via } : { via, name };
}

function navigateInputOf(value: unknown): UiOpInput<"navigate"> | undefined {
  void value;
  throw new Error("not implemented");
}

function requestOf(json: unknown): UiRequest | undefined {
  if (!isFields(json)) return undefined;
  const { id, op, input, timeoutMs } = json;
  const origin = originOf(json.origin);
  if (!isString(id) || id === "" || !origin || !isPositiveInteger(timeoutMs)) {
    return undefined;
  }
  const envelope = { id, origin, timeoutMs };
  switch (op) {
    case "screen":
      return isFields(input) ? { ...envelope, op, input: {} } : undefined;
    case "navigate": {
      const navigate = navigateInputOf(input);
      return navigate ? { ...envelope, op, input: navigate } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseUiRequest(data: string): ParsedUiRequest {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, id: undefined };
  }
  const request = requestOf(json);
  if (request) return { ok: true, request };
  const id = isFields(json) ? json.id : undefined;
  return { ok: false, id: isString(id) && id !== "" ? id : undefined };
}
