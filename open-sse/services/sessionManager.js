/**
 * Session Fingerprinting — Phase 5
 *
 * Generates stable session IDs for sticky routing,
 * prompt caching, and per-session tracking.
 */

import { createHash } from "node:crypto";
// In-memory session store with metadata
// key: sessionId → { createdAt, lastActive, requestCount, connectionId? }
const sessions = new Map();

// Hard cap on active sessions to prevent memory exhaustion
const MAX_SESSIONS = 200;

// Auto-cleanup sessions older than 15 minutes (reduced from 30)
const SESSION_TTL_MS = 15 * 60 * 1000;
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  // Evict expired sessions
  for (const [key, entry] of sessions) {
    if (now - entry.lastActive > SESSION_TTL_MS) {
      sessions.delete(key);
      const keysToDelete = [];
      for (const [apiKeyId, sessionSet] of activeSessionsByKey) {
        sessionSet.delete(key);
        if (sessionSet.size === 0) keysToDelete.push(apiKeyId);
      }
      for (const k of keysToDelete) {
        activeSessionsByKey.delete(k);
      }
    }
  }
  // Hard cap: evict oldest if over limit
  while (sessions.size > MAX_SESSIONS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of sessions) {
      if (entry.lastActive < oldestTime) {
        oldestTime = entry.lastActive;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    sessions.delete(oldestKey);
    const evictionKeys = [];
    for (const [apiKeyId, sessionSet] of activeSessionsByKey) {
      sessionSet.delete(oldestKey);
      if (sessionSet.size === 0) evictionKeys.push(apiKeyId);
    }
    for (const k of evictionKeys) {
      activeSessionsByKey.delete(k);
    }
  }
}, 60_000);
if (typeof _cleanupTimer === "object" && "unref" in _cleanupTimer) {
  _cleanupTimer.unref?.();
}

/**
 * Generate a stable session fingerprint from request characteristics.
 * Same client + same conversation → same session ID.
 *
 * Fingerprint factors:
 * - System prompt hash (stable per conversation/tool)
 * - First user message hash (stable per conversation)
 * - Model name
 * - Provider (optional)
 * - Tools signature (sorted tool names)
 *
 * @param {object} body - Request body
 * @param {object} [options] - Extra context
 * @returns {string} Session ID (hex hash)
 */
export function generateSessionId(body, options = {}) {
  if (!body || typeof body !== "object") return null;
  const parts = [];

  // Model contributes to fingerprint
  if (body.model) parts.push(`model:${body.model}`);

  // Provider binding
  if (options.provider) parts.push(`provider:${options.provider}`);

  // System prompt hash (first 32 chars of system content)
  const systemPrompt = extractSystemPrompt(body);
  if (systemPrompt) {
    parts.push(`sys:${hashShort(systemPrompt)}`);
  }

  // First user message hash (identifies the conversation)
  const firstUser = extractFirstUserMessage(body);
  if (firstUser) {
    parts.push(`user0:${hashShort(firstUser)}`);
  }

  // Tools signature (sorted names)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const toolNames = body.tools.map(t => t.name || t.function?.name || "").filter(Boolean).sort().join(",");
    if (toolNames) parts.push(`tools:${hashShort(toolNames)}`);
  }

  // Connection ID for sticky routing
  if (options.connectionId) parts.push(`conn:${options.connectionId}`);
  if (parts.length === 0) return null;
  const fingerprint = parts.join("|");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

/**
 * Touch or create a session
 */
export function touchSession(sessionId, connectionId = null) {
  if (!sessionId) return;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    existing.requestCount++;
    if (connectionId) existing.connectionId = connectionId;
  } else {
    sessions.set(sessionId, {
      createdAt: Date.now(),
      lastActive: Date.now(),
      requestCount: 1,
      connectionId
    });
  }
}

/**
 * Persist the tool-finish timestamp so Request 2 (the follow-up after tool execution)
 * can measure cross-request TTFT.
 */
export function markToolFinish(sessionId) {
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  if (session) session.lastToolFinishAt = Date.now();
}

/**
 * Consume the previously persisted tool-finish timestamp (one-shot: clears after read).
 * Returns null if no pending timestamp or session not found.
 */
export function consumeToolFinishTime(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session?.lastToolFinishAt) return null;
  const ts = session.lastToolFinishAt;
  session.lastToolFinishAt = undefined;
  return ts;
}

/**
 * Get session info (for sticky routing decisions)
 */
export function getSessionInfo(sessionId) {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.lastActive > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return {
    ...entry
  };
}

/**
 * Get the bound connection for a session (sticky routing)
 */
export function getSessionConnection(sessionId) {
  const info = getSessionInfo(sessionId);
  return info?.connectionId || null;
}

/**
 * Get session count (for dashboard)
 */
export function getActiveSessionCount() {
  return sessions.size;
}

/**
 * Get all active sessions (for dashboard)
 */
