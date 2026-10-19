import type { ChannelConnection } from "@parlor/sync";

import {
  type ClientSummary,
  isUiOp,
  LEGACY_UI_OPS,
  type PresenceUpdate,
  type UiOp,
} from "../protocol.js";
import { audienceOf } from "./audience.js";

export interface ConnectedClient {
  readonly id: string;
  readonly scope: string;
  readonly platform: string;
  readonly buildId: string | undefined;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly ops: readonly UiOp[];
  readonly canConfirm: boolean;
  readonly seenAt: number;
}

export interface ClientTarget {
  readonly client: ConnectedClient;
  send(data: string): boolean;
}

export interface Selection {
  readonly target: ClientTarget;
  readonly tied: readonly ConnectedClient[];
}

export type PresenceOutcome = "rejected" | "updated" | "registered";

export type DirectoryChange = "joined" | "updated" | "left";

export type DirectoryListener = (
  scope: string,
  clientId: string,
  change: DirectoryChange,
) => void;

interface Entry {
  client: ConnectedClient;
  readonly connections: ChannelConnection[];
}

export class ClientDirectory {
  readonly #now: () => number;
  readonly #byId = new Map<string, Entry>();
  readonly #byScope = new Map<string, Set<Entry>>();
  readonly #unannounced = new Map<string, ChannelConnection[]>();

