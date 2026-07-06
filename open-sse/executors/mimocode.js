/**
 * MiMoCode Executor — Free-tier Xiaomi MiMo models via bootstrap JWT auth.
 *
 * Implements the auth flow from the official MiMo-Code repository:
 *   https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/plugin/mimo-free.ts
 *
 *   1. Generate device fingerprint from hostname + OS + arch + CPU + username
 *   2. POST /api/free-ai/bootstrap with fingerprint → JWT
 *   3. Use JWT as Bearer token for chat requests
 *   4. Custom endpoint: /api/free-ai/openai/chat (not /v1/chat/completions)
 *   5. Custom header: X-Mimo-Source: mimocode-cli-free
 *
 * Only the "mimo-auto" model is supported (1M context, 128K output).
 * Supports multiple accounts: N fingerprints → N JWTs → round-robin with cooldown.
 * On 429, account enters cooldown (exponential backoff). On 401/403, JWT is re-bootstrapped.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { BaseExecutor } from "./base";
import { createProxyDispatcher } from "../utils/proxyDispatcher";
import { fetch as undiciFetch } from "undici";
const BOOTSTRAP_PATH = "/api/free-ai/bootstrap";
const CHAT_PATH = "/api/free-ai/openai/chat";
const JWT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;
const MIMO_SOURCE = "mimocode-cli-free";

/**
 * Anti-abuse gate marker required by the Xiaomi free endpoint.
 *
 * `/api/free-ai/openai/chat` returns `403 "Illegal access"` unless the request body
 * contains a recognized MiMoCode prompt signature as a substring inside a `system`-role
 * message (verified empirically — headers, fingerprint, and JWT are not what is checked).
 * This is the canonical MiMoCode agent opener the official CLI sends, and it is on the
 * upstream allowlist. We inject it as a leading system message so user requests pass the
 * gate. The string MUST stay byte-for-byte identical — the check is case-sensitive and
 * truncations are rejected.
 */
export const MIMO_SYSTEM_MARKER = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

/**
 * Ensure the outgoing body carries the MiMoCode anti-abuse marker in a system message.
 * Idempotent: if any system message already contains the marker, the body is returned
 * unchanged. Bodies without a `messages` array are left untouched.
 */
function injectSystemMarker(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const hasMarker = messages.some(m => m != null && typeof m === "object" && m.role === "system" && typeof m.content === "string" && m.content.includes(MIMO_SYSTEM_MARKER));
  if (hasMarker) return body;
  return {
    ...body,
    messages: [{
      role: "system",
      content: MIMO_SYSTEM_MARKER
    }, ...messages]
  };
}
const USER_AGENTS = ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"];

// ── Account State ──────────────────────────────────────────────────────────

/** Per-account proxy configuration, passed through providerSpecificData.accountProxies. */

function parseJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return Date.now() + 50 * 60 * 1000;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return (payload.exp ?? Math.floor(Date.now() / 1000) + 3000) * 1000;
  } catch {
    return Date.now() + 50 * 60 * 1000;
  }
}
function isAccountReady(account) {
  if (account.cooldownUntil > Date.now()) return false;
  if (account.jwt && account.expiresAt - Date.now() > JWT_REFRESH_BUFFER_MS) return true;
  return false;
}

// ── Fingerprint Generation ─────────────────────────────────────────────────

