/**
 * Loopback bind hosts that are exempt from the send-API key requirement.
 *
 * Shared by startup validation (suppresses the missing-key warning) and the
 * /api/send auth middleware (allows unauthenticated requests when no key is
 * configured), so both sides agree on which binds are loopback. Matching is
 * exact: only these three literal HOST values count. 127.0.0.0/8 addresses
 * other than 127.0.0.1 are NOT loopback here.
 */
export const LOOPBACK_BIND_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host);
}
