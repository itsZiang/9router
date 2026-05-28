import { NextResponse } from "next/server";
import {
  pullKeysFromPool, getPoolSize, getProviderConnections, createProviderConnection,
} from "@/models";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/pool/pull
// Body: { count?: number }
export async function POST(req, { params }) {
  try {
    const provider = params.id;
    const body = await req.json().catch(() => ({}));

    // Determine how many keys to pull
    const poolSize = await getPoolSize(provider);
    const n = body.count && Number.isFinite(body.count) && body.count > 0
      ? Math.floor(body.count)
      : poolSize;

    // Get existing active apiKeys to dedup
    const existing = await getProviderConnections({ provider });
    const existingKeys = existing
      .map((c) => c.apiKey)
      .filter(Boolean);

    const pulled = await pullKeysFromPool(provider, n, existingKeys);

    if (pulled.length === 0) {
      return NextResponse.json({ pulled: 0, skipped: 0, message: "Pool is empty or all keys already in use" });
    }

    // Create connections for pulled keys
    const now = new Date().toISOString();
    let created = 0;
    for (const k of pulled) {
      try {
        await createProviderConnection({
          provider,
          authType: "apikey",
          name: k.name || `pool-${now.slice(0, 10)}-${created + 1}`,
          apiKey: k.key,
          isActive: 1,
        });
        created++;
      } catch {
        // skip if duplicate
      }
    }

    return NextResponse.json({ pulled: created, skipped: pulled.length - created });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
