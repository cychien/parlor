import type {
  AttentionSnapshot,
  FocusSnapshot,
  ItemSnapshot,
  JsonObject,
  QuerySnapshot,
  RecentRef,
  RouteSnapshot,
  ScreenSnapshot,
  SelectionSnapshot,
  SingleViewSnapshot,
  TruncatedValue,
  ViewSnapshot,
} from "../protocol.js";
import type { BrowserEnvironment, RectLike } from "./environment.js";
import { type Moment, type MountedView, refOf, type RegistryReader } from "./registry.js";

export interface ScreenLimits {
  readonly totalBytes: number;
  readonly valueBytes: number;
  readonly itemsPerView: number;
  readonly selectionChars: number;
}

export const DEFAULT_SCREEN_LIMITS: ScreenLimits = {
  totalBytes: 64 * 1024,
  valueBytes: 8 * 1024,
  itemsPerView: 50,
  selectionChars: 2000,
};

export interface PageSources {
  route(): RouteSnapshot | null;
  queries(): readonly QuerySnapshot[];
}

interface Measured {
  readonly mounted: MountedView;
  readonly shown: number;
  readonly score: number;
}

const encoder = new TextEncoder();
const bytesOf = (json: string) => encoder.encode(json).byteLength;

export function measure(
  element: Element,
  env: BrowserEnvironment,
): { shown: number; score: number } {
  const rect: RectLike = env.rect(element);
  const { width, height } = env.viewport();
  const area = rect.width * rect.height;
  if (area <= 0) return { shown: 0, score: 0 };
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, height);
  const visibleHeight = Math.max(0, bottom - top);
  const visibleWidth = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
  const shown = Math.round(((visibleHeight * visibleWidth) / area) * 100) / 100;
  if (shown <= 0) return { shown: 0, score: 0 };
  const half = height / 2;
  const distance = Math.abs((top + bottom) / 2 - half);
  return { shown, score: shown * Math.max(0, 1 - distance / half) };
}

function valueOf(mounted: MountedView, limit: number): JsonObject | TruncatedValue {
  const value = mounted.binding.get();
  const bytes = bytesOf(JSON.stringify(value));
  return bytes > limit ? { truncated: true, bytes } : value;
}

function documentOrder(a: Measured, b: Measured): number {
  const x = a.mounted.element;
  const y = b.mounted.element;
  if (!x || !y || x === y) return 0;
  return x.compareDocumentPosition(y) & 4 ? -1 : 1;
}

function labelOf(element: Element): string | undefined {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria;
  const labels = (element as HTMLInputElement).labels;
  const text = (labels?.[0] ?? element.closest("label"))?.textContent?.trim();
  return text || undefined;
}

function focusOf(
  registry: RegistryReader,
  env: BrowserEnvironment,
): FocusSnapshot | null {
  const active = env.document?.activeElement;
  if (
    !active ||
    active === env.document?.body ||
    active === env.document?.documentElement
  ) {
    return null;
  }
  const owner = registry.owner(active);
  const field = active.getAttribute("name") ?? undefined;
  const label = labelOf(active);
  return {
    ...(owner ? refOf(owner) : {}),
    ...(field ? { field } : {}),
    ...(label ? { label } : {}),
  };
}

function selectionOf(
  registry: RegistryReader,
  env: BrowserEnvironment,
  limit: number,
): SelectionSnapshot | null {
  const selection = env.document?.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const owners = new Set(
    Array.from({ length: selection.rangeCount }, (_, index) =>
      registry.owner(selection.getRangeAt(index).commonAncestorContainer),
    ),
  );
  const [owner] = owners;
  if (owners.size !== 1 || !owner) return null;
  const text = selection.toString();
  if (!text) return null;
  return {
    text: text.slice(0, limit),
    within: refOf(owner),
    truncated: text.length > limit,
  };
}

function recent(moment: Moment | undefined, env: BrowserEnvironment): RecentRef | null {
  return moment
    ? { ...refOf(moment.view), agoMs: Math.max(0, env.now() - moment.at) }
    : null;
}

