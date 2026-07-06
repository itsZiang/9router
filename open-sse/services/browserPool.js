/**
 * browserPool.ts — Shared stealth browser pool for web-cookie providers.
 *
 * The DuckDuckGo VQD challenge and Claude web's Cloudflare Turnstile both
 * validate values that only a real browser can produce (DOM layout
 * measurements like offsetWidth/Height, getBoundingClientRect,
 * getComputedStyle, iframe contentWindow probes). Plain Node fetch + a
 * VM-stubs solver structurally runs the JS but cannot match those values,
 * so the server rejects the request.
 *
 * This pool keeps one Chromium instance warm and serves "browser contexts"
 * (one per provider) on demand. Each context owns one or more pages; the
 * caller is expected to be polite (one page per request, close on done).
 *
 * The pool prefers `cloakbrowser` (npm) when available — its binary-level
 * fingerprint patches (--fingerprint-timezone, --fingerprint-locale, and
 * dozens more) are the only thing that gets past DuckDuckGo's anti-bot
 * in this environment. Falls back to plain `playwright` if cloakbrowser
 * is not installed; the fallback works for Claude web (which only needs
 * valid cookies) but not for DDG's VQD challenge.
 *
 * Opt-in: pool only launches Chromium when an executor explicitly asks
 * for a context, so users who never use the browser-backed path pay zero
 * startup cost. Set OMNIROUTE_BROWSER_POOL=off to fully disable.
 */

import { Buffer } from "node:buffer";

// #3368 PR7 — lightweight, cumulative browser-pool telemetry. Counters are
// incremented at lifecycle points and surfaced via getBrowserPoolMetrics()
// (and the omniroute_browser_pool_status MCP tool), giving the previously
// caller-less getBrowserPoolStatus() an observability home.

