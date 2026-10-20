import type { ProtocolRange } from "@parlor/chat";

export interface HostRelease {
  readonly version: string;
  /** Host protocols it speaks with app backends. */
  readonly protocols: ProtocolRange;
  /** The control protocol it speaks with CLIs and desktop sidecars. */
  readonly control: number;
}
