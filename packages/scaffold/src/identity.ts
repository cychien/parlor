import { CreateError } from "./errors.js";

export interface AppIdentity {
  readonly directoryName: string;
  readonly packageName: string;
  readonly appName: string;
  readonly appId: string;
}

/** `my-app` -> { packageName: "my-app", appName: "My App", appId: "com.example.myapp" }. */
export function identityFor(directoryName: string): AppIdentity {
  const ascii = directoryName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const words = ascii.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const packageName = ascii
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  const segment = words.join("").toLowerCase();
  if (words.length === 0 || packageName === "" || segment === "") {
    throw new CreateError(
      `"${directoryName}" cannot name a project. Use letters and digits, for example my-app.`,
    );
  }
  return {
    directoryName,
    packageName,
    appName: words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "),
    appId: `com.example.${/^[0-9]/.test(segment) ? `app${segment}` : segment}`,
  };
}
