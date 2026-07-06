import dns from "node:dns/promises";
import { detectIpLiteralFamily, stripIpv6Brackets } from "./proxyFamily";
const defaultLookup = hostname => dns.lookup(hostname, {
  all: true
});

/**
 * Fail-closed guarantee for an IPv6-only (or IPv4-only) proxy given as a hostname:
 * refuse early if the hostname has no record in the required family. No-op for IP
 * literals (their family is intrinsic).
 */
export async function assertHostnameSupportsFamily(host, family, lookupFn = defaultLookup) {
  if (detectIpLiteralFamily(host) !== null) return;
  let records;
  try {
    records = await lookupFn(stripIpv6Brackets(host));
  } catch (err) {
    throw new Error(`[ProxyFamily] DNS resolution failed for ${host}; refusing to egress (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
  }
  const hasFamily = records.some(r => r.family === family);
  if (!hasFamily) {
    throw new Error(`[ProxyFamily] Proxy host ${host} has no ${family === 6 ? "IPv6 (AAAA)" : "IPv4 (A)"} record; refusing ${family === 6 ? "IPv6" : "IPv4"}-only egress (fail-closed)`);
  }
}