function createBrowserPoolMetrics() {
  return {
    browserLaunches: 0,
    browserLaunchFailures: 0,
    contextsCreated: 0,
    contextsReused: 0,
    contextsEvicted: 0,
    contextsReleased: 0,
    contextCreateFailures: 0,
    shutdowns: 0,
    lastShutdownReason: null
  };
}
const POOL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 min — evict stale contexts
const EVICT_INTERVAL_MS = 60 * 1000; // check every 60s
const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const state = {
  browser: null,
  contexts: new Map(),
  pendingContexts: new Map(),
  launching: null,
  lastActivity: 0,
  idleTimer: null,
  evictTimer: null,
  cloakLaunch: null,
  cloakLaunchResolved: false,
  metrics: createBrowserPoolMetrics()
};
function getCloakbrowserModuleId() {
  // Keep this computed: cloakbrowser is an optional runtime enhancer, and a literal
  // dynamic import with the package name makes Turbopack resolve it during route compilation.
  return ["cloak", "browser"].join("");
}
async function resolveCloakLaunch() {
  if (state.cloakLaunchResolved) return state.cloakLaunch;
  state.cloakLaunchResolved = true;
  try {
    // webpackIgnore tells webpack not to statically analyse this import —
    // cloakbrowser is an optional runtime-only package, intentionally resolved
    // at runtime so Turbopack/webpack never tries to bundle it.
    const mod = await import(/* webpackIgnore: true */ getCloakbrowserModuleId());
    state.cloakLaunch = mod.launch ?? null;
  } catch {
    state.cloakLaunch = null;
  }
  return state.cloakLaunch;
}
function isPoolEnabled() {
  const flag = process.env.OMNIROUTE_BROWSER_POOL;
  if (flag === undefined) return true;
  return flag !== "off" && flag !== "0" && flag !== "false";
}
function resetIdleTimer() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    void shutdownPool("idle-timeout");
  }, POOL_IDLE_TIMEOUT_MS);
  state.idleTimer.unref?.();
}
function evictStaleContexts() {
  const now = Date.now();
  for (const [key, pooled] of state.contexts) {
    if (now - pooled.lastUsed > CONTEXT_TTL_MS) {
      console.log("[BrowserPool] Evicted stale context:", key, "(idle", ((now - pooled.lastUsed) / 1000).toFixed(0) + "s)");
      state.contexts.delete(key);
      state.metrics.contextsEvicted++;
      pooled.context.close().catch(() => {});
    }
  }
  if (state.contexts.size === 0 && !state.launching) {
    void shutdownPool("all-contexts-evicted");
  }
}
function startEvictTimer() {
  if (state.evictTimer) clearInterval(state.evictTimer);
  state.evictTimer = setInterval(() => evictStaleContexts(), EVICT_INTERVAL_MS);
  state.evictTimer.unref?.();
}
// Exported for tests (deps injection avoids mock.module()).
export async function resolvePlaywrightProxy(providerKey, deps) {
  try {
    const resolver = deps?.resolveProxy ?? (async id => {
      const {
        resolveProxyForProvider
      } = await import("../stubs/lib/db/proxies");
      return resolveProxyForProvider(id);
    });
    const p = await resolver(providerKey);
    if (!p?.host) return undefined;
    const scheme = p.type === "socks5" ? "socks5" : "http";
    // Build explicitly instead of a conditional object spread: the spread form
    // widens username/password to `{}` under the LaunchOptions["proxy"] type,
    // tripping typecheck once browserPool.ts is pulled into typecheck-core scope.
    const proxy = {
      server: `${scheme}://${p.host}:${p.port}`
    };
    if (p.username) {
      proxy.username = String(p.username);
      proxy.password = p.password == null ? "" : String(p.password);
    }
    return proxy;
  } catch (err) {
    console.warn("[BrowserPool] Failed to resolve proxy from DB:", err);
    return undefined;
  }
}
async function launchBrowser() {
  if (state.browser) return state.browser;
  if (state.launching) return state.launching;
  state.launching = (async () => {
    const cloakLaunch = await resolveCloakLaunch();
    let browser;
    if (cloakLaunch) {
      browser = await cloakLaunch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
      });
    } else {
      // Fallback: plain Playwright. Works for Claude web (cookie-only
      // auth) but DDG's VQD challenge will detect this Chromium build.
      const {
        chromium
      } = await import("playwright");
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
      });
    }
    state.browser = browser;
    state.launching = null;
    state.metrics.browserLaunches++;
    return browser;
  })();
  try {
    return await state.launching;
  } catch (err) {
    state.launching = null;
    state.metrics.browserLaunchFailures++;
    throw err;
  }
}
function parseCookieString(raw, domain) {
  return raw.split(";").map(p => p.trim()).filter(Boolean).map(pair => {
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) return null;
    return {
      name,
      value,
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax"
    };
  }).filter(Boolean);
}

