import pkg from "../../package.json" with { type: "json" };

const APP_VERSION = pkg.version || "0.0.0";
// Cline's api.cline.bot enforces a minimum X-CLIENT-VERSION (the real
// VS Code extension version, e.g. 3.x). 9Router's own version (0.5.x)
// is always below that threshold and triggers
// "Please make sure you're using the latest version of Cline".
// Spoof the extension version here; keep User-Agent as 9Router for
// observability. Override with CLINE_SPOOF_VERSION env if the
// extension bumps again.
const CLINE_SPOOF_VERSION = (typeof process !== "undefined" && process.env.CLINE_SPOOF_VERSION) || "3.20.0";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("workos:") ? trimmed : `workos:${trimmed}`;
}

export function getClineAuthorizationHeader(token) {
  const accessToken = getClineAccessToken(token);
  return accessToken ? `Bearer ${accessToken}` : "";
}

export function buildClineHeaders(token, extraHeaders = {}) {
  const authorization = getClineAuthorizationHeader(token);
  const headers = {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `9Router/${APP_VERSION}`,
    "X-PLATFORM": process.platform || "unknown",
    "X-PLATFORM-VERSION": process.version || "unknown",
    "X-CLIENT-TYPE": "9router",
    "X-CLIENT-VERSION": CLINE_SPOOF_VERSION,
    "X-CORE-VERSION": CLINE_SPOOF_VERSION,
    "X-IS-MULTIROOT": "false",
    ...extraHeaders,
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  return headers;
}