export function captureScreen(
  registry: RegistryReader,
  page: PageSources,
  env: BrowserEnvironment,
  limits: ScreenLimits,
): ScreenSnapshot {
  const views: Record<string, ViewSnapshot> = {};
  const singleShown = new Map<string, number>();
  let focal: Measured | undefined;
  const consider = (candidate: Measured) => {
    if (candidate.score > 0 && (!focal || candidate.score > focal.score))
      focal = candidate;
  };

  for (const mounted of registry.singles()) {
    const snapshot: SingleViewSnapshot = { value: valueOf(mounted, limits.valueBytes) };
    if (mounted.element) {
      const measured = { mounted, ...measure(mounted.element, env) };
      consider(measured);
      singleShown.set(mounted.view.name, measured.shown);
      views[mounted.view.name] = { ...snapshot, shown: measured.shown };
    } else {
      views[mounted.view.name] = snapshot;
    }
  }

  const onScreen = new Map<string, Measured[]>();
  for (const mounted of registry.onScreenCandidates()) {
    if (!mounted.element || !registry.isCurrent(mounted)) continue;
    const measured = { mounted, ...measure(mounted.element, env) };
    if (measured.shown <= 0) continue;
    const list = onScreen.get(mounted.view.name) ?? [];
    list.push(measured);
    onScreen.set(mounted.view.name, list);
  }
  const keyed = new Map<string, ItemSnapshot[]>();
  for (const [name, measured] of onScreen) {
    measured.sort(documentOrder);
    const listed = measured.slice(0, limits.itemsPerView);
    for (const item of measured) consider(item);
    keyed.set(
      name,
      listed.map((item) => ({
        key: item.mounted.key ?? "",
        value: valueOf(item.mounted, limits.valueBytes),
        shown: item.shown,
      })),
    );
  }

  const keyedView = (name: string, items: readonly ItemSnapshot[]) => ({
    items,
    offscreen: registry.keyedCount(name) - items.length,
  });
  for (const [name, items] of keyed) views[name] = keyedView(name, items);

  const attention: AttentionSnapshot = {
    focus: focusOf(registry, env),
    selection: selectionOf(registry, env, limits.selectionChars),
    lastInteracted: recent(registry.lastInteracted(), env),
    lastEntered: recent(registry.lastEntered(), env),
    focal: focal ? refOf(focal.mounted) : null,
  };

  const snapshot: ScreenSnapshot = {
    route: page.route(),
    queries: page.queries(),
    views,
    attention,
    truncated: false,
  };
  return fitBudget(snapshot, keyed, singleShown, keyedView, limits.totalBytes);
}

function fitBudget(
  snapshot: ScreenSnapshot,
  keyed: Map<string, ItemSnapshot[]>,
  singleShown: ReadonlyMap<string, number>,
  keyedView: (name: string, items: readonly ItemSnapshot[]) => ViewSnapshot,
  totalBytes: number,
): ScreenSnapshot {
  let size = bytesOf(JSON.stringify(snapshot));
  if (size <= totalBytes) return snapshot;

  const views = { ...snapshot.views };
  const byShown = [...keyed].flatMap(([name, items]) =>
    items.map((item) => ({ name, item })),
  );
  byShown.sort((a, b) => a.item.shown - b.item.shown);
  const dropped = new Set<ItemSnapshot>();
  let next = 0;
  while (size > totalBytes && next < byShown.length) {
    const { item } = byShown[next++]!;
    dropped.add(item);
    size -= bytesOf(JSON.stringify(item)) + 1;
  }
  const withoutDropped = (): ScreenSnapshot => {
    for (const [name, items] of keyed) {
      views[name] = keyedView(
        name,
        items.filter((item) => !dropped.has(item)),
      );
    }
    return { ...snapshot, views, truncated: true };
  };
  let fitted = withoutDropped();
  const fits = () => bytesOf(JSON.stringify(fitted)) <= totalBytes;
  while (!fits() && next < byShown.length) {
    dropped.add(byShown[next++]!.item);
    fitted = withoutDropped();
  }
  if (fits()) return fitted;

  fitted = { ...fitted, queries: [] };
  if (fits()) return fitted;

  for (const name of [...singleShown.keys()].sort(
    (a, b) => singleShown.get(a)! - singleShown.get(b)!,
  )) {
    delete views[name];
    if (fits()) return fitted;
  }
  for (const name of Object.keys(views)) delete views[name];
  if (fits()) return fitted;
  return {
    ...fitted,
    route:
      fitted.route?.notFound === false ? { ...fitted.route, search: {} } : fitted.route,
    attention: { ...fitted.attention, selection: null },
  };
}