// Clear a key from the pending-creation map once its promise settles, counting
// failures. Kept as a leaf helper so acquireBrowserContext stays under the
// function-length ceiling (#3368 PR7 metrics).
function settlePendingContext(key, failed) {
  if (failed) state.metrics.contextCreateFailures++;
  state.pendingContexts.delete(key);
}
export async function acquireBrowserContext(key, options) {
  if (!isPoolEnabled()) {
    throw new Error("browserPool: OMNIROUTE_BROWSER_POOL=off — context requested but pool is disabled");
  }
  const existing = state.contexts.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    state.lastActivity = Date.now();
    state.metrics.contextsReused++;
    resetIdleTimer();
    return existing;
  }

  // Dedup concurrent creations for the same key
  const pending = state.pendingContexts.get(key);
  if (pending) return pending;
  const createPromise = (async () => {
    const [browser, proxy] = await Promise.all([launchBrowser(), resolvePlaywrightProxy(key)]);
    const isStealth = state.cloakLaunch !== null;
    const context = await browser.newContext({
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      locale: options.locale || "en-US",
      timezoneId: options.timezone || "America/New_York",
      viewport: {
        width: 1280,
        height: 800
      },
      ...(proxy ? {
        proxy
      } : {})
    });
    if (options.cookieString) {
      const cookies = parseCookieString(options.cookieString, options.cookieDomain);
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }
    let warmupPage = null;
    if (options.warmupUrl) {
      try {
        warmupPage = await context.newPage();
        await warmupPage.goto(options.warmupUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
        // Give the warmup a moment for the upstream's status/auth/country
        // JSON endpoints to fire. Without this, the first chat request would
        // pay the warmup cost on the hot path.
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        try {
          await warmupPage?.close();
        } catch {
          /* ignore */
        }
        warmupPage = null;
        void err;
      }
    }

    // Guard: if shutdownPool() ran while we were creating this context,
    // the browser we obtained is now closed. Close our temp context and
    // throw so the caller knows to retry.
    if (state.browser !== browser) {
      await context.close().catch(() => {});
      if (warmupPage) {
        await warmupPage.close().catch(() => {});
      }
      throw new Error("Pool shut down during context creation");
    }
    const pooled = {
      id: key,
      context,
      warmupPage,
      lastUsed: Date.now(),
      isStealth
    };
    state.contexts.set(key, pooled);
    state.metrics.contextsCreated++;
    state.lastActivity = Date.now();
    resetIdleTimer();
    startEvictTimer();
    return pooled;
  })();
  state.pendingContexts.set(key, createPromise);
  createPromise.then(() => settlePendingContext(key, false)).catch(() => settlePendingContext(key, true));
  return createPromise;
}
export async function openPage(pooled) {
  return pooled.context.newPage();
}
export async function releaseBrowserContext(key) {
  const pooled = state.contexts.get(key);
  if (!pooled) return;
  state.contexts.delete(key);
  state.metrics.contextsReleased++;
  try {
    await pooled.context.close();
  } catch {
    /* ignore */
  }
  if (state.contexts.size === 0) {
    await shutdownPool("last-context-closed");
  }
}
export async function shutdownPool(reason) {
  state.metrics.shutdowns++;
  state.metrics.lastShutdownReason = reason;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.evictTimer) {
    clearInterval(state.evictTimer);
    state.evictTimer = null;
  }
  state.pendingContexts.clear();
  for (const [key, pooled] of state.contexts) {
    try {
      await pooled.context.close();
    } catch {
      /* ignore */
    }
    state.contexts.delete(key);
  }
  if (state.browser) {
    try {
      await state.browser.close();
    } catch {
      /* ignore */
    }
    state.browser = null;
  }
  state.lastActivity = Date.now();
  // Avoid unused-parameter lint: log reason via debug if anyone hooks
  // process.on('exit') and prints state.
  void reason;
}
export function getBrowserPoolStatus() {
  return {
    enabled: isPoolEnabled(),
    contexts: state.contexts.size,
    browserRunning: state.browser !== null,
    stealthAvailable: state.cloakLaunch !== null,
    lastActivityAgoMs: state.lastActivity === 0 ? -1 : Date.now() - state.lastActivity
  };
}

/**
 * #3368 PR7 — browser-pool observability. Returns live status plus cumulative
 * lifecycle telemetry (launches, context create/reuse/evict/release counts,
 * failures, shutdowns). Surfaced via the omniroute_browser_pool_status MCP tool.
 */
export function getBrowserPoolMetrics() {
  return {
    status: getBrowserPoolStatus(),
    metrics: {
      ...state.metrics
    }
  };
}

/** Test-only: reset cumulative metrics so assertions start from a clean slate. */
export function __resetBrowserPoolMetricsForTest() {
  state.metrics = createBrowserPoolMetrics();
}
export async function readPageResponseBody(response) {
  const headers = {};
  for (const [name, value] of Object.entries(response.headers())) {
    headers[name] = value;
  }
  const body = await response.body();
  return {
    status: response.status(),
    headers,
    body: Buffer.from(body)
  };
}