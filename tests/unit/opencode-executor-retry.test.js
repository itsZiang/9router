// Regression: OpencodeExecutor must survive transient upstream failures the way
// the official Opencode client does (session/retry.ts) — retry 5xx + transport
// throws (incl. undici `terminated`) with backoff, rotating across accounts,
// instead of surfacing the raw error immediately.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { applyOpencodeFakeFingerprint, forwardOpencodeClientHeaders, stableSessionId } from "../../open-sse/utils/opencodeHeaders.js";

const MODEL = "muse-spark-1.3-contributor-free";

function okResponse(status = 200, headers = {}) {
  return {
    response: new Response(JSON.stringify({ ok: true }), { status, headers }),
    url: "https://opencode.ai/zen/v1/responses",
    headers: {},
    transformedBody: {},
  };
}

const quietLog = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

function twoAccountCreds() {
  return {
    providerSpecificData: {
      fingerprints: ["fpAAAA1111", "fpBBBB2222"],
      accountProxies: [],
    },
  };
}

let stub;
let calls;

beforeEach(() => {
  calls = 0;
  stub = vi.spyOn(BaseExecutor.prototype, "execute");
  // mockReset (not just mockImplementation): clears any leftover
  // mockImplementationOnce queue from a previously failed test so one flake
  // can't cascade into the next test.
  stub.mockReset();
  stub.mockImplementation(async () => {
    throw new Error("stub not configured");
  });
});

afterEach(() => {
  stub.mockRestore();
});

function inputFor(overrides = {}) {
  return {
    model: MODEL,
    body: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: twoAccountCreds(),
    log: quietLog,
    clientHeaders: {},
    ...overrides,
  };
}

