// Lightweight proxy reachability check used by proxyFetch fast-fail.
// This module lives under stubs for compatibility with the split runtime, but
// must not be a hard-coded false result: that would reject every configured
// proxy before undici gets a chance to use it.
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 2500;

function getPort(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol === "socks5:") return 1080;
  return 8080;
}

export function isProxyReachable(proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!proxyUrl) return Promise.resolve(false);

  let parsed;
  try {
    parsed = new URL(String(proxyUrl));
  } catch {
    return Promise.resolve(false);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = getPort(parsed);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(false);
  }

  const familyMarker = parsed.searchParams.get("family");
  const family = familyMarker === "ipv4" ? 4 : familyMarker === "ipv6" ? 6 : undefined;
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port, family });
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

export default { isProxyReachable };
