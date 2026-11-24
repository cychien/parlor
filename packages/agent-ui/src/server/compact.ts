import type {
  AttentionSnapshot,
  ClientSummary,
  ItemSnapshot,
  JsonObject,
  QueryStatus,
  RouteSnapshot,
  ScreenSnapshot,
  TruncatedValue,
  ViewSnapshot,
} from "../protocol.js";

export type CompactRoute =
  | {
      readonly path: string;
      readonly url: string;
      readonly params?: Readonly<Record<string, string>>;
      readonly search?: JsonObject;
    }
  | { readonly notFound: true; readonly url: string };

export interface CompactQuery {
  readonly action: string;
  readonly input?: unknown;
  readonly status?: Exclude<QueryStatus, "success">;
}

export interface CompactItem {
  readonly key: string;
  readonly value: JsonObject | TruncatedValue;
  readonly shown?: number;
}

export type CompactView =
  | { readonly value: JsonObject | TruncatedValue; readonly shown?: number }
  | { readonly items: readonly CompactItem[]; readonly offscreen?: number };

export type CompactAttention = {
  readonly [K in keyof AttentionSnapshot]?: NonNullable<AttentionSnapshot[K]>;
};

export interface CompactScreen {
  readonly route?: CompactRoute;
  readonly queries?: readonly CompactQuery[];
  readonly views?: Readonly<Record<string, CompactView>>;
  readonly attention?: CompactAttention;
  readonly truncated?: true;
}

export interface CompactClient {
  readonly id?: string;
  readonly platform: string;
  readonly buildId?: string;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly seenAgoMs?: number;
}

const isEmpty = (value: object) => Object.keys(value).length === 0;

const EMPTY_ATTENTION: AttentionSnapshot = {
  focus: null,
  selection: null,
  lastInteracted: null,
  lastEntered: null,
  focal: null,
};

const FULLY_SHOWN = 1;

function compactRoute(route: RouteSnapshot): CompactRoute {
  if (route.notFound) return { notFound: true, url: route.url };
  const { params = {}, search = {} } = route;
  return {
    path: route.path,
    url: route.url,
    ...(isEmpty(params) ? {} : { params }),
    ...(isEmpty(search) ? {} : { search }),
  };
}

const emptyInput = (input: unknown) =>
  input === undefined ||
  (typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    isEmpty(input));

function compactItem(item: ItemSnapshot): CompactItem {
  return {
    key: item.key,
    value: item.value,
    ...(item.shown === FULLY_SHOWN ? {} : { shown: item.shown }),
  };
}

function compactView(view: ViewSnapshot): CompactView {
  if ("items" in view) {
    return {
      items: view.items.map(compactItem),
      ...(view.offscreen === 0 ? {} : { offscreen: view.offscreen }),
    };
  }
  return {
    value: view.value,
    ...(view.shown === undefined || view.shown === FULLY_SHOWN
      ? {}
      : { shown: view.shown }),
  };
}

function compactAttention(attention: AttentionSnapshot): CompactAttention {
  return Object.fromEntries(
    Object.entries(attention).filter(([, value]) => value !== null),
  ) as CompactAttention;
}

/**
 * The screen without what an agent can assume: empty, null, zero and fully shown. A client
 * built before a section existed leaves it out, which reads as empty.
 */
export function compactScreen(snapshot: Partial<ScreenSnapshot>): CompactScreen {
  const views = Object.fromEntries(
    Object.entries(snapshot.views ?? {}).map(([name, view]) => [name, compactView(view)]),
  );
  const attention = compactAttention(snapshot.attention ?? EMPTY_ATTENTION);
  const queries = (snapshot.queries ?? []).map(({ action, input, status }) => ({
    action,
    ...(emptyInput(input) ? {} : { input }),
    ...(status === "success" ? {} : { status }),
  }));
  return {
    ...(snapshot.route ? { route: compactRoute(snapshot.route) } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(isEmpty(views) ? {} : { views }),
    ...(isEmpty(attention) ? {} : { attention }),
    ...(snapshot.truncated ? { truncated: true as const } : {}),
  };
}

/** A client's id and age matter only when the agent has another client to tell it from. */
export function compactClient(summary: ClientSummary, alone: boolean): CompactClient {
  const { id, platform, buildId, focused, visible, seenAgoMs } = summary;
  return {
    ...(alone ? {} : { id }),
    platform,
    ...(buildId === undefined ? {} : { buildId }),
    focused,
    visible,
    ...(alone ? {} : { seenAgoMs }),
  };
}
