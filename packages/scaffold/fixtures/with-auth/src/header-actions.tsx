import { AgentButton } from "./agent/agent-button.js";
import { SignOutButton } from "./auth/sign-out-button.js";

export function HeaderActions() {
  return (
    <div className="flex items-center gap-2">
      <AgentButton />
      <SignOutButton />
    </div>
  );
}
