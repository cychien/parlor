declare const idKind: unique symbol;

export type IdKind = "user" | "device" | "grant" | "host" | "thread" | "turn" | "item";

export type Id<K extends IdKind> = string & { readonly [idKind]: K };

export type UserId = Id<"user">;
export type DeviceId = Id<"device">;
export type GrantId = Id<"grant">;
export type HostId = Id<"host">;
export type ThreadId = Id<"thread">;
export type TurnId = Id<"turn">;
export type ItemId = Id<"item">;

/**
 * Names a string as an id. Only boundary code calls it: a verified token's claims, a
 * database row, a request body after validation.
 */
export function asId<K extends IdKind>(_kind: K, value: string): Id<K> {
  return value as Id<K>;
}
