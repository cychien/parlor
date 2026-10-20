import type { DataProvider } from "@parlor/core";
import type { ActionAudit, Migration } from "@parlor/server";
import { type SQL, sql } from "drizzle-orm";

import type { Database } from "./database.js";

export const AUDIT_MIGRATION: Migration = {
  id: "auth/0006_audit",
  sql: `
    create table parlor_auth_audit (
      id bigint generated always as identity primary key,
      at timestamptz not null,
      action text not null,
      actor_kind text not null,
      user_id text,
      grant_id text,
      session_id text,
      device_id text,
      host_id text,
      agent_name text,
      agent_verified boolean,
      thread_id text,
      turn_id text,
      source text not null,
      scope text not null,
      input_digest text not null,
      stage text not null,
      outcome text not null,
      confirmation text
    );
    create index parlor_auth_audit_by_user on parlor_auth_audit (user_id, at);
    create function parlor_auth_audit_append_only() returns trigger language plpgsql as $$
    begin
      raise exception 'parlor_auth_audit is append-only';
    end
    $$;
    create trigger parlor_auth_audit_append_only
      before update or delete on parlor_auth_audit
      for each row execute function parlor_auth_audit_append_only()`,
};

const FLUSH_MS = 250;
const FLUSH_AT = 100;
const KEEP_AT_MOST = 10_000;

function audited({ principal, stage, confirmation }: ActionAudit): boolean {
  return principal.kind === "agent" || stage === "refused" || confirmation !== undefined;
}

function rowOf(audit: ActionAudit): SQL {
  const { principal } = audit;
  const user = principal.kind === "anonymous" ? undefined : principal.userId;
  const grant =
    principal.kind === "agent" || principal.kind === "host"
      ? principal.grantId
      : undefined;
  const turn = principal.kind === "agent" ? principal.turn : undefined;
  const host = principal.kind === "host" ? principal.hostId : turn?.hostId;
  return sql`(${new Date(audit.at).toISOString()}, ${audit.action}, ${principal.kind},
    ${user ?? null}, ${grant ?? null},
    ${principal.kind === "user" ? principal.sessionId : null},
    ${principal.kind === "user" ? (principal.deviceId ?? null) : null},
    ${host ?? null},
    ${principal.kind === "agent" ? principal.agent.name : null},
    ${principal.kind === "agent" ? principal.agent.verified : null},
    ${turn?.threadId ?? null}, ${turn?.turnId ?? null},
    ${audit.source}, ${audit.scope}, ${audit.inputDigest}, ${audit.stage}, ${audit.outcome},
    ${audit.confirmation ?? null})`;
}

export interface AuditLog {
  record(audit: ActionAudit): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export function createAuditLog(database: DataProvider): AuditLog {
  let queued: ActionAudit[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;

  const write = async () => {
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    try {
      await database.transaction(async (tx) => {
        await (tx as Database).execute(sql`
          insert into parlor_auth_audit
            (at, action, actor_kind, user_id, grant_id, session_id, device_id, host_id,
             agent_name, agent_verified, thread_id, turn_id, source, scope, input_digest,
             stage, outcome, confirmation)
          values ${sql.join(batch.map(rowOf), sql`, `)}`);
      });
    } catch (error) {
      queued = [...batch, ...queued].slice(-KEEP_AT_MOST);
      throw error;
    }
  };

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const next = writing.then(write, write);
    writing = next.catch(() => {});
    return next;
  };

  const schedule = () => {
    if (timer !== undefined || stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush().catch((error: unknown) => {
        console.error("[parlor] audit write failed, will retry:", error);
        schedule();
      });
    }, FLUSH_MS);
    timer.unref?.();
  };

  return {
    record(audit) {
      if (!audited(audit)) return;
      queued.push(audit);
      if (queued.length >= FLUSH_AT) {
        flush().catch((error: unknown) => {
          console.error("[parlor] audit write failed, will retry:", error);
          schedule();
        });
      } else {
        schedule();
      }
    },
    flush,
    async stop() {
      stopped = true;
      await flush().catch((error: unknown) => {
        console.error("[parlor] audit write failed on shutdown:", error);
      });
    },
  };
}
