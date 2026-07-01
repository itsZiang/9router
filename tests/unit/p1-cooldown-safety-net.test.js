import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetProviderConnections = vi.fn();
const mockGetSettings = vi.fn();

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...args) => mockGetProviderConnections(...args),
  getSettings: (...args) => mockGetSettings(...args),
  validateApiKey: vi.fn(async () => true),
  updateProviderConnection: vi.fn(async () => {}),
  pullKeysFromPool: vi.fn(async () => []),
  getAutoReplace: vi.fn(async () => false),
  batchCreatePoolConnections: vi.fn(async () => 0),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
    strictProxy: false,
  })),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: (id) => id,
  FREE_PROVIDERS: {},
}));

// Re-export real modules so vitest applies alias resolution for open-sse/ imports.
// Using relative paths because vitest's vi.mock cannot resolve the "open-sse/" alias
// when it appears inside a vi.mock() call.
vi.mock("../../open-sse/services/accountFallback.js", async (importOriginal) => importOriginal());
vi.mock("../../open-sse/config/errorConfig.js", async (importOriginal) => importOriginal());

vi.mock("../utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn((k) => k?.slice(0, 4) + "..."),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

function makeLockedConnection(id, model, lockMs = 60000, extra = {}) {
  return {
    id,
    provider: "test-prov",
    isActive: true,
    apiKey: `key-${id}`,
    displayName: `Account ${id}`,
    testStatus: "unavailable",
    lastError: "Rate limit",
    errorCode: 429,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: 1,
    [`modelLock_${model}`]: new Date(Date.now() + lockMs).toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
});

describe("P1 #6 — Cooldown safety net (allowRateLimited)", () => {
  it("returns allRateLimited when all accounts are model-locked (default behavior)", async () => {
    mockGetProviderConnections.mockResolvedValue([
      makeLockedConnection("conn1", "gpt-4", 60000),
      makeLockedConnection("conn2", "gpt-4", 30000),
    ]);

    const result = await getProviderCredentials("test-prov", null, "gpt-4");

    expect(result.allRateLimited).toBe(true);
    expect(result.retryAfter).toBeTruthy();
  });

  it("returns the account with earliest lock expiry when allowRateLimited=true", async () => {
    mockGetProviderConnections.mockResolvedValue([
      makeLockedConnection("conn1", "gpt-4", 60000),
      makeLockedConnection("conn2", "gpt-4", 10000),
    ]);

    const result = await getProviderCredentials("test-prov", null, "gpt-4", { allowRateLimited: true });

    expect(result.allRateLimited).toBeUndefined();
    expect(result.connectionId).toBe("conn2");
    expect(result.emergencyFallback).toBe(true);
    expect(result.apiKey).toBe("key-conn2");
  });

  it("returns allRateLimited when all accounts are excluded (no non-excluded to fall back to)", async () => {
    mockGetProviderConnections.mockResolvedValue([
      makeLockedConnection("conn1", "gpt-4", 60000),
      makeLockedConnection("conn2", "gpt-4", 10000),
    ]);

    const excludeAll = new Set(["conn1", "conn2"]);
    const result = await getProviderCredentials("test-prov", excludeAll, "gpt-4", { allowRateLimited: true });

    // Emergency fallback can't find non-excluded locked accounts → falls through
    // to normal allRateLimited response (which reports earliest lock expiry)
    expect(result.allRateLimited).toBe(true);
    expect(result.retryAfter).toBeTruthy();
  });

  it("picks only non-excluded locked accounts for emergency fallback", async () => {
    mockGetProviderConnections.mockResolvedValue([
      makeLockedConnection("conn1", "gpt-4", 5000),
      makeLockedConnection("conn2", "gpt-4", 30000),
      makeLockedConnection("conn3", "gpt-4", 60000),
    ]);

    const excludeConn1 = new Set(["conn1"]);
    const result = await getProviderCredentials("test-prov", excludeConn1, "gpt-4", { allowRateLimited: true });

    expect(result.allRateLimited).toBeUndefined();
    expect(result.connectionId).toBe("conn2");
    expect(result.emergencyFallback).toBe(true);
  });

  it("returns normal credential when accounts are available (no lock active)", async () => {
    mockGetProviderConnections.mockResolvedValue([{
      id: "conn1",
      provider: "test-prov",
      isActive: true,
      apiKey: "key-conn1",
      displayName: "Account 1",
      testStatus: "active",
      lastError: null,
    }]);

    const result = await getProviderCredentials("test-prov", null, "gpt-4", { allowRateLimited: true });

    expect(result.allRateLimited).toBeUndefined();
    expect(result.emergencyFallback).toBeUndefined();
    expect(result.connectionId).toBe("conn1");
  });
});
