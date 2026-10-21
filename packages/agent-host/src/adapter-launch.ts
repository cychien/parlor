import { ADAPTER_BINARY_ENV, type AgentProfile } from "./agents.js";
import { adapterKey, embeddedAdapters } from "./embedded.js";
import { selfInvocation } from "./self.js";
import { resolveBinary } from "./shell-path.js";

export function commandOf(profile: AgentProfile): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (profile.launch.kind === "native") {
    return { command: profile.launch.command, args: profile.launch.args };
  }
  const embedded = embeddedAdapters.get(adapterKey(profile.launch));
  if (embedded !== undefined) {
    const self = selfInvocation(["adapter", embedded]);
    return {
      command: self.command,
      args: [...self.args, ...(profile.launch.args ?? [])],
    };
  }
  return {
    command: "npx",
    args: [
      "--yes",
      `${profile.launch.package}@${profile.launch.version}`,
      ...(profile.launch.args ?? []),
    ],
  };
}

export async function launchEnvironment(
  profile: AgentProfile,
  env: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const variable =
    profile.launch.kind === "adapter"
      ? ADAPTER_BINARY_ENV[profile.launch.package]
      : undefined;
  if (variable === undefined || env[variable] !== undefined) return { ...env };
  const found = await resolveBinary(profile.binary, env.PATH ?? "");
  return found === undefined ? { ...env } : { ...env, [variable]: found };
}
