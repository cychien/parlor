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
  readonly set: {
    readonly view: string;
    readonly key?: string | undefined;
    readonly value: JsonObject;
  };
  readonly highlight: {
    readonly view: string;
    readonly key?: string | undefined;
    readonly field?: string | undefined;
  };
}

export type UiOp = keyof UiOpInputs;

export type UiOpInput<O extends UiOp> = UiOpInputs[O];

export interface UiOpResults {
  readonly screen: ScreenSnapshot;
  readonly navigate: { readonly screen: ScreenSnapshot };
  readonly set: { readonly value: JsonObject; readonly agentFields: readonly string[] };
  readonly highlight: { readonly shown: number };
}

interface UiOpSpec<O extends UiOp> {
  readonly readOnly: boolean;
  readonly input: (value: unknown) => UiOpInput<O> | undefined;
}

export const uiOps: { readonly [O in UiOp]: UiOpSpec<O> } = {
  screen: { readOnly: true, input: (value) => (isFields(value) ? {} : undefined) },
  navigate: { readOnly: false, input: (value) => navigateInputOf(value) },
  set: { readOnly: false, input: (value) => setInputOf(value) },
  highlight: { readOnly: false, input: (value) => highlightInputOf(value) },
};

export const UI_OPS = Object.keys(uiOps) as readonly UiOp[];

export const isUiOp = (value: unknown): value is UiOp =>
  typeof value === "string" && Object.hasOwn(uiOps, value);

export const LEGACY_UI_OPS: readonly UiOp[] = ["screen", "navigate"];

export const uiOpReadOnly: { readonly [O in UiOp]: boolean } = {
  screen: uiOps.screen.readOnly,
  navigate: uiOps.navigate.readOnly,
  set: uiOps.set.readOnly,
  highlight: uiOps.highlight.readOnly,
};

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

export const UI_ERROR_CODES = [
  "unknown_route",
  "unknown_client",
  "ambiguous_client",
  "not_mounted",
  "not_writable",
  "invalid_value",
  "user_editing",
  "unsupported_op",
  "busy",
  "timeout",
  "outcome_unknown",
  "internal",
] as const;

export type UiErrorCode = (typeof UI_ERROR_CODES)[number];

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
  readonly ops?: readonly string[] | undefined;
  readonly canConfirm?: boolean | undefined;
}

export interface LeaveNotice {
  readonly type: "leave";
}

export interface ConfirmationAnswer {
  readonly type: "answer";
  readonly id: string;
  readonly approve: boolean;
}

export type ClientMessage = UiReply | PresenceUpdate | LeaveNotice | ConfirmationAnswer;

export interface ConfirmationPrompt {
  readonly id: string;
  readonly action: string;
  readonly description: string;
  readonly input: unknown;
  readonly origin: AgentOrigin;
  readonly expiresInMs: number;
}

export interface ConfirmationsFrame {
  readonly type: "confirmations";
  readonly items: readonly ConfirmationPrompt[];
}

export type UiFrame = UiRequest | ConfirmationsFrame;

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

export type ParsedUiFrame =
  | { readonly ok: true; readonly frame: UiFrame }
  | { readonly ok: false; readonly id: string | undefined };

type Fields = { readonly [key: string]: unknown };

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isStringFields = (value: unknown): value is Readonly<Record<string, string>> =>
  isFields(value) && Object.values(value).every(isString);

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
  if (!isFields(value) || !isString(value.to)) return undefined;
  const { to, params, search, replace } = value;
  if (
    !absentOr(params, isStringFields) ||
    !absentOr(search, isFields) ||
    !absentOr(replace, isBoolean)
  ) {
    return undefined;
  }
  return {
    to,
    ...(params === undefined ? {} : { params }),
    ...(search === undefined ? {} : { search }),
    ...(replace === undefined ? {} : { replace }),
  };
}

function setInputOf(value: unknown): UiOpInput<"set"> | undefined {
  if (!isFields(value) || !isString(value.view) || !isFields(value.value)) {
    return undefined;
  }
  if (!absentOr(value.key, isString)) return undefined;
  const { view, key } = value;
  return key === undefined
    ? { view, value: value.value }
    : { view, key, value: value.value };
}

function highlightInputOf(value: unknown): UiOpInput<"highlight"> | undefined {
  if (!isFields(value) || !isString(value.view)) return undefined;
  if (!absentOr(value.key, isString) || !absentOr(value.field, isString))
    return undefined;
  const { view, key, field } = value;
  return {
    view,
    ...(key === undefined ? {} : { key }),
    ...(field === undefined ? {} : { field }),
  };
}

function requestOf(json: unknown): UiRequest | undefined {
  if (!isFields(json)) return undefined;
  const { id, op, input, timeoutMs } = json;
  const origin = originOf(json.origin);
  if (!isString(id) || id === "" || !origin || !isPositiveInteger(timeoutMs)) {
    return undefined;
  }
  if (!isUiOp(op)) return undefined;
  const parsed = uiOps[op].input(input);
  return parsed === undefined
    ? undefined
    : ({ id, origin, timeoutMs, op, input: parsed } as UiRequest);
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

export function parseUiFrame(_data: string): ParsedUiFrame {
  throw new Error("not implemented");
}
