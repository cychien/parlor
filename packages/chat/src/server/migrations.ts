import type { Migration } from "@parlor/server";

export const CHAT_MIGRATIONS: readonly Migration[] = [
  {
    id: "chat/0001_threads",
    sql: `
      create table parlor_chat_threads (
        id text primary key,
        scope text not null,
        owner_id text not null,
        title text not null default '',
        host_id text,
        agent_id text,
        last_seq bigint not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index parlor_chat_threads_owner
        on parlor_chat_threads (owner_id, scope, updated_at desc);

      create table parlor_chat_items (
        id text primary key,
        thread_id text not null references parlor_chat_threads (id) on delete cascade,
        turn_id text not null,
        seq bigint not null,
        author text not null check (author in ('user', 'agent', 'system')),
        kind text not null,
        body jsonb not null,
        created_at timestamptz not null default now(),
        unique (thread_id, seq)
      );
      create unique index parlor_chat_items_one_answer
        on parlor_chat_items (thread_id, (body->>'askId')) where kind = 'answer';

      create table parlor_chat_turns (
        id text primary key,
        thread_id text not null references parlor_chat_threads (id) on delete cascade,
        scope text not null,
        owner_id text not null,
        host_id text not null,
        agent_id text not null,
        client_id text not null,
        device_id text,
        prompt_item_id text not null,
        state text not null
          check (state in ('queued', 'running', 'done', 'failed', 'cancelled')),
        lease_until timestamptz,
        outcome jsonb,
        created_at timestamptz not null default now(),
        finished_at timestamptz
      );
      create index parlor_chat_turns_queue
        on parlor_chat_turns (host_id, state, created_at) where state = 'queued';
      create unique index parlor_chat_turns_one_running
        on parlor_chat_turns (thread_id) where state = 'running';
      create index parlor_chat_turns_thread_state on parlor_chat_turns (thread_id, state);
      create index parlor_chat_turns_lease
        on parlor_chat_turns (lease_until) where state = 'running';

      create index parlor_chat_items_signals
        on parlor_chat_items (turn_id, seq) where kind in ('answer', 'cancel');

      create table parlor_chat_hosts (
        id text primary key,
        scope text not null,
        owner_id text not null,
        grant_id text not null,
        protocol integer not null,
        name text not null,
        platform text not null,
        agents jsonb not null,
        online_until timestamptz not null,
        announced_online boolean not null
      );
      create index parlor_chat_hosts_owner on parlor_chat_hosts (owner_id, scope);
      create index parlor_chat_hosts_lapse
        on parlor_chat_hosts (online_until) where announced_online;`,
  },
];
