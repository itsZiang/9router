import { getExposeCombos } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const LLM_KIND = "llm";

// Combo matches when its kind is llm or missing (default)
function comboIsLlm(combo) {
  const kind = combo?.kind || LLM_KIND;
  return kind === LLM_KIND;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v2/models - OpenAI compatible models list for exposed combos only.
 * Returns only combos stored in exposeCombos table (Expose models panel).
 * Scope: full keys get 403, expose_only and local (no key) can access.
 */
export async function GET(request) {
  try {
    // Scope enforcement: full keys cannot access /v2
    if (request) {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        let apiKey = null;
        if (authHeader.startsWith("Bearer ")) apiKey = authHeader.slice(7);
        if (!apiKey) {
          const xKey = request.headers.get("x-api-key");
          if (xKey) apiKey = xKey;
        }
        if (apiKey) {
          const { getApiKeyRecord } = await import("@/lib/localDb");
          const record = await getApiKeyRecord(apiKey).catch(() => null);
          if (record && record.scope === "full") {
            return Response.json({ error: { message: "This API key (full) cannot access /v2/models. Use an expose_only key.", type: "permission_error" } }, { status: 403, headers: { "Access-Control-Allow-Origin": "*" } });
          }
        }
      } catch {}
    }
    let combos = [];
    try {
      combos = await getExposeCombos();
    } catch (e) {
      console.log("Could not fetch expose combos", e);
    }

    const data = [];
    for (const combo of combos) {
      if (!comboIsLlm(combo)) continue;
      const entry = {
        id: combo.name,
        object: "model",
        owned_by: "combo",
      };
      // Preserve web kind if ever used (future compat)
      if (combo.kind === "webSearch" || combo.kind === "webFetch") {
        entry.kind = combo.kind;
      }
      data.push(entry);
    }

    // Dedupe by id
    const deduped = [];
    const seen = new Set();
    for (const m of data) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      deduped.push(m);
    }

    return Response.json({ object: "list", data: deduped }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching v2 models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
