/** ACP adapters this build carries inside itself, by `<package>@<version>`, naming the `adapter <id>` that runs each. */
export const embeddedAdapters = new Map<string, string>();

export const adapterKey = (launch: {
  readonly package: string;
  readonly version: string;
}) => `${launch.package}@${launch.version}`;
