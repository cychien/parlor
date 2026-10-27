import { ADAPTER_BINARY_ENV, ADAPTER_ENV, type AgentProfile } from "./agents.js";
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
  const adapter = profile.launch.kind === "adapter" ? profile.launch.package : undefined;
  const own = { ...env, ...(adapter ? ADAPTER_ENV[adapter] : undefined) };
  const variable = adapter ? ADAPTER_BINARY_ENV[adapter] : undefined;
  if (variable === undefined || env[variable] !== undefined) return own;
  const found = await resolveBinary(profile.binary, env.PATH ?? "");
  return found === undefined ? own : { ...own, [variable]: found };
}
