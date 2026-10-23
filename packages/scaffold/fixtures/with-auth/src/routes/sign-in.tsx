import { AuthClientError } from "@parlor/auth/client";
import { useSession } from "@parlor/client/react";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

import { auth } from "../auth/client.js";

export const Route = createFileRoute("/sign-in")({
  staticData: {
    description: "Sign in, or create an account, with an email and a password.",
  },
  component: SignIn,
});

/** An MCP client's authorization comes back here with a signed query to resume after sign-in. */
const resumesAuthorization = () => new URLSearchParams(window.location.search).has("sig");

const FIELD =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 focus:border-zinc-900 focus:outline-none";

function SignIn() {
  const session = useSession();
  const navigate = useNavigate();
  const errorId = useId();
  const [signingUp, setSigningUp] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (session.status === "anonymous") return <Navigate to="/" />;
  if (session.status === "signed-in" && !resumesAuthorization())
    return <Navigate to="/" />;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    const password = String(form.get("password"));
    setBusy(true);
    setError("");
    try {
      if (signingUp) {
        await auth.signUp({ name: String(form.get("name")).trim(), email, password });
      } else {
        await auth.signIn({ email, password });
      }
      if (!resumesAuthorization()) await navigate({ to: "/" });
    } catch (failure) {
      setError(
        failure instanceof AuthClientError ? failure.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-6 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {signingUp ? "Create your account" : "Sign in"}
      </h1>
      <form
        onSubmit={(event) => void submit(event)}
        aria-describedby={error ? errorId : undefined}
        className="space-y-3"
      >
        {signingUp ? (
          <input
            name="name"
            aria-label="Name"
            placeholder="Name"
            autoComplete="name"
            required
            className={FIELD}
          />
        ) : null}
        <input
          name="email"
          type="email"
          aria-label="Email"
          placeholder="Email"
          autoComplete="email"
          required
          className={FIELD}
        />
        <input
          name="password"
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete={signingUp ? "new-password" : "current-password"}
          minLength={8}
          required
          className={FIELD}
        />
        {error ? (
          <p id={errorId} role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {signingUp ? "Create account" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setSigningUp(!signingUp)}
        className="text-sm text-zinc-600 underline"
      >
        {signingUp ? "I have an account" : "Create an account"}
      </button>
    </main>
  );
}
