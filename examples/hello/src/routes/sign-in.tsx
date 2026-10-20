import { AuthClientError } from "@parlor/auth/client";
import { useSession } from "@parlor/client/react";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";

import { auth } from "../auth.js";

export const Route = createFileRoute("/sign-in")({
  staticData: {
    description: "Sign in or create an account with an email and a password.",
  },
  component: SignIn,
});

type Mode = "sign-in" | "sign-up";

/** An MCP client's authorization comes back here with a signed query to resume after sign-in. */
const resumesAuthorization = () => new URLSearchParams(window.location.search).has("sig");

function SignIn() {
  const session = useSession();
  const navigate = useNavigate();
  const errorId = useId();
  const [mode, setMode] = useState<Mode>("sign-in");
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
      if (mode === "sign-up") {
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

  const signingUp = mode === "sign-up";
  return (
    <main className="auth">
      <h1>{signingUp ? "Create your account" : "Sign in to Hello"}</h1>
      {resumesAuthorization() && (
        <p className="auth-note">
          An agent is asking to connect. Sign in to review its request.
        </p>
      )}
      <form
        onSubmit={(event) => void submit(event)}
        className="stack"
        aria-describedby={error ? errorId : undefined}
      >
        {signingUp && (
          <label className="field">
            <span>Name</span>
            <input name="name" autoComplete="name" required />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete={signingUp ? "new-password" : "current-password"}
            minLength={8}
            required
          />
        </label>
        {error && (
          <p id={errorId} role="alert" className="auth-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {signingUp ? "Create account" : "Sign in"}
        </button>
      </form>
      <p className="auth-switch">
        {signingUp ? "Already have an account?" : "New to Hello?"}{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(signingUp ? "sign-in" : "sign-up");
            setError("");
          }}
        >
          {signingUp ? "Sign in" : "Create an account"}
        </button>
      </p>
    </main>
  );
}
