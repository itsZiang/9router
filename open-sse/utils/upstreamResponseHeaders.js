/**
 * Header-strip helper for upstream provider responses.
 *
 * `fetch()` always decompresses the upstream body before exposing it via
 * `.text()` or the stream reader, so forwarding the upstream `content-encoding`
 * to the downstream client (e.g. `gzip`) makes the client attempt to gunzip
 * plain text and fail with `ZlibError: incorrect header check`.
 *
 * Similarly, `content-length` becomes stale once we transform or repack the
 * response stream, and `transfer-encoding` is managed by the runtime
 * (Next.js / Node), not us.
 */

const STRIP_HEADER_NAMES = new Set(["content-encoding", "content-length", "transfer-encoding"]);

/**
 * Return a new `Headers` instance with stale encoding/length headers removed.
 * Does not mutate the input.
 */
export function stripStaleEncodingHeaders(input) {
  const out = new Headers(input);
  for (const name of STRIP_HEADER_NAMES) out.delete(name);
  return out;
}

/**
 * Return a new entries array with stale encoding/length headers removed and
 * (optionally) additional header names removed. Case-insensitive.
 */
export function filterUpstreamResponseHeaderEntries(entries, extraToStrip = []) {
  const drop = new Set(STRIP_HEADER_NAMES);
  for (const h of extraToStrip) drop.add(h.toLowerCase());
  const result = [];
  for (const [k, v] of entries) {
    if (!drop.has(k.toLowerCase())) result.push([k, v]);
  }
  return result;
}
export const STRIP_UPSTREAM_HEADER_NAMES = STRIP_HEADER_NAMES;