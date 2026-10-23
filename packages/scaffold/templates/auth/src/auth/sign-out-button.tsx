import { useSession } from "@parlor/client/react";

import { auth } from "./client.js";

export function SignOutButton() {
  const session = useSession();
  if (session.status !== "signed-in") return null;
  return (
    <button
      type="button"
      onClick={() => void auth.signOut()}
      className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
    >
      Sign out
    </button>
  );
}
