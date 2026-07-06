import { getExecutor } from "../../../executors/index";
/**
 * Production ModelClient adapter (Hard Rule #18 — NOT unit-tested; validated on a real
 * VPS/account). Wraps the server executor: builds a minimal non-stream chat body, calls
 * `getExecutor(provider).execute(...)`, reads the response text + (best-effort) usage cost.
 *
 * The pure runner depends only on the `ModelClient` interface; this adapter is the single
 * place that touches credentials, the executor, and Response parsing — so the eval stays
 * faithful to production while the runner/scorers remain fully testable with a stub.
 */
export function createExecutorModelClient(provider, credentials, costPerKTokenOut) {
  const executor = getExecutor(provider);
  return {
    async complete(model, messages) {
      const body = {
        model,
        messages,
        stream: false
      };
      const input = {
        model,
        body,
        stream: false,
        credentials
      };
      // BaseExecutor.execute resolves to { response, url, headers, transformedBody } — the
      // upstream Response lives on `.response` (never a bare Response). Validated live on VPS.
      const raw = await executor.execute(input);
      const response = raw.response;
      const json = await response.json();
      const text = json.choices?.[0]?.message?.content ?? "";
      const outTokens = json.usage?.completion_tokens ?? 0;
      const usdCost = typeof costPerKTokenOut === "number" ? outTokens / 1000 * costPerKTokenOut : undefined;
      return usdCost === undefined ? {
        text
      } : {
        text,
        usdCost
      };
    }
  };
}