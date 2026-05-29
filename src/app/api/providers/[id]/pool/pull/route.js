import { NextResponse } from "next/server";
import {
  pullKeysFromPool, getPoolSize, getProviderConnections, batchCreatePoolConnections,
  getProviderNodeById, updateProviderConnection,
} from "@/models";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/pool/pull
export async function POST(req, { params }) {
  try {
    const { id: provider } = await params;
    const body = await req.json().catch(() => ({}));

    const [poolSize, existing] = await Promise.all([
      getPoolSize(provider),
      getProviderConnections({ provider }),
    ]);

    const n = body.count && Number.isFinite(body.count) && body.count > 0
      ? Math.floor(body.count)
      : poolSize;

    const existingKeys = existing.map((c) => c.apiKey).filter(Boolean);

    const pulled = await pullKeysFromPool(provider, n, existingKeys);

    if (pulled.length === 0) {
      return NextResponse.json({ pulled: 0, skipped: 0, message: "Pool is empty or all keys already in use" });
    }

    // Inherit providerSpecificData so custom providers (openai-compatible-*, anthropic-compatible-*)
    // carry their baseUrl to pool connections — otherwise requests fall back to api.openai.com / api.anthropic.com.
    // Prefer existing connection's PSD; fall back to node config when no connections exist yet.
    let inheritPsd = existing.find((c) => c.providerSpecificData?.baseUrl)?.providerSpecificData || null;
    if (!inheritPsd) {
      const node = await getProviderNodeById(provider);
      if (node) {
        inheritPsd = { baseUrl: node.baseUrl, prefix: node.prefix, apiType: node.apiType, nodeName: node.name };
      }
    }

    // Repair existing connections that are missing providerSpecificData (pulled before this fix)
    if (inheritPsd) {
      const broken = existing.filter((c) => !c.providerSpecificData?.baseUrl);
      await Promise.all(broken.map((c) => updateProviderConnection(c.id, { providerSpecificData: inheritPsd })));
    }

    const created = await batchCreatePoolConnections(provider, pulled, existingKeys, inheritPsd);

    return NextResponse.json({ pulled: created, skipped: pulled.length - created });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