export function getActiveSessions() {
  const now = Date.now();
  const result = [];
  for (const [id, entry] of sessions) {
    if (now - entry.lastActive <= SESSION_TTL_MS) {
      result.push({
        sessionId: id,
        ...entry,
        ageMs: now - entry.createdAt
      });
    }
  }
  return result;
}

/**
 * Clear all sessions (for testing)
 */
export function clearSessions() {
  sessions.clear();
  activeSessionsByKey.clear();
}

// ─── T08: Per-API-Key Session Limit ─────────────────────────────────────────
// Tracks concurrent sticky sessions per API key and enforces max_sessions limits.
// Ref: sub2api PR #634 (fix: stabilize session hash + add user-level session limit)

// Map: apiKeyId → Set<sessionId>
const activeSessionsByKey = new Map();

/**
 * T08: Get the number of currently active sessions for an API key.
 * @param apiKeyId - The API key's UUID from the database
 */
export function getActiveSessionCountForKey(apiKeyId) {
  return activeSessionsByKey.get(apiKeyId)?.size ?? 0;
}

/**
 * Snapshot of active session counts per API key.
 */
export function getAllActiveSessionCountsByKey() {
  const out = {};
  for (const [apiKeyId, sessionIds] of activeSessionsByKey) {
    out[apiKeyId] = sessionIds.size;
  }
  return out;
}

/**
 * T08: Register a session as belonging to an API key.
 * Call this after session creation is allowed (i.e., limit check passed).
 */
export function registerKeySession(apiKeyId, sessionId) {
  if (!activeSessionsByKey.has(apiKeyId)) {
    activeSessionsByKey.set(apiKeyId, new Set());
  }
  activeSessionsByKey.get(apiKeyId).add(sessionId);
}

/**
 * Check whether a given session is already registered for an API key.
 */
export function isSessionRegisteredForKey(apiKeyId, sessionId) {
  return activeSessionsByKey.get(apiKeyId)?.has(sessionId) === true;
}

/**
 * T08: Unregister a session from an API key's active set.
 * Call this when the request closes or the session TTL expires.
 */
export function unregisterKeySession(apiKeyId, sessionId) {
  activeSessionsByKey.get(apiKeyId)?.delete(sessionId);
  // Clean up empty sets to avoid memory leaks
  if (activeSessionsByKey.get(apiKeyId)?.size === 0) {
    activeSessionsByKey.delete(apiKeyId);
  }
}

/**
 * T08: Check whether adding a new session would exceed the key's max_sessions limit.
 * Returns null if allowed, or an error object to return as a 429 response.
 *
 * @param apiKeyId - The API key's UUID
 * @param maxSessions - The limit from the DB (0 = unlimited)
 */
export function checkSessionLimit(apiKeyId, maxSessions) {
  if (!maxSessions || maxSessions <= 0) return null; // unlimited
  const current = getActiveSessionCountForKey(apiKeyId);
  if (current < maxSessions) return null;
  return {
    code: "SESSION_LIMIT_EXCEEDED",
    message: `You have reached the maximum number of active sessions (${maxSessions}). ` + `Please close unused sessions or wait for them to expire.`,
    limit: maxSessions,
    current
  };
}

/**
 * T04: Extract an external session ID from request headers.
 * Accepts both hyphenated and underscore forms for Nginx compatibility.
 * Nginx drops headers with underscores by default — use `underscores_in_headers on`
 * in nginx.conf, or use X-Session-Id (hyphenated) which passes cleanly.
 *
 * Ref: sub2api README + PR #634
 *
 * @param headers - Request headers (Headers object or plain object with .get())
 * @returns External session ID with "ext:" prefix, or null
 */
export function extractExternalSessionId(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const h = headers;
  const raw = h.get("x-session-id") ??
  // Preferred: hyphenated (passes through Nginx)
  h.get("x_session_id") ??
  // Underscore variant (direct HTTP / custom clients)
  h.get("x-omniroute-session") ??
  // OmniRoute-specific form
  h.get("session-id") ??
  // Bare session-id
  null;
  if (!raw || !raw.trim()) return null;
  // Prefix "ext:" to ensure no collision with internal SHA-256 hash IDs
  return `ext:${raw.trim().slice(0, 64)}`; // max 64 chars to avoid abuse
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function hashShort(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}
function extractSystemPrompt(body) {
  if (!body || typeof body !== "object") return null;
  // Claude format: body.system
  if (body.system) {
    return typeof body.system === "string" ? body.system : JSON.stringify(body.system);
  }
  // OpenAI format: messages[0].role === "system"
  if (Array.isArray(body.messages)) {
    const sys = body.messages.find(m => m.role === "system" || m.role === "developer");
    if (sys) {
      return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
    }
  }
  return null;
}
function extractFirstUserMessage(body) {
  if (!body || typeof body !== "object") return null;
  const messages = body.messages || body.input || [];
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    if (msg.role === "user") {
      return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    }
  }
  return null;
}