/**
 * How long a revocation is remembered. Whatever it revokes must stop verifying within
 * this long, or the revocation is forgotten while the credential still works.
 */
export const REVOCATION_HORIZON_MS = 11 * 60_000;
