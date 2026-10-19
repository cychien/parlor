export interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export type SessionSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: SessionUser };

/**
 * Who is signed in on this device, as the app's auth client sees it. `current` returns the
 * same object until the session changes.
 */
export interface SessionSource {
  current(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
}
