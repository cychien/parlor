import type { Migration } from "@parlor/server";

export const AUTH_MIGRATIONS: readonly Migration[] = [
  {
    id: "auth/0001_revocations",
    sql: `
      create table parlor_auth_revocations (
        kind text not null,
        id text not null,
        revoked_at timestamptz not null,
        primary key (kind, id)
      )`,
  },
  {
    id: "auth/0002_revocations_revoked_at",
    sql: "create index parlor_auth_revocations_revoked_at on parlor_auth_revocations (revoked_at)",
  },
];