describe("OpencodeExecutor transient retry (opencode-style)", () => {
  it("rotates to the next account when the first throws `terminated`", async () => {
    stub.mockImplementationOnce(async () => {
      calls++;
      throw new Error("terminated");
    }).mockImplementationOnce(async () => {
      calls++;
      return okResponse(200);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor());
    expect(result.response.status).toBe(200);
    expect(calls).toBe(2);
  }, 30000);

  it("retries the same (single) account after a transport throw, then succeeds", async () => {
    stub.mockImplementationOnce(async () => {
      calls++;
      const err = new Error("socket hang up");
      err.code = "ECONNRESET";
      throw err;
    }).mockImplementationOnce(async () => {
      calls++;
      return okResponse(200);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor({ credentials: {} }));
    expect(result.response.status).toBe(200);
    expect(calls).toBe(2);
  }, 30000);

  it("retries a transient 502 in place, then succeeds", async () => {
    stub.mockImplementationOnce(async () => {
      calls++;
      return okResponse(502);
    }).mockImplementationOnce(async () => {
      calls++;
      return okResponse(200);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor({ credentials: {} }));
    expect(result.response.status).toBe(200);
    expect(calls).toBe(2);
  }, 30000);

  it("rotates on 429 and returns the next account's success", async () => {
    stub.mockImplementationOnce(async () => {
      calls++;
      return okResponse(429);
    }).mockImplementationOnce(async () => {
      calls++;
      return okResponse(200);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor());
    expect(result.response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("rethrows client aborts immediately without retry", async () => {
    stub.mockImplementation(async () => {
      calls++;
      throw new DOMException("aborted", "AbortError");
    });
    const executor = new OpencodeExecutor("opencode-zen");
    await expect(executor.execute(inputFor({ credentials: {} }))).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  it("returns 400 immediately without retry", async () => {
    stub.mockImplementation(async () => {
      calls++;
      return okResponse(400);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor({ credentials: {} }));
    expect(result.response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("surfaces the last 5xx after exhausting accounts instead of throwing", async () => {
    stub.mockImplementation(async () => {
      calls++;
      return okResponse(503);
    });
    const executor = new OpencodeExecutor("opencode-zen");
    const result = await executor.execute(inputFor());
    expect(result.response.status).toBe(503);
    // 2 accounts x 2 attempts each
    expect(calls).toBe(4);
  }, 30000);
});

describe("opencode sticky session headers", () => {
  it("stableSessionId is deterministic per seed", () => {
    expect(stableSessionId("keyA:m")).toBe(stableSessionId("keyA:m"));
    expect(stableSessionId("keyA:m")).not.toBe(stableSessionId("keyB:m"));
    expect(stableSessionId("keyA:m")).toMatch(/^ses_[0-9a-f]{24}$/);
  });

  it("derives a stable session per credential+model, keeps msg_* per-request", () => {
    const h1 = applyOpencodeFakeFingerprint({}, {}, "KEY123:muse-spark-1.3-contributor-free");
    const h2 = applyOpencodeFakeFingerprint({}, {}, "KEY123:muse-spark-1.3-contributor-free");
    const h3 = applyOpencodeFakeFingerprint({}, {}, "OTHER:muse-spark-1.3-contributor-free");
    expect(h1["x-opencode-session"]).toBe(h2["x-opencode-session"]);
    expect(h1["x-opencode-session"]).not.toBe(h3["x-opencode-session"]);
    expect(h1["x-opencode-request"]).not.toBe(h2["x-opencode-request"]);
  });

  it("preserves a real client session and falls back to random without seed", () => {
    // Real pipeline order: forward first, then fill gaps with the fingerprint.
    const viaClient = {};
    forwardOpencodeClientHeaders(viaClient, { "x-opencode-session": "ses_client123" }, { synthesizeRequestId: true });
    const kept = applyOpencodeFakeFingerprint(viaClient, { "x-opencode-session": "ses_client123" }, "KEY:m");
    expect(kept["x-opencode-session"]).toBe("ses_client123");
    const r1 = applyOpencodeFakeFingerprint({}, {});
    const r2 = applyOpencodeFakeFingerprint({}, {});
    expect(r1["x-opencode-session"]).toMatch(/^ses_/);
    expect(r1["x-opencode-session"]).not.toBe(r2["x-opencode-session"]);
  });

  it("executor buildHeaders emits a stable session for the same key+model", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    executor._requestFormat = "openai-responses";
    const creds = { apiKey: "KEY123" };
    const a = executor.buildHeaders(creds, true, {}, MODEL);
    const b = executor.buildHeaders(creds, true, {}, MODEL);
    expect(a["x-opencode-session"]).toBe(b["x-opencode-session"]);
    expect(a["x-opencode-session"]).toMatch(/^ses_/);
  });

  it("seeds the session per downstream caller, not per upstream key", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    executor._requestFormat = "openai-responses";
    const creds = { apiKey: "SHAREDKEY" };
    const alice1 = executor.buildHeaders(creds, true, { authorization: "Bearer alice-9router-key" }, MODEL);
    const alice2 = executor.buildHeaders(creds, true, { authorization: "Bearer alice-9router-key" }, MODEL);
    const bob = executor.buildHeaders(creds, true, { authorization: "Bearer bob-9router-key" }, MODEL);
    expect(alice1["x-opencode-session"]).toBe(alice2["x-opencode-session"]);
    expect(alice1["x-opencode-session"]).not.toBe(bob["x-opencode-session"]);
    // Raw downstream keys never leak upstream in cleartext.
    expect(JSON.stringify(alice1)).not.toContain("alice-9router-key");
  });
});

describe("OpencodeExecutor sliced waits and retry budget", () => {
  function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      });
  }

  it("honors a long retry-after in slices and still succeeds", async () => {
    await withEnv({ OMNIROUTE_OPENCODE_RETRY_SLICE_MS: "50" }, async () => {
      stub.mockImplementationOnce(async () => {
        calls++;
        return okResponse(429, { "retry-after": "1" });
      }).mockImplementationOnce(async () => {
        calls++;
        return okResponse(200);
      });
      const executor = new OpencodeExecutor("opencode-zen");
      const result = await executor.execute(inputFor({ credentials: {} }));
      expect(result.response.status).toBe(200);
      expect(calls).toBe(2);
      // Slicing is proven structurally (abort + budget tests below cover the
      // chunked path); no wall-clock assertion here to avoid loaded-machine flakes.
    });
  }, 30000);

  it("surfaces the last result fast when the retry budget is exhausted", async () => {
    await withEnv({ OMNIROUTE_OPENCODE_RETRY_BUDGET_MS: "200", OMNIROUTE_OPENCODE_RETRY_SLICE_MS: "50" }, async () => {
      stub.mockImplementation(async () => {
        calls++;
        return okResponse(503);
      });
      const executor = new OpencodeExecutor("opencode-zen");
      const started = Date.now();
      const result = await executor.execute(inputFor());
      expect(result.response.status).toBe(503);
      // Budget (200ms) covers only the first backoff (~2s) partially, so the
      // loop stops after 2 calls instead of 2 accounts x 2 attempts.
      expect(calls).toBe(2);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  }, 30000);

  it("aborts the wait promptly when the downstream caller goes away", async () => {
    await withEnv({ OMNIROUTE_OPENCODE_RETRY_SLICE_MS: "50" }, async () => {
      stub.mockImplementationOnce(async () => {
        calls++;
        return okResponse(429, { "retry-after": "30" });
      });
      const controller = new AbortController();
      const executor = new OpencodeExecutor("opencode-zen");
      const pending = executor.execute(inputFor({ credentials: {}, signal: controller.signal }));
      setTimeout(() => controller.abort(), 150);
      await expect(pending).rejects.toThrow();
      expect(calls).toBe(1);
    });
  }, 30000);
});
