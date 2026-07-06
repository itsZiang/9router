import { Agent, buildConnector } from "undici";
import { SocksClient } from "socks";
const DEFAULT_SOCKS_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_SOCKS_HANDSHAKE_TIMEOUT_MS = 120_000;

/**
 * Resolve the SOCKS5 handshake (connect) timeout, operator-tunable via
 * `SOCKS_HANDSHAKE_TIMEOUT_MS` (#5109). Under a saturated per-host pool the real
 * handshake to a residential gateway can exceed the 10s default even though the
 * proxy is reachable, so high-concurrency deployments can raise it without a
 * code change. Invalid / non-positive values fall back to the default; values
 * above the ceiling are clamped.
 */
export function resolveSocksHandshakeTimeoutMs(env = process.env) {
  const raw = env.SOCKS_HANDSHAKE_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_SOCKS_HANDSHAKE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SOCKS_HANDSHAKE_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_SOCKS_HANDSHAKE_TIMEOUT_MS);
}

/** The net.connect family options pinned for the SOCKS proxy hop. */
export function buildSocksFamilySocketOptions(family) {
  if (family === 6) return {
    family: 6,
    autoSelectFamily: false
  };
  if (family === 4) return {
    family: 4,
    autoSelectFamily: false
  };
  return {};
}
function resolvePort(protocol, port) {
  return port ? Number.parseInt(port, 10) : protocol === "http:" ? 80 : 443;
}

/**
 * Undici connector that tunnels through a single SOCKS5 proxy, pinning the family
 * of the TCP connection to the proxy host when `family` is set. Mirrors fetch-socks'
 * socksConnector but threads `socket_options` (which fetch-socks does not expose)
 * into SocksClient so Happy Eyeballs cannot pick IPv4 for an IPv6-only egress policy.
 */
function socksConnectorWithFamily(proxy, family, tlsOpts = {}) {
  const undiciConnect = buildConnector(tlsOpts);
  const socketOptions = buildSocksFamilySocketOptions(family);
  return async (options, callback) => {
    const {
      protocol,
      hostname,
      port,
      httpSocket
    } = options;
    try {
      const r = await SocksClient.createConnection({
        command: "connect",
        proxy,
        timeout: resolveSocksHandshakeTimeoutMs(),
        destination: {
          host: hostname,
          port: resolvePort(protocol, port)
        },
        existing_socket: httpSocket,
        socket_options: socketOptions
      });
      const sock = r.socket;
      if (protocol !== "https:") {
        return callback(null, sock.setNoDelay());
      }
      return undiciConnect({
        ...options,
        httpSocket: sock
      }, callback);
    } catch (error) {
      return callback(error, null);
    }
  };
}

/** Build an undici Agent dispatcher that SOCKS5-tunnels with a pinned proxy-hop family. */
export function createSocksDispatcherWithFamily(proxy, family, agentOptions = {}) {
  const {
    connect,
    ...rest
  } = agentOptions;
  return new Agent({
    ...rest,
    connect: socksConnectorWithFamily(proxy, family, connect)
  });
}