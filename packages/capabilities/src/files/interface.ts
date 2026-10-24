export interface PickOptions {
  /** What may be chosen, as an `<input accept>` takes it: `["image/*", ".pdf"]`. */
  readonly accept?: readonly string[] | undefined;
  readonly multiple?: boolean | undefined;
}

export interface PickedFile {
  readonly name: string;
  /** The MIME type, or `""` when the platform cannot tell. */
  readonly type: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export interface SaveOptions {
  /** The file name to suggest. */
  readonly name: string;
  readonly type?: string | undefined;
}

export type SaveOutcome = "saved" | "cancelled";

export interface Files {
  /** Asks the user for files; an empty list when they cancel. */
  pick(options?: PickOptions): Promise<readonly PickedFile[]>;
  /**
   * Asks the user where to keep `data`: a save dialog where there is one, a download in a
   * browser without, the share sheet on a phone.
   */
  save(data: Blob | Uint8Array | string, options: SaveOptions): Promise<SaveOutcome>;
}
