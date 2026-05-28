import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

const KV_SCOPE = "keyPoolSettings";
const DEFAULT_POOL_SIZE = 30;

// In-memory cache for per-provider settings (invalidated on write)
const settingsCache = new Map(); // cacheKey → { value, expiresAt }
const CACHE_TTL_MS = 60_000; // 1 minute

// --- Pool key CRUD ---

export async function addKeysToPool(provider, keys) {
  // keys: [{ name, key }]
  const db = await getAdapter();
  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;

  db.transaction(() => {
    // Load existing keys once for reliable JS-side dedup (don't rely on result.changes)
    const existing = new Set(
      db.all(`SELECT key FROM keyPool WHERE provider = ?`, [provider]).map((r) => r.key)
    );

    for (const k of keys) {
      if (!k.key || existing.has(k.key)) { skipped++; continue; }
      db.run(
        `INSERT OR IGNORE INTO keyPool(id, provider, name, key, createdAt) VALUES(?, ?, ?, ?, ?)`,
        [uuidv4(), provider, k.name || null, k.key, now]
      );
      existing.add(k.key);
      added++;
    }
  });

  return { added, skipped };
}

// Return all keys (for internal use — prefer getPoolKeysPaged for API responses)
export async function getPoolKeys(provider) {
  const db = await getAdapter();
  return db.all(`SELECT id, provider, name, key, createdAt FROM keyPool WHERE provider = ? ORDER BY createdAt ASC`, [provider]);
}

// Paginated keys for API responses
export async function getPoolKeysPaged(provider, limit = 50, offset = 0) {
  const db = await getAdapter();
  return db.all(
    `SELECT id, provider, name, key, createdAt FROM keyPool WHERE provider = ? ORDER BY createdAt ASC LIMIT ? OFFSET ?`,
    [provider, limit, offset]
  );
}

export async function getPoolCount(provider) {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) as count FROM keyPool WHERE provider = ?`, [provider]);
  return row?.count ?? 0;
}

export async function removeKeyFromPool(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM keyPool WHERE id = ?`, [id]);
}

// Pull n keys FIFO, dedup vs existingKeys set, delete them from pool, return pulled keys
export async function pullKeysFromPool(provider, n, existingKeys = []) {
  const db = await getAdapter();
  const existingSet = new Set(existingKeys);
  const pulled = [];

  db.transaction(() => {
    // Fetch more than needed to account for dedup
    const candidates = db.all(
      `SELECT id, name, key FROM keyPool WHERE provider = ? ORDER BY createdAt ASC LIMIT ?`,
      [provider, Math.max(n * 3, n + 50)]
    );

    for (const row of candidates) {
      if (pulled.length >= n) break;
      if (existingSet.has(row.key)) continue;
      pulled.push({ id: row.id, name: row.name, key: row.key });
      existingSet.add(row.key);
    }

    if (pulled.length > 0) {
      const ids = pulled.map((k) => k.id);
      const placeholders = ids.map(() => "?").join(",");
      db.run(`DELETE FROM keyPool WHERE id IN (${placeholders})`, ids);
    }
  });

  return pulled;
}

// --- Per-provider settings via kv table (with in-memory cache) ---

async function kvGet(cacheKey) {
  const cached = settingsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [KV_SCOPE, cacheKey]);
  const value = row?.value ?? null;
  settingsCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function kvSet(cacheKey, value) {
  settingsCache.delete(cacheKey); // invalidate immediately on write
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [KV_SCOPE, cacheKey, String(value)]
  );
}

export async function getPoolSize(provider) {
  const val = await kvGet(`poolSize_${provider}`);
  return val !== null ? parseInt(val, 10) : DEFAULT_POOL_SIZE;
}

export async function setPoolSize(provider, n) {
  await kvSet(`poolSize_${provider}`, n);
}

export async function getAutoReplace(provider) {
  const val = await kvGet(`autoReplace_${provider}`);
  return val !== "false"; // default true
}

export async function setAutoReplace(provider, enabled) {
  await kvSet(`autoReplace_${provider}`, enabled ? "true" : "false");
}
