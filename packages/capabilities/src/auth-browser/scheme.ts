export function schemeOf(callbackUrl: string): string {
  return new URL(callbackUrl).protocol.slice(0, -1);
}
