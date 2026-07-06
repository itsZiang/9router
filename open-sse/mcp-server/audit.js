/**
 * MCP Audit Logger — Records all MCP tool invocations for security and observability.
 *
 * Logs are written to the `mcp_tool_audit` SQLite table.
 * Input data is hashed (SHA-256) to avoid storing sensitive prompts.
 * Output is truncated to 200 chars for summary.
 */

import { hashInput, summarizeOutput } from "./schemas/audit";
import { isNativeSqliteLoadError } from "../stubs/lib/db/core";

// ============ Database Connection ============

/**
 * node:sqlite's `DatabaseSync` does NOT expose a boolean `open` property —
 * `open` and `close` are methods on the prototype, and the only state
 * surface is the `isOpen` getter. Track open state locally in a closure
 * so the adapter's `AuditDatabase` contract (`open?: boolean`) is honored
 * and `getCachedAuditDb()`'s truthy check doesn't return a closed handle
 * after `closeAuditDb()`.
 */
function createNodeSqliteAuditAdapter(db) {
  let _isOpen = true;
  return {
    driver: "node:sqlite",
    get open() {
      return _isOpen;
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
        run: (...params) => stmt.run(...params)
      };
    },
    pragma(pragmaSql) {
      // node:sqlite has no .pragma() helper — route through .exec() for
      // statement-shaped PRAGMAs (e.g. "wal_checkpoint(TRUNCATE)").
      try {
        db.exec(`PRAGMA ${pragmaSql}`);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    close: () => {
      if (!_isOpen) return;
      try {
        db.close();
      } finally {
        _isOpen = false;
      }
    }
  };
}
function toNullableString(value) {
  return typeof value === "string" ? value : null;
}
function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}
function toPositiveInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}
function mapAuditEntry(row) {
  return {
    id: toPositiveInt(row.id, 0),
    toolName: toString(row.tool_name),
    inputHash: toString(row.input_hash),
    outputSummary: toString(row.output_summary),
    durationMs: toNumber(row.duration_ms, 0),
    apiKeyId: toNullableString(row.api_key_id),
    success: toBoolean(row.success, false),
    errorCode: toNullableString(row.error_code),
    createdAt: toString(row.created_at)
  };
}
function buildAuditFilterSql(filters) {
  const clauses = [];
  const params = [];
  if (typeof filters.tool === "string" && filters.tool.trim().length > 0) {
    clauses.push("tool_name = ?");
    params.push(filters.tool.trim());
  }
  if (typeof filters.success === "boolean") {
    clauses.push("success = ?");
    params.push(filters.success ? 1 : 0);
  }
  if (typeof filters.apiKeyId === "string" && filters.apiKeyId.trim().length > 0) {
    clauses.push("api_key_id = ?");
    params.push(filters.apiKeyId.trim());
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}
function getCachedAuditDb() {
  return globalThis.__omnirouteMcpAuditDb ?? null;
}
function setCachedAuditDb(database) {
  globalThis.__omnirouteMcpAuditDb = database;
}
function toNumber(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function toString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Lazy-load the database connection.
 * Uses the same SQLite database as the main OmniRoute app.
 *
 * Driver priority:
 *   1. better-sqlite3 — fast native binding (when its compiled `.node`
 *      binary is present, see scripts/build/postinstall.mjs).
 *   2. node:sqlite    — built-in to Node 22.5+. Used as a transparent
 *      fallback so the MCP audit logger still works on installs where
 *      the better-sqlite3 binary failed to resolve (e.g. missing
 *      `dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
 *      in some global-install / Docker scenarios).
 */
async function getDb() {
  const cachedDb = getCachedAuditDb();
  if (cachedDb) return cachedDb;
  try {
    // Try importing the db module from the main app
    const {
      homedir
    } = await import("node:os");
    const {
      join
    } = await import("node:path");
    const {
      existsSync
    } = await import("node:fs");
    const dbPath = process.env.DATA_DIR ? join(process.env.DATA_DIR, "storage.sqlite") : join(homedir(), ".omniroute", "storage.sqlite");
    if (!existsSync(dbPath)) {
      console.error(`[MCP Audit] Database not found at ${dbPath} — audit logging disabled`);
      return null;
    }

    // Try better-sqlite3 first (matches the main app's default driver).
    try {
      const Database = (await import("better-sqlite3")).default;
      const database = new Database(dbPath);
      setCachedAuditDb(database);
      return database;
    } catch (nativeErr) {
      // Declared once at the top of the catch: nativeMessage is read both on
      // the non-fallback bail-out and in the node:sqlite fallback warning
      // further down. A block-scoped const inside the `if` below would be out
      // of scope in the fallback path.
      const nativeMessage = nativeErr instanceof Error ? nativeErr.message : String(nativeErr);
      // Reuse the canonical detection helper from the main app's DB layer
      // so we cover every ABI/binding failure mode the rest of the codebase
      // already knows about: missing MODULE_NOT_FOUND, ERR_DLOPEN_FAILED,
      // "Module did not self-register", "Cannot find module 'better-sqlite3'",
      // the standard V8 "was compiled against a different Node.js version"
      // message, and the bindings-loader "Could not locate the bindings file".
      // Real errors (corrupt db, permission denied) still surface to the operator.
      if (!isNativeSqliteLoadError(nativeErr)) {
        console.error("[MCP Audit] Failed to connect to database:", nativeMessage);
        return null;
      }
      // Fall back to Node's built-in sqlite (Node 22.5+).
      const [maj, min] = (process.versions.node ?? "0.0").split(".").map(Number);
      if (maj < 22 || maj === 22 && (min ?? 0) < 5) {
        console.error(`[MCP Audit] better-sqlite3 native binding unavailable and Node ${process.version} ` + "has no built-in sqlite. Audit logging disabled. Fix: run " + "`npm rebuild better-sqlite3` in the omniroute install root.");
        return null;
      }
      try {
        const {
          DatabaseSync
        } = await import("node:sqlite");
        const nodeDb = new DatabaseSync(dbPath);
        const adapter = createNodeSqliteAuditAdapter(nodeDb);
        setCachedAuditDb(adapter);
        console.warn(`[MCP Audit] better-sqlite3 binding unavailable — fell back to node:sqlite ` + `(${nativeMessage.split("\n")[0]})`);
        return adapter;
      } catch (nodeErr) {
        const nodeMessage = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
        console.error("[MCP Audit] Failed to connect to database:", nodeMessage);
        return null;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to connect to database:", message);
    return null;
  }
}
export function closeAuditDb() {
  const database = getCachedAuditDb();
  if (!database) return false;
  setCachedAuditDb(null);
  try {
    try {
      if (database.open !== false) {
        database.pragma("wal_checkpoint(TRUNCATE)");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MCP Audit] WAL checkpoint failed during close:", message);
    }
  } finally {
    try {
      database.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MCP Audit] Failed to close database:", message);
    }
  }
  return true;
}

// ============ Audit Logger ============

/**
 * Log a tool invocation to the mcp_tool_audit table.
 *
 * Security: Input is hashed, never stored in clear text.
 * Output is truncated to a summary.
 */
export async function logToolCall(toolName, input, output, durationMs, success, errorCode) {
  try {
    const database = await getDb();
    if (!database) return; // Audit disabled if no DB

    const inputHash = await hashInput(input);
    const outputSummary = summarizeOutput(output);
    const apiKeyId = process.env.OMNIROUTE_API_KEY_ID || null;
    database.prepare(`INSERT INTO mcp_tool_audit (tool_name, input_hash, output_summary, duration_ms, api_key_id, success, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(toolName, inputHash, outputSummary, durationMs, apiKeyId, success ? 1 : 0, errorCode || null);
  } catch (err) {
    // Never let audit failure break tool execution
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to log:", message);
  }
}

/**
 * Get recent audit entries (for dashboard/monitoring).
 */
export async function queryAuditEntries(filters = {}) {
  try {
    const database = await getDb();
    const limit = Math.max(1, Math.min(500, toPositiveInt(filters.limit, 50)));
    const offset = Math.max(0, toPositiveInt(filters.offset, 0));
    if (!database) return {
      entries: [],
      total: 0,
      limit,
      offset
    };
    const {
      whereSql,
      params
    } = buildAuditFilterSql(filters);
    const totalRow = database.prepare(`SELECT COUNT(*) as total FROM mcp_tool_audit ${whereSql}`).get(...params);
    const rows = database.prepare(`SELECT
           id,
           tool_name,
           input_hash,
           output_summary,
           duration_ms,
           api_key_id,
           success,
           error_code,
           created_at
         FROM mcp_tool_audit
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {
      entries: rows.map(mapAuditEntry),
      total: toPositiveInt(totalRow?.total, 0),
      limit,
      offset
    };
  } catch {
    return {
      entries: [],
      total: 0,
      limit: 50,
      offset: 0
    };
  }
}

/**
 * Backward compatible helper for existing callers.
 */
export async function getRecentAuditEntries(limit = 50) {
  const result = await queryAuditEntries({
    limit,
    offset: 0
  });
  return result.entries;
}

/**
 * Get audit stats for monitoring.
 */
export async function getAuditStats() {
  try {
    const database = await getDb();
    if (!database) return {
      totalCalls: 0,
      successRate: 0,
      avgDurationMs: 0,
      topTools: []
    };
    const stats = database.prepare(`SELECT 
           COUNT(*) as total,
           AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as successRate,
           AVG(duration_ms) as avgDuration
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')`).get();
    const topTools = database.prepare(`SELECT tool_name as tool, COUNT(*) as count
         FROM mcp_tool_audit
         WHERE created_at > datetime('now', '-24 hours')
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`).all();
    return {
      totalCalls: toNumber(stats?.total, 0),
      successRate: toNumber(stats?.successRate, 0),
      avgDurationMs: toNumber(stats?.avgDuration, 0),
      topTools: (topTools || []).map(entry => ({
        tool: toString(entry.tool),
        count: toNumber(entry.count, 0)
      }))
    };
  } catch {
    return {
      totalCalls: 0,
      successRate: 0,
      avgDurationMs: 0,
      topTools: []
    };
  }
}