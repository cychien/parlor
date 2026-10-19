import type { ConnectedAgent, SignedInSession } from "@parlor/auth";
import { useSession } from "@parlor/client/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { auth } from "./auth.js";

const SESSIONS = ["account", "sessions"] as const;
const AGENTS = ["account", "agents"] as const;

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

function deviceName(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const pick = (table: readonly [RegExp, string][]) =>
    table.find(([pattern]) => pattern.test(userAgent))?.[1];
  const browser = pick(BROWSERS) ?? "App";
  const system = pick(SYSTEMS);
  return system ? `${browser} on ${system}` : browser;
}

const when = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function AccountPanel() {
  const session = useSession();
  if (session.status !== "signed-in") return null;
  return (
    <section aria-labelledby="account">
      <h2 id="account">Account</h2>
      <p className="account-who">
        Signed in as <strong>{session.user.name}</strong> ({session.user.email})
      </p>
      <Sessions />
      <Agents />
    </section>
  );
}

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: SESSIONS,
    queryFn: () => auth.account.call("sessions", {}),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => auth.account.call("revokeSession", { id }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SESSIONS }),
  });
  return (
    <>
      <h3>Where you're signed in</h3>
      <ul className="rows" aria-busy={sessions.isPending}>
        {(sessions.data ?? []).map((item: SignedInSession) => (
          <li key={item.id}>
            <div>
              <p>{deviceName(item.userAgent)}</p>
              <p className="row-meta">
                Last active {when.format(new Date(item.lastActiveAt))}
              </p>
            </div>
            {item.current ? (
              <span className="tag">This device</span>
            ) : (
              <button
                type="button"
                className="danger"
                disabled={revoke.isPending}
                aria-label={`Sign out ${deviceName(item.userAgent)}`}
                onClick={() => revoke.mutate(item.id)}
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Agents() {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: AGENTS,
    queryFn: () => auth.account.call("agents", {}),
  });
  const revoke = useMutation({
    mutationFn: (clientId: string) => auth.account.call("revokeAgent", { clientId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: AGENTS }),
  });
  const list = agents.data ?? [];
  return (
    <>
      <h3>Connected agents</h3>
      {agents.isSuccess && list.length === 0 ? (
        <p className="row-meta">
          No agents yet. Add <code>{`${window.location.origin}/_parlor/mcp`}</code> to an
          MCP client such as Claude Code to connect one.
        </p>
      ) : (
        <ul className="rows" aria-busy={agents.isPending}>
          {list.map((agent: ConnectedAgent) => (
            <li key={agent.clientId}>
              <div>
                <p>{agent.name}</p>
                <p className="row-meta">
                  Connected {when.format(new Date(agent.connectedAt))}
                </p>
              </div>
              <button
                type="button"
                className="danger"
                disabled={revoke.isPending}
                aria-label={`Revoke ${agent.name}`}
                onClick={() => revoke.mutate(agent.clientId)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
