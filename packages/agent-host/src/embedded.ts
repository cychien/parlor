export const embeddedAdapters = new Map<string, string>();

export const adapterKey = (launch: {
  readonly package: string;
  readonly version: string;
}) => `${launch.package}@${launch.version}`;
