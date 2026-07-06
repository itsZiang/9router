/**
 * Session Pool — Barrel exports
 *
 * Usage:
 *   import { SessionPool, Session, FingerprintRotator, SessionFactory, withSessionPool } from "./sessionPool/index";
 *   import type { PoolConfig, PoolStats, PoolSessionDetail } from "./sessionPool/types";
 */

export { Session } from "./session";
export { SessionPool } from "./sessionPool";
export { SessionFactory } from "./sessionFactory";
export { FingerprintRotator } from "./fingerprintRotator";
export { withSessionPool } from "./webExecutorWrapper";
export { PoolRegistry } from "./poolRegistry";
export { DEFAULT_POOL_CONFIG } from "./types";