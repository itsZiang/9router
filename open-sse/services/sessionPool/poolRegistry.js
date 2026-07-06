/**
 * Pool Registry — Global registry for active session pools.
 *
 * Provides a rendezvous point between executors (which create pools)
 * and MCP tools / API handlers (which query pool state).
 *
 * Usage (executor side):
 *   PoolRegistry.register("pollinations", myPool);
 *
 * Usage (MCP tool / API side):
 *   const stats = PoolRegistry.getStats("pollinations");
 *   const all   = PoolRegistry.getAllStats();
 */

class PoolRegistryImpl {
  pools = new Map();

  /** Register a pool for a provider. Overwrites any previous pool. */
  register(provider, pool) {
    this.pools.set(provider, {
      pool,
      createdAt: Date.now()
    });
  }

  /** Unregister a pool */
  unregister(provider) {
    return this.pools.delete(provider);
  }

  /** Get a pool by provider name */
  getPool(provider) {
    return this.pools.get(provider)?.pool;
  }

  /** List all registered provider names */
  listProviders() {
    return Array.from(this.pools.keys());
  }

  /** Get stats for a specific provider's pool */
  getStats(provider) {
    const entry = this.pools.get(provider);
    if (!entry) return null;
    return {
      ...entry.pool.getStats(),
      createdAt: entry.createdAt
    };
  }

  /** Get stats for all registered pools */
  getAllStats() {
    const result = [];
    for (const [, entry] of this.pools) {
      result.push({
        ...entry.pool.getStats(),
        createdAt: entry.createdAt
      });
    }
    return result;
  }

  /** Get per-session details for a specific provider */
  getSessionDetails(provider) {
    const entry = this.pools.get(provider);
    if (!entry) return null;
    return entry.pool.getSessionDetails();
  }

  /** Reset (shutdown + recreate) a pool */
  resetPool(provider) {
    const entry = this.pools.get(provider);
    if (!entry) return false;
    entry.pool.shutdown();
    this.pools.delete(provider);
    return true;
  }

  /** Warm up a pool to a target session count */
  async warmPool(provider, count) {
    const entry = this.pools.get(provider);
    if (!entry) return false;
    await entry.pool.warmUp(count);
    return true;
  }

  /** Count of registered pools */
  get size() {
    return this.pools.size;
  }
}

/** Singleton global pool registry */
export const PoolRegistry = new PoolRegistryImpl();