function getCpuModel() {
  try {
    const cpus = os.cpus();
    if (cpus.length > 0 && cpus[0].model) return cpus[0].model.trim();
  } catch {
    /* ignore */
  }
  return "unknown-cpu";
}
export function generateFingerprint(seed) {
  if (seed) return crypto.createHash("sha256").update(seed).digest("hex");
  const hostname = os.hostname();
  const platform = os.platform();
  const arch = os.arch();
  const cpu = getCpuModel();
  let username = "unknown-user";
  try {
    username = os.userInfo().username;
  } catch {
    /* ignore */
  }
  return crypto.createHash("sha256").update(`${hostname}|${platform}|${arch}|${cpu}|${username}`).digest("hex");
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

const bootstrapInflight = new Map();
async function bootstrapJwt(baseUrl, fingerprint, signal, dispatcher) {
  const existing = bootstrapInflight.get(fingerprint);
  if (existing) return existing;
  const url = `${baseUrl}${BOOTSTRAP_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOTSTRAP_TIMEOUT_MS);
  const onSignal = signal ? () => controller.abort(signal.reason) : null;
  if (signal && onSignal) signal.addEventListener("abort", onSignal, {
    once: true
  });
  const promise = (async () => {
    try {
      const resp = dispatcher ? await undiciFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client: fingerprint
        }),
        signal: controller.signal,
        dispatcher
      }) : await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client: fingerprint
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Bootstrap failed: ${resp.status} ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      if (!data.jwt) throw new Error("Bootstrap response missing jwt field");
      return {
        jwt: data.jwt,
        expiresAt: parseJwtExp(data.jwt)
      };
    } finally {
      clearTimeout(timer);
      if (signal && onSignal) signal.removeEventListener("abort", onSignal);
      bootstrapInflight.delete(fingerprint);
    }
  })();
  bootstrapInflight.set(fingerprint, promise);
  return promise;
}

// ── Model Rewriting ────────────────────────────────────────────────────────

function rewriteModelName(model) {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

// ── Executor ───────────────────────────────────────────────────────────────

export class MimocodeExecutor extends BaseExecutor {
  accounts = [];
  nextAccountIdx = 0;
  baseUrl;
  proxyUrlMap = new Map();
  static encoder = new TextEncoder();
  constructor() {
    super("mimocode", {
      format: "openai"
    });
    this.baseUrl = this.getBaseUrls()[0] || "https://api.xiaomimimo.com";
    this.accounts.push({
      fingerprint: generateFingerprint(),
      jwt: "",
      expiresAt: 0,
      cooldownUntil: 0,
      consecutiveFails: 0,
      // #3837/#5521 backward compat: default the per-account proxy to null (not undefined),
      // mirroring the syncAccountsFromCredentials() account builder, so an executor with no
      // accountProxies config still exposes `acct.proxy === null` on every account.
      proxy: null
    });
  }
  getProxyDispatcher(fingerprint) {
    const proxyUrl = this.proxyUrlMap.get(fingerprint);
    if (!proxyUrl) return undefined;
    return createProxyDispatcher(proxyUrl);
  }
  fetchWithProxy(url, init, fingerprint) {
    const dispatcher = this.getProxyDispatcher(fingerprint);
    if (dispatcher) {
      // undici fetch returns undici.Response which is structurally compatible with
      // the global Response but nominally different — same pattern as proxyFetch.ts
      const undiciFn = undiciFetch;
      return undiciFn(url, {
        ...init,
        dispatcher
      });
    }
    return fetch(url, init);
  }
  syncAccountsFromCredentials(credentials) {
    const psd = credentials?.providerSpecificData;
    const fingerprints = psd?.fingerprints;
    const accountProxies = psd?.accountProxies;

    // #5521: build the per-fingerprint proxy URL map that getProxyDispatcher() consumes
    // to route each account's traffic through its own SOCKS5/HTTP dispatcher.
    if (Array.isArray(accountProxies)) {
      for (const entry of accountProxies) {
        if (entry?.fingerprint && entry?.proxy?.host) {
          const {
            type = "socks5",
            host,
            port,
            username,
            password
          } = entry.proxy;
          const resolvedPort = port ?? (type === "socks5" ? 1080 : 8080);
          const auth = username ? `${encodeURIComponent(username)}:${password ? encodeURIComponent(password) : ""}@` : "";
          this.proxyUrlMap.set(entry.fingerprint, `${type}://${auth}${host}:${resolvedPort}`);
        }
      }
    }

    // #3837: register any newly-advertised fingerprints as accounts.
    if (Array.isArray(fingerprints)) {
      const existing = new Set(this.accounts.map(a => a.fingerprint));
      for (const fp of fingerprints) {
        if (typeof fp === "string" && !existing.has(fp)) {
          this.accounts.push({
            fingerprint: fp,
            jwt: "",
            expiresAt: 0,
            cooldownUntil: 0,
            consecutiveFails: 0,
            proxy: null
          });
          existing.add(fp);
        }
      }
      // Prune accounts whose fingerprint was removed from credentials so
      // pickAccount() does not keep cycling through stale/dead entries.
      const live = new Set(fingerprints.filter(fp => typeof fp === "string"));
      this.accounts = this.accounts.filter(a => live.has(a.fingerprint));
      // Keep nextAccountIdx in bounds after pruning.
      if (this.accounts.length > 0) {
        this.nextAccountIdx = this.nextAccountIdx % this.accounts.length;
      } else {
        this.nextAccountIdx = 0;
      }
    }

    // #3837: resolve each account's structured proxy config from accountProxies.
    const proxyMap = Array.isArray(accountProxies) ? new Map(accountProxies.map(ap => [ap.fingerprint, ap.proxy])) : null;
    for (const acct of this.accounts) {
      if (proxyMap) {
        const entry = proxyMap.get(acct.fingerprint);
        acct.proxy = entry !== undefined ? entry ?? null : null;
      } else {
        acct.proxy = null;
      }
    }
  }
  async getJwtForAccount(account, signal) {
    if (isAccountReady(account)) return account.jwt;
    const dispatcher = this.getProxyDispatcher(account.fingerprint);
    const result = await bootstrapJwt(this.baseUrl, account.fingerprint, signal, dispatcher);
    account.jwt = result.jwt;
    account.expiresAt = result.expiresAt;
    return account.jwt;
  }
  pickAccount() {
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.nextAccountIdx + i) % this.accounts.length;
      const acct = this.accounts[idx];
      if (isAccountReady(acct)) {
        this.nextAccountIdx = (idx + 1) % this.accounts.length;
        return acct;
      }
    }
    const fallbackIdx = this.nextAccountIdx % this.accounts.length;
    this.nextAccountIdx = (this.nextAccountIdx + 1) % this.accounts.length;
    return this.accounts[fallbackIdx];
  }
  markCooldown(account) {
    account.consecutiveFails++;
    const backoff = Math.min(COOLDOWN_BASE_MS * Math.pow(2, account.consecutiveFails - 1), COOLDOWN_MAX_MS);
    account.cooldownUntil = Date.now() + backoff + Math.random() * 1000;
  }
  markSuccess(account) {
    account.consecutiveFails = 0;
  }
  buildUrl(_model, _stream, _urlIndex = 0, _credentials) {
    return `${this.baseUrl.replace(/\/$/, "")}${CHAT_PATH}`;
  }
  buildHeaders(_credentials, stream = true, _clientHeaders, _model) {
    const headers = {
      "Content-Type": "application/json",
      "X-Mimo-Source": MIMO_SOURCE,
      "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    };
    if (stream) headers["Accept"] = "text/event-stream, application/json";
    return headers;
  }
  transformRequest(model, body, _stream, _credentials) {
    if (typeof body === "object" && body !== null) {
      const withModel = {
        ...body,
        model: rewriteModelName(model)
      };
      return injectSystemMarker(withModel);
    }
    return body;
  }
  async testConnection(_credentials, _signal, log) {
    try {
      this.syncAccountsFromCredentials(_credentials);
      const account = this.accounts[0];
      const jwt = await this.getJwtForAccount(account, _signal);
      const resp = await this.fetchWithProxy(this.buildUrl("mimo-auto", false), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
          "X-Mimo-Source": MIMO_SOURCE
        },
        body: JSON.stringify(injectSystemMarker({
          model: "mimo-auto",
          messages: [{
            role: "user",
            content: "ping"
          }],
          stream: false
        })),
        signal: _signal ?? undefined
      }, account.fingerprint);
      return resp.status === 200;
    } catch {
      log?.warn?.("MIMOCODE", "testConnection network error");
      return false;
    }
  }
  async execute(input) {
    const {
      model,
      stream,
      body,
      signal,
      log
    } = input;
    const encoder = MimocodeExecutor.encoder;
    if (signal?.aborted) {
      return {
        response: new Response(encoder.encode(JSON.stringify({
          error: {
            message: "Request aborted",
            type: "abort",
            code: "ABORTED"
          }
        })), {
          status: 499,
          headers: {
            "Content-Type": "application/json"
          }
        }),
        url: this.buildUrl(model, stream),
        headers: this.buildHeaders(input.credentials, stream),
        transformedBody: body
      };
    }
    const url = this.buildUrl(model, stream);
    const reqBody = this.transformRequest(model, body, stream, input.credentials);
    this.syncAccountsFromCredentials(input.credentials);

    // Try each account, skip cooldown ones
    for (let attempt = 0; attempt < this.accounts.length; attempt++) {
      const account = this.pickAccount();
      try {
        const jwt = await this.getJwtForAccount(account, signal);
        const headers = this.buildHeaders(input.credentials, stream);
        headers["Authorization"] = `Bearer ${jwt}`;
        let resp = await this.fetchWithProxy(url, {
          method: "POST",
          headers,
          body: JSON.stringify(reqBody),
          signal: signal ?? undefined
        }, account.fingerprint);

        // On auth failure, re-bootstrap this account and retry once
        if (resp.status === 401 || resp.status === 403) {
          log?.warn?.("MIMOCODE", `Auth failed (${resp.status}) on account ${account.fingerprint.slice(0, 8)}…`);
          account.jwt = "";
          account.expiresAt = 0;
          account.consecutiveFails = 0;
          const freshJwt = await this.getJwtForAccount(account, signal);
          headers["Authorization"] = `Bearer ${freshJwt}`;
          resp = await this.fetchWithProxy(url, {
            method: "POST",
            headers,
            body: JSON.stringify(reqBody),
            signal: signal ?? undefined
          }, account.fingerprint);
        }
        if (resp.status === 429) {
          this.markCooldown(account);
          log?.warn?.("MIMOCODE", `Rate limited on account ${account.fingerprint.slice(0, 8)}, trying next…`);
          continue;
        }
        this.markSuccess(account);
        const respHeaders = {};
        resp.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });
        return {
          response: resp,
          url,
          headers: respHeaders,
          transformedBody: reqBody
        };
      } catch (err) {
        this.markCooldown(account);
        if (attempt === this.accounts.length - 1) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.error?.("MIMOCODE", `Executor error: ${msg}`);
          return {
            response: new Response(encoder.encode(JSON.stringify({
              error: {
                message: msg,
                type: "upstream_error",
                code: "EXECUTOR_ERROR"
              }
            })), {
              status: 502,
              headers: {
                "Content-Type": "application/json"
              }
            }),
            url,
            headers: this.buildHeaders(input.credentials, stream),
            transformedBody: body
          };
        }
      }
    }
    return {
      response: new Response(encoder.encode(JSON.stringify({
        error: {
          message: "All accounts exhausted",
          type: "upstream_error",
          code: "NO_ACCOUNTS"
        }
      })), {
        status: 502,
        headers: {
          "Content-Type": "application/json"
        }
      }),
      url,
      headers: this.buildHeaders(input.credentials, stream),
      transformedBody: body
    };
  }
}
export default MimocodeExecutor;