  readonly #listeners = new Set<DirectoryListener>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  subscribe(listener: DirectoryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(stream: ChannelConnection): () => void {
    const { clientId } = stream;
    if (clientId === undefined) return () => {};
    const connection: ChannelConnection = {
      ...stream,
      scope: audienceOf(stream.scope, stream.principal),
    };
    this.#keepUnannounced(clientId, [
      ...(this.#unannounced.get(clientId) ?? []),
      connection,
    ]);
    return () => this.#disconnect(clientId, connection);
  }

  touch(clientId: string | undefined, scope: string): void {
    if (clientId === undefined) return;
    const entry = this.#byId.get(clientId);
    if (!entry || entry.client.scope !== scope) return;
    entry.client = { ...entry.client, seenAt: this.#now() };
    this.#notify(entry.client, "updated");
  }

  presence(clientId: string, scope: string, update: PresenceUpdate): PresenceOutcome {
    const announcing = this.#takeUnannounced(clientId, scope);
    let entry = this.#byId.get(clientId);
    if (entry && entry.client.scope !== scope) {
      if (announcing.length === 0) return "rejected";
      this.#forget(entry);
      entry = undefined;
    }
    if (!entry && announcing.length === 0) return "rejected";
    const client: ConnectedClient = {
      id: clientId,
      scope,
      platform: update.platform,
      buildId: update.buildId,
      focused: update.focused,
      visible: update.visible,
      ops: update.ops ? update.ops.filter(isUiOp) : LEGACY_UI_OPS,
      canConfirm: update.canConfirm ?? false,
      seenAt: this.#now(),
    };
    if (entry) {
      entry.client = client;
    } else {
      entry = { client, connections: [] };
      this.#byId.set(clientId, entry);
      this.#scopeSet(scope).add(entry);
    }
    entry.connections.push(...announcing);
    const outcome = announcing.length > 0 ? "registered" : "updated";
    this.#notify(client, outcome === "registered" ? "joined" : "updated");
    return outcome;
  }

  leave(clientId: string, scope: string): boolean {
    const entry = this.#byId.get(clientId);
    if (!entry || entry.client.scope !== scope) return false;
    const released = entry.connections.splice(0);
    this.#forget(entry);
    this.#keepUnannounced(clientId, [
      ...(this.#unannounced.get(clientId) ?? []),
      ...released,
    ]);
    return true;
  }

  connected(scope: string, clientId: string): boolean {
    return this.#byId.get(clientId)?.client.scope === scope;
  }

  targets(scope: string): readonly ClientTarget[] {
    return [...(this.#byScope.get(scope) ?? [])].map((entry) => this.#targetOf(entry));
  }

  target(clientId: string): ClientTarget | undefined {
    const entry = this.#byId.get(clientId);
    return entry && this.#targetOf(entry);
  }

  select(scope: string, clientId?: string): Selection | undefined {
    const entries = [...(this.#byScope.get(scope) ?? [])];
    if (entries.length === 0) return undefined;
    const explicit = clientId === undefined ? undefined : this.#byId.get(clientId);
    if (explicit && explicit.client.scope === scope) {
      return { target: this.#targetOf(explicit), tied: [] };
    }
    const focused = entries.filter((e) => e.client.focused);
    if (focused.length > 0) return this.#mostRecent(focused, () => true);
    const visible = entries.filter((e) => e.client.visible);
    const pool = visible.length > 0 ? visible : entries;
    return this.#mostRecent(pool, (a, b) => a.client.seenAt === b.client.seenAt);
  }

  summaries(scope: string): ClientSummary[] {
    return [...(this.#byScope.get(scope) ?? [])].map((entry) =>
      this.summary(entry.client),
    );
  }

  summary(client: ConnectedClient): ClientSummary {
    return {
      id: client.id,
      platform: client.platform,
      ...(client.buildId === undefined ? {} : { buildId: client.buildId }),
      focused: client.focused,
      visible: client.visible,
      seenAgoMs: Math.max(0, this.#now() - client.seenAt),
    };
  }

  #mostRecent(pool: Entry[], ties: (a: Entry, b: Entry) => boolean): Selection {
    let best = pool[0]!;
    for (const entry of pool) if (entry.client.seenAt >= best.client.seenAt) best = entry;
    const tied = pool.filter((entry) => entry !== best && ties(entry, best));
    return { target: this.#targetOf(best), tied: tied.map((entry) => entry.client) };
  }

  #targetOf(entry: Entry): ClientTarget {
    return {
      client: entry.client,
      send: (data) => {
        const connection = entry.connections.at(-1);
        if (!connection) return false;
        connection.send(data);
        return true;
      },
    };
  }

  #takeUnannounced(clientId: string, scope: string): ChannelConnection[] {
    const waiting = this.#unannounced.get(clientId) ?? [];
    this.#keepUnannounced(
      clientId,
      waiting.filter((connection) => connection.scope !== scope),
    );
    return waiting.filter((connection) => connection.scope === scope);
  }

  #keepUnannounced(clientId: string, connections: ChannelConnection[]): void {
    if (connections.length > 0) this.#unannounced.set(clientId, connections);
    else this.#unannounced.delete(clientId);
  }

  #disconnect(clientId: string, connection: ChannelConnection): void {
    const waiting = this.#unannounced.get(clientId);
    if (waiting?.includes(connection)) {
      this.#keepUnannounced(
        clientId,
        waiting.filter((candidate) => candidate !== connection),
      );
      return;
    }
    const entry = this.#byId.get(clientId);
    const index = entry?.connections.indexOf(connection) ?? -1;
    if (!entry || index === -1) return;
    entry.connections.splice(index, 1);
    if (entry.connections.length === 0) this.#forget(entry);
  }

  #forget(entry: Entry): void {
    if (this.#byId.get(entry.client.id) !== entry) return;
    this.#byId.delete(entry.client.id);
    const peers = this.#byScope.get(entry.client.scope);
    peers?.delete(entry);
    if (peers?.size === 0) this.#byScope.delete(entry.client.scope);
    this.#notify(entry.client, "left");
  }

  #notify(client: ConnectedClient, change: DirectoryChange): void {
    for (const listener of this.#listeners) listener(client.scope, client.id, change);
  }

  #scopeSet(scope: string): Set<Entry> {
    let set = this.#byScope.get(scope);
    if (!set) {
      set = new Set();
      this.#byScope.set(scope, set);
    }
    return set;
  }